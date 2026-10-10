'use strict';
/**
 * 《新月再梦听羽生》哥伦比娅生日会 —— 报名投稿后端（前后端分离，纯 Node + MySQL）。
 *
 * 只提供 JSON API，静态页面由 nginx 直接托管；线上 nginx 用 `location ^~ /api/`
 * 反代到本进程（默认 127.0.0.1:8788）。
 *
 * 主要接口：
 *   GET    /api/health
 *   POST   /api/uploads                      新建分片上传会话
 *   GET    /api/uploads/:id                  查询已收到的分片（断点续传用）
 *   PUT    /api/uploads/:id/chunk/:index     上传单个分片（application/octet-stream）
 *   POST   /api/uploads/:id/complete         合并分片
 *   POST   /api/submissions                  提交投稿
 *   GET    /api/submissions/:id              查询投稿回执
 *   POST   /api/submissions/lookup           按编号读回投稿（修改前回显用）
 *   PUT    /api/submissions/:id              按编号覆盖更新（编号不变）
 *   GET    /api/admin/submissions            管理端列表（需 ?tk=<adminSecret>）
 *   GET    /api/admin/submissions/:id        管理端详情
 *   GET    /api/admin/files/:id              下载附件
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./lib/db');
const up = require('./lib/upload');
const auth = require('./lib/auth');
const { validateSubmission } = require('./lib/validate');
const qq = require('./lib/qq');

const cfg = db.loadConfig();
/* 内置超级管理员：不可删除（用户名取自 config.initAdmin，默认 admin） */
const PROTECTED_ADMIN = String((cfg.initAdmin && cfg.initAdmin.username) || 'admin');
const ROOT = __dirname;
const DATA_DIR = path.isAbsolute(cfg.dataDir || 'data')
  ? cfg.dataDir
  : path.join(ROOT, cfg.dataDir || 'data');

const PORT = Number(process.env.PORT || cfg.port || 8788);
const HOST = cfg.host || '127.0.0.1';
const MB = 1024 * 1024;
const MAX_FILE_BYTES = Number(cfg.maxFileMB || 2048) * MB;
const DEFAULT_CHUNK = Number(cfg.defaultChunkMB || 4) * MB;
const MAX_CHUNK = Number(cfg.maxChunkMB || 16) * MB;
const MIN_CHUNK = Number(cfg.minChunkKB || 256) * 1024;
const PUBLIC_BASE = (cfg.publicBaseUrl || '').replace(/\/+$/, '');

/* ---- QQ 访客登录 ---- */
/* 密钥来自 <dataDir>/qq.json 或环境变量（见 lib/qq.js）；没配置时接口返回 503，站点其余部分照常可用 */
let QQ_CFG = { appId: '', appKey: '', redirectUri: '' };
const MEMBER_COOKIE = 'cb_user';
const MEMBER_TTL_HOURS = Math.max(1, Number(cfg.userSessionTTLHours || 168));
/* 防 CSRF 的 state 表：进程内存足够，10 分钟过期；重启后旧 state 失效，用户重来一次即可 */
const QQ_STATES = new Map();
const QQ_STATE_TTL_MS = 10 * 60 * 1000;

/* ---- 小游戏计分规则（服务端权威，前端只上报原始事实） ----
   best 型：云隙轻歌 / 无尽巡游 —— 取历史最高，不累加
   sum  型：月亮棋 / 星月五子棋 —— 胜 3 分、负 1 分、平 0 分，再乘难度倍数后累加
   提瓦特战力党 / 娅娅猫向前冲：不计分（不放进这张表即可） */
const GAME_RULES = {
  flight: { kind: 'best', label: '云隙轻歌' },
  runner: { kind: 'best', label: '无尽巡游' },
  tictactoe: { kind: 'sum', label: '月亮棋' },
  gomoku: { kind: 'sum', label: '星月五子棋' },
};
const DIFFICULTY_MULT = { easy: 1, medium: 2, hard: 3 };
const BOARD_POINTS = { wins: 3, losses: 1, draws: 0 };
const MAX_RAW_SCORE = 100000;
/* 同一用户同一游戏 5 秒内重复上报视为重复提交（累加型尤其怕这个） */
const SCORE_DEDUPE_MS = 5 * 1000;
const gameScoreAt = new Map();

/* ------------------------------------------------------------ 小工具 */

function json(res, code, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function applyCors(req, res) {
  const origin = req.headers.origin || '';
  const allow = Array.isArray(cfg.corsOrigins) ? cfg.corsOrigins : [];
  if (origin && allow.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}

function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.socket.remoteAddress || '';
}

function readJsonBody(req, limit = 2 * MB) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (d) => {
      size += d.length;
      if (size > limit) {
        const e = new Error('body too large');
        e.code = 413;
        reject(e);
        req.destroy();
        return;
      }
      parts.push(d);
    });
    req.on('end', () => {
      const raw = Buffer.concat(parts).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { const err = new Error('invalid json'); err.code = 400; reject(err); }
    });
    req.on('error', reject);
  });
}

function readAdminSecret() {
  try { return db.readAdminSecret(cfg); } catch (e) { return ''; }
}

/* 口令可查看副本用的服务器密钥（首次运行自动生成，600）。丢了只影响查看，不影响登录。 */
let SECRET_KEY = null;
function keyFilePath() {
  const f = cfg.secretKeyFile || 'data/secret.key';
  return path.isAbsolute(f) ? f : path.join(ROOT, f);
}

/**
 * 管理端鉴权：
 * - 配置里的总秘钥（adminSecretFile）→ 视为 super，供运维/脚本使用
 * - 登录后拿到的会话串（请求头 X-Admin-Key，或 ?tk= 兼容写法）→ 按库里的角色
 * 返回 { ok, role, username, viaMaster, tk }
 */
async function resolveAuth(req, url) {
  const got = String(url.searchParams.get('tk') || req.headers['x-admin-key'] || '');
  if (!got) return { ok: false };

  const master = readAdminSecret();
  if (master && auth.sameSecret(got, master)) {
    return { ok: true, role: 'super', username: 'master', viaMaster: true };
  }

  const sess = await db.getSession(got);
  if (!sess) return { ok: false };
  const u = await db.getAdminUserById(sess.user_id);
  if (!u) { await db.deleteSession(got); return { ok: false }; }
  return { ok: true, role: u.role, username: u.username, userId: u.id, viaMaster: false, tk: got };
}

/* MySQL 的 JSON 列经 mysql2 回来已经是对象，兼容字符串与 null 两种情况 */
function asArray(v) {
  if (v === null || v === undefined) return []
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v)
      return Array.isArray(parsed) ? parsed : []
    } catch (e) { return [] }
  }
  return Array.isArray(v) ? v : []
}

function maskContact(type, value) {
  const v = String(value || '');
  if (type === 'email' && v.includes('@')) {
    const [a, b] = v.split('@');
    return `${a.slice(0, 2)}***@${b}`;
  }
  if (v.length <= 4) return v[0] + '***';
  return `${v.slice(0, 2)}***${v.slice(-2)}`;
}

/* ------------------------------------------------------------ 业务 */

async function handleUploadsCreate(req, res) {
  const body = await readJsonBody(req);
  const originalName = String(body.fileName || '').trim().slice(0, 200);
  const size = Number(body.size || 0);
  const mime = String(body.mime || '').slice(0, 150) || null;
  if (!originalName) return json(res, 400, { ok: false, error: '缺少文件名' });
  if (!Number.isFinite(size) || size <= 0) return json(res, 400, { ok: false, error: '文件大小不合法' });
  if (size > MAX_FILE_BYTES) {
    return json(res, 413, { ok: false, error: `单个文件不能超过 ${Math.round(MAX_FILE_BYTES / MB)} MB` });
  }
  let chunkSize = Number(body.chunkSize || 0) || DEFAULT_CHUNK;
  chunkSize = Math.min(Math.max(chunkSize, MIN_CHUNK), MAX_CHUNK);

  const id = up.newId();
  const chunksTotal = Math.max(1, Math.ceil(size / chunkSize));
  if (chunksTotal > 20000) return json(res, 413, { ok: false, error: '分片数量过多' });

  await db.createUpload({ id, originalName, size, mime, chunkSize, chunksTotal });
  up.initDirs(DATA_DIR);
  return json(res, 201, {
    ok: true, uploadId: id, chunkSize, chunksTotal, received: [], fileName: originalName, size,
  });
}

async function handleUploadStatus(req, res, id) {
  const row = await db.getUpload(id);
  if (!row) return json(res, 404, { ok: false, error: '上传会话不存在或已过期', expired: true });
  const received = up.receivedChunks(DATA_DIR, id);
  const uploaded = received.reduce((sum, i) => {
    if (i < row.chunks_total - 1) return sum + row.chunk_size;
    return sum + (row.size - row.chunk_size * (row.chunks_total - 1));
  }, 0);
  return json(res, 200, {
    ok: true,
    uploadId: id,
    fileName: row.original_name,
    size: Number(row.size),
    chunkSize: row.chunk_size,
    chunksTotal: row.chunks_total,
    received,
    uploadedBytes: Math.max(0, Math.min(uploaded, Number(row.size))),
    state: row.state,
  });
}

async function handleUploadChunk(req, res, id, index) {
  const row = await db.getUpload(id);
  if (!row) return json(res, 404, { ok: false, error: '上传会话不存在或已过期', expired: true });
  if (row.state !== 'open') return json(res, 409, { ok: false, error: '该上传已完成' });
  if (!Number.isInteger(index) || index < 0 || index >= row.chunks_total) {
    return json(res, 400, { ok: false, error: '分片序号越界' });
  }
  try {
    await up.writeChunk(DATA_DIR, id, index, req, row.chunk_size + 1024);
  } catch (e) {
    if (e && e.code === 413) return json(res, 413, { ok: false, error: '分片过大' });
    return json(res, 500, { ok: false, error: '分片写入失败' });
  }
  await db.touchUpload(id);
  const received = up.receivedChunks(DATA_DIR, id);
  return json(res, 200, { ok: true, index, receivedCount: received.length, chunksTotal: row.chunks_total });
}

async function handleUploadComplete(req, res, id) {
  const row = await db.getUpload(id);
  if (!row) return json(res, 404, { ok: false, error: '上传会话不存在或已过期', expired: true });
  /* 已经合并过的会话直接回执（重复点完成 / 网络重试） */
  if (row.state === 'done') {
    const f = await db.getFile(id);
    if (f) return json(res, 200, { ok: true, fileId: id, fileName: f.original_name, size: Number(f.size) });
  }
  const received = up.receivedChunks(DATA_DIR, id);
  const missing = [];
  for (let i = 0; i < row.chunks_total; i++) if (!received.includes(i)) missing.push(i);
  if (missing.length) {
    return json(res, 409, { ok: false, error: '分片不完整', missing, received });
  }
  let merged;
  try {
    merged = await up.mergeChunks(DATA_DIR, id, row.chunks_total, row.original_name);
  } catch (e) {
    return json(res, 500, { ok: false, error: '分片合并失败' });
  }
  await db.insertFile({
    id,
    originalName: row.original_name,
    storedPath: merged.stored,
    size: merged.size,
    mime: row.mime,
  });
  await db.touchUpload(id, 'done');
  return json(res, 200, { ok: true, fileId: id, fileName: row.original_name, size: merged.size });
}

async function handleSubmit(req, res) {
  const body = await readJsonBody(req, 4 * MB);
  const { ok, errors, value } = validateSubmission(body);
  if (!ok) return json(res, 400, { ok: false, error: '表单校验未通过', errors });

  const ip = clientIp(req);
  const perHour = Number(cfg.submitPerHour || 0);
  if (perHour > 0) {
    const since = new Date(Date.now() - 3600 * 1000);
    const recent = await db.countRecentSubmissions(ip, since);
    if (recent >= perHour) {
      return json(res, 429, { ok: false, error: '提交过于频繁，请稍后再试' });
    }
  }

  /* 附件必须都是已完成的上传，且未被其它投稿占用 */
  const files = [];
  for (const fid of value.fileIds) {
    const f = await db.getFile(fid);
    if (!f || f.submission_id) {
      return json(res, 400, { ok: false, errors: { fileIds: '附件不存在或已被使用，请重新上传' } });
    }
    files.push(f);
  }

  const id = up.newId();
  /* 已登录投稿：顺手记下 QQ 身份，后台可对账（未登录仍允许提交，保持老路径不变） */
  const me = await resolveUser(req);
  await db.insertSubmission({
    id,
    qq_openid: me ? me.user.openid : null,
    qq_nickname: me ? me.user.nickname : null,
    contact_type: value.contactType,
    contact_value: value.contactValue,
    nicknames: value.nicknames,
    creation_type: value.creationType,
    team_members: value.teamMembers.length ? JSON.stringify(value.teamMembers) : null,
    title: value.title,
    category: value.category,
    intro: value.intro,
    duration: value.duration,
    has_other_chars: value.hasOtherCharacters ? 1 : 0,
    other_chars: value.otherCharacters.length ? JSON.stringify(value.otherCharacters) : null,
    progress: value.progress,
    preview_type: value.previewType,
    preview_link: value.previewLink,
    agreed: 1,
    ip,
    ua: String(req.headers['user-agent'] || '').slice(0, 480),
    created_at: db.now(),
  });
  await db.attachFiles(id, value.fileIds);

  return json(res, 201, {
    ok: true,
    id,
    title: value.title,
    createdAt: new Date().toISOString(),
    maskedContact: maskContact(value.contactType, value.contactValue),
    files: files.map((f) => ({ id: f.id, name: f.original_name, size: Number(f.size) })),
  });
}

async function handleSubmissionReceipt(req, res, id) {
  const row = await db.getSubmission(id);
  if (!row) return json(res, 404, { ok: false, error: '投稿不存在' });
  const files = await db.filesOf(id);
  return json(res, 200, {
    ok: true,
    id: row.id,
    title: row.title,
    category: row.category,
    createdAt: row.created_at,
    files: files.map((f) => ({ name: f.original_name, size: Number(f.size) })),
  });
}

/* ---------------- 按编号读回 / 覆盖修改 ---------------- */

/* 编号就是唯一的凭据，所以「读回」和「修改」都要限流，防着脚本撞编号 */
const LOOKUP_WINDOW = 15 * 60 * 1000;
const LOOKUP_MAX = 30;

function editThrottled(req, res, tag) {
  const key = `${tag}|${clientIp(req)}`;
  if (auth.tooManyAttempts(key, LOOKUP_MAX, LOOKUP_WINDOW)) {
    json(res, 429, { ok: false, error: '操作过于频繁，请稍后再试' });
    return true;
  }
  auth.noteFailure(key, LOOKUP_WINDOW);
  return false;
}

/** 按编号把投稿读回来（回显用）：字段原样返回，附件带上 id 供保留/删除 */
async function handleSubmissionLookup(req, res) {
  if (editThrottled(req, res, 'lookup')) return;
  const body = await readJsonBody(req);
  const id = String(body.id || '').trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(id)) {
    return json(res, 400, { ok: false, error: '编号格式不正确，应该是一串 32 位的字母数字编号' });
  }
  const row = await db.getSubmission(id);
  if (!row) return json(res, 404, { ok: false, error: '没有找到这个编号对应的投稿，请核对后重试' });
  const files = await db.filesOf(id);
  return json(res, 200, {
    ok: true,
    item: { ...rowToJson(row, true), updatedAt: row.updated_at, files: files.map(fileToJson) },
  });
}

/** 覆盖更新：编号不变，内容整份换成新的；没保留的旧附件连磁盘文件一起删掉 */
async function handleSubmissionUpdate(req, res, id) {
  if (editThrottled(req, res, 'update')) return;
  const body = await readJsonBody(req, 4 * MB);
  const row = await db.getSubmission(id);
  if (!row) return json(res, 404, { ok: false, error: '投稿不存在，编号可能有误' });

  /* 原有附件：只有确实属于这份投稿的才允许保留 */
  const mine = await db.filesOf(id);
  const mineIds = new Set(mine.map((f) => f.id));
  const keep = (Array.isArray(body.keepFileIds) ? body.keepFileIds : [])
    .map((x) => String(x))
    .filter((x) => mineIds.has(x));

  /* 校验规则与首次提交完全一致：把「保留的旧附件 + 本次新上传」合成一份再校验 */
  const merged = { ...body, fileIds: [...keep, ...(Array.isArray(body.fileIds) ? body.fileIds : [])] };
  const { ok, errors, value } = validateSubmission(merged);
  if (!ok) return json(res, 400, { ok: false, error: '表单校验未通过', errors });

  const newIds = value.fileIds.filter((f) => !keep.includes(f));
  const added = [];
  for (const fid of newIds) {
    const f = await db.getFile(fid);
    if (!f || f.submission_id) {
      return json(res, 400, { ok: false, errors: { fileIds: '附件不存在或已被使用，请重新上传' } });
    }
    added.push(f);
  }

  await db.updateSubmission(id, {
    contact_type: value.contactType,
    contact_value: value.contactValue,
    nicknames: value.nicknames,
    creation_type: value.creationType,
    team_members: value.teamMembers.length ? JSON.stringify(value.teamMembers) : null,
    title: value.title,
    category: value.category,
    intro: value.intro,
    duration: value.duration,
    has_other_chars: value.hasOtherCharacters ? 1 : 0,
    other_chars: value.otherCharacters.length ? JSON.stringify(value.otherCharacters) : null,
    progress: value.progress,
    preview_type: value.previewType,
    preview_link: value.previewLink,
    agreed: 1,
    updated_at: db.now(),
  });

  const kept = mine.filter((f) => keep.includes(f.id));
  const dropped = mine.filter((f) => !keep.includes(f.id));
  for (const f of dropped) {
    await db.deleteFileRecord(f.id);
    if (f.stored_path) await fs.promises.rm(f.stored_path, { force: true }).catch(() => {});
  }
  await db.attachFiles(id, newIds);

  return json(res, 200, {
    ok: true,
    updated: true,
    id,
    title: value.title,
    category: value.category,
    createdAt: row.created_at,
    updatedAt: db.now(),
    maskedContact: maskContact(value.contactType, value.contactValue),
    files: [...kept, ...added].map((f) => ({ id: f.id, name: f.original_name, size: Number(f.size) })),
  });
}

function rowToJson(row, withContact) {
  const out = {
    id: row.id,
    title: row.title,
    category: row.category,
    duration: row.duration,
    intro: row.intro,
    progress: row.progress,
    creationType: row.creation_type,
    teamMembers: asArray(row.team_members),
    nicknames: row.nicknames,
    hasOtherCharacters: !!row.has_other_chars,
    otherCharacters: asArray(row.other_chars),
    previewType: row.preview_type,
    previewLink: row.preview_link,
    agreed: !!row.agreed,
    favorite: !!row.favorite,
    favoritedAt: row.favorited_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at || null,
    qqNickname: row.qq_nickname || null,
  };
  if (withContact) {
    out.contactType = row.contact_type;
    out.contactValue = row.contact_value;
  } else {
    out.contact = `${row.contact_type} / ${maskContact(row.contact_type, row.contact_value)}`;
  }
  return out;
}

function fileToJson(f) {
  return { id: f.id, name: f.original_name, size: Number(f.size), mime: f.mime, createdAt: f.created_at };
}

/* ---------------- 登录 ---------------- */

async function handleLogin(req, res) {
  const body = await readJsonBody(req);
  const username = String(body.username || '').trim();
  const secret = String(body.secret || '');
  const ip = clientIp(req);
  const throttleKey = `${ip}|${username.toLowerCase()}`;

  if (auth.tooManyAttempts(throttleKey, 8, 15 * 60 * 1000)) {
    return json(res, 429, { ok: false, error: '尝试次数过多，请 15 分钟后再试' });
  }
  if (!username || !secret) {
    return json(res, 400, { ok: false, error: '请填写账号与口令' });
  }

  const user = await db.getAdminUserByName(username);
  if (!user || !auth.verifySecret(secret, user.salt, user.hash)) {
    auth.noteFailure(throttleKey, 15 * 60 * 1000);
    return json(res, 401, { ok: false, error: '账号或口令不正确' });
  }

  auth.clearFailures(throttleKey);
  const tk = auth.newId(32);
  const ttl = auth.sessionTtlMs(cfg);
  await db.createSession({ tk, userId: user.id, role: user.role, expiresAt: new Date(Date.now() + ttl) });
  /* 单点登录：同一账号新登录就把其它设备上的会话踢掉，只留这一条 */
  await db.revokeUserSessions(user.id, tk);
  await db.touchAdminLogin(user.id);
  return json(res, 200, {
    ok: true, tk, role: user.role, username: user.username, expiresAt: new Date(Date.now() + ttl).toISOString(),
  });
}

async function handleLogout(req, res, me) {
  if (me.tk) await db.deleteSession(me.tk);
  return json(res, 200, { ok: true });
}

async function handleMe(req, res, me) {
  return json(res, 200, { ok: true, id: me.userId || '', username: me.username, role: me.role, viaMaster: !!me.viaMaster });
}

/* ---------------- 访客 QQ 登录 ---------------- */

function parseCookies(req) {
  const out = {};
  const raw = String(req.headers.cookie || '');
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

function isLocalHost(req) {
  const h = String(req.headers.host || '');
  return h.startsWith('127.0.0.1') || h.startsWith('localhost') || h.startsWith('[::1]');
}

/** 会话 cookie：HttpOnly 防脚本读取，SameSite=Lax 防跨站携带；线上（非本机）一律 Secure */
function memberCookieHeader(req, tk, maxAgeSec) {
  const parts = [`${MEMBER_COOKIE}=${encodeURIComponent(tk)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (!isLocalHost(req)) parts.push('Secure');
  parts.push(maxAgeSec > 0 ? `Max-Age=${maxAgeSec}` : 'Max-Age=0');
  return parts.join('; ');
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

/** 登录后跳回哪里：只接受站内相对路径，挡掉 //evil.com 这类开放重定向 */
function safeReturnTo(v) {
  const s = String(v || '').trim();
  if (!s.startsWith('/') || s.startsWith('//')) return '/';
  return s.slice(0, 300);
}

function sweepStates() {
  const nowMs = Date.now();
  for (const [k, v] of QQ_STATES) if (v.exp < nowMs) QQ_STATES.delete(k);
}

/** 读 cookie → 查会话 → 取 QQ 用户；未登录返回 null（不抛错） */
async function resolveUser(req) {
  const tk = parseCookies(req)[MEMBER_COOKIE] || '';
  if (!tk) return null;
  const sess = await db.getUserSession(tk);
  if (!sess) return null;
  const user = await db.getQqUserById(sess.user_id);
  if (!user) { await db.deleteUserSession(tk); return null; }
  return { tk, user };
}

/* 对外只暴露昵称头像，openid 属站内标识，不外泄 */
function publicUser(u) {
  return { id: u.id, nickname: u.nickname || '', avatar: u.avatar || '', lastLoginAt: u.last_login_at };
}

/** 第一步：302 到 QQ 授权页 */
async function handleQqStart(req, res, url) {
  if (!qq.enabled(QQ_CFG)) {
    return json(res, 503, { ok: false, error: 'QQ 登录尚未配置' });
  }
  sweepStates();
  const state = auth.newId(16);
  QQ_STATES.set(state, { returnTo: safeReturnTo(url.searchParams.get('returnTo')), exp: Date.now() + QQ_STATE_TTL_MS });
  return redirect(res, qq.authorizeUrl(QQ_CFG, state));
}

/** 第二步：QQ 回调 → 换 token → 取 openid/资料 → 落库 → 下发 cookie → 跳回原目标 */
async function handleQqCallback(req, res, url) {
  if (!qq.enabled(QQ_CFG)) {
    return json(res, 503, { ok: false, error: 'QQ 登录尚未配置' });
  }
  const code = String(url.searchParams.get('code') || '');
  const state = String(url.searchParams.get('state') || '');
  const rec = QQ_STATES.get(state);
  if (!code || !rec || rec.exp < Date.now()) {
    if (state) QQ_STATES.delete(state);
    console.error('[qq] 回调缺少有效 code/state（可能过期或被伪造）');
    return redirect(res, '/#/login?error=state');
  }
  QQ_STATES.delete(state);

  const ip = clientIp(req);
  try {
    const { accessToken } = await qq.exchangeToken(QQ_CFG, code);
    const { openid, unionid } = await qq.fetchOpenid(accessToken);
    const info = await qq.fetchUserInfo(QQ_CFG, accessToken, openid);
    const user = await db.upsertQqUser({
      id: auth.newId(16), openid, unionid,
      nickname: info.nickname, avatar: info.avatar, gender: info.gender, ip,
    });
    const tk = auth.newId(32);
    const expiresAt = new Date(Date.now() + MEMBER_TTL_HOURS * 3600 * 1000);
    await db.createUserSession({ tk, userId: user.id, expiresAt, ip, ua: req.headers['user-agent'] });
    res.setHeader('Set-Cookie', memberCookieHeader(req, tk, Math.floor(MEMBER_TTL_HOURS * 3600)));
    console.log(`[qq] 登录成功 user=${user.id} nickname=${user.nickname || '(无昵称)'}`);
    return redirect(res, rec.returnTo || '/');
  } catch (e) {
    console.error('[qq] 登录失败：', e && e.message);
    return redirect(res, '/#/login?error=qq');
  }
}

async function handleUserMe(req, res) {
  const me = await resolveUser(req);
  if (!me) return json(res, 200, { ok: true, loggedIn: false });
  return json(res, 200, { ok: true, loggedIn: true, user: publicUser(me.user) });
}

async function handleUserLogout(req, res) {
  const tk = parseCookies(req)[MEMBER_COOKIE] || '';
  if (tk) await db.deleteUserSession(tk);
  res.setHeader('Set-Cookie', memberCookieHeader(req, '', 0));
  return json(res, 200, { ok: true });
}

/** 给投稿用的门禁判定：未登录就 401，前端据此弹登录 */
function requireUser(me, res) {
  if (me) return false;
  json(res, 401, { ok: false, error: '请先登录', needLogin: true });
  return true;
}

/* ---------------- 小游戏分数 ---------------- */

/** 上报一局成绩：跑分类报原始分；棋盘类报胜负 + 难度，分数由服务端算 */
async function handleGameScore(req, res) {
  const me = await resolveUser(req);
  if (requireUser(me, res)) return;

  const body = await readJsonBody(req);
  const game = String(body.game || '');
  const rule = GAME_RULES[game];
  if (!rule) return json(res, 400, { ok: false, error: '这个游戏不计分' });

  const dedupeKey = `${me.user.id}|${game}`;
  if (Date.now() - (gameScoreAt.get(dedupeKey) || 0) < SCORE_DEDUPE_MS) {
    return json(res, 200, { ok: true, ignored: true, error: '重复提交已忽略' });
  }

  let rawScore = 0;
  let points = 0;
  let outcome = null;
  let difficulty = null;

  if (rule.kind === 'best') {
    rawScore = Math.floor(Number(body.score) || 0);
    if (!(rawScore > 0) || rawScore > MAX_RAW_SCORE) {
      return json(res, 400, { ok: false, error: '分数不合法' });
    }
    points = rawScore;
  } else {
    outcome = String(body.outcome || '');
    if (!(outcome in BOARD_POINTS)) return json(res, 400, { ok: false, error: '对局结果不合法' });
    difficulty = String(body.difficulty || 'medium');
    if (!(difficulty in DIFFICULTY_MULT)) difficulty = 'medium';
    points = BOARD_POINTS[outcome] * DIFFICULTY_MULT[difficulty];
    if (points <= 0) return json(res, 200, { ok: true, ignored: true, error: '本局不计分' });
  }

  gameScoreAt.set(dedupeKey, Date.now());
  const summary = await db.addGameScore({
    userId: me.user.id, game, kind: rule.kind, points, rawScore,
  });
  await db.addGameScoreLog({
    id: auth.newId(16), userId: me.user.id, game, kind: rule.kind,
    difficulty, outcome, rawScore, points, ip: clientIp(req),
  });
  console.log(`[game] ${rule.label} user=${me.user.id} +${points}${difficulty ? ` (${difficulty})` : ''} 累计=${summary.score}`);
  return json(res, 200, { ok: true, game, points, total: Number(summary.score) });
}

/** 我的分数（先给验证与后续排行榜用） */async function handleGameMe(req, res) {
  const me = await resolveUser(req);
  if (!me) return json(res, 200, { ok: true, loggedIn: false, scores: [], total: 0 });
  const rows = await db.listGameScores(me.user.id);
  const scores = rows.map((r) => ({
    game: r.game,
    label: (GAME_RULES[r.game] || {}).label || r.game,
    score: Number(r.score),
    playCount: Number(r.play_count),
    bestSingle: Number(r.best_single),
    updatedAt: r.updated_at,
  }));
  return json(res, 200, {
    ok: true,
    loggedIn: true,
    scores,
    total: scores.reduce((n, s) => n + s.score, 0),
  });
}

/**
 * 排行榜：前 10 名 + 自己的名次。
 * 看榜不需要登录；登录了才附带「你自己」那一段。
 * 名次按分数降序（同分先达到的靠前），百分位 = ceil(名次 / 有成绩人数 × 100)。
 */
async function handleGameLeaderboard(req, res, url) {
  const game = String(url.searchParams.get('game') || '');
  const rule = GAME_RULES[game];
  if (!rule) return json(res, 400, { ok: false, error: '这个游戏没有排行榜' });

  const rows = await db.topGameScores(game, 10);
  const top = rows.map((r, i) => ({
    rank: i + 1,
    nickname: r.nickname || '匿名旅行者',
    avatar: r.avatar || '',
    score: Number(r.score),
  }));

  let me = { loggedIn: false };
  const who = await resolveUser(req);
  if (who) {
    const s = await db.gameScoreRank(game, who.user.id);
    if (s.rank > 0 && s.total > 0) {
      const percent = Math.max(1, Math.ceil((s.rank / s.total) * 100));
      me = {
        loggedIn: true,
        score: s.score,
        rank: s.rank,
        total: s.total,
        inTop: s.rank <= top.length,
        percent,
      };
    } else {
      me = { loggedIn: true, score: 0, rank: 0, total: 0, inTop: false, percent: 0 };
    }
  }

  return json(res, 200, { ok: true, game, label: rule.label, top, me });
}

/* ---------------- 投稿列表 / 详情 ---------------- */

async function handleAdminList(req, res, url) {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 200);
  const offset = Math.max(Number(url.searchParams.get('offset') || 0), 0);
  const filter = String(url.searchParams.get('filter') || 'all');
  const q = String(url.searchParams.get('q') || '').trim().slice(0, 60);
  const { rows, total } = await db.listForAdmin({ filter, q, limit, offset });
  const items = [];
  for (const r of rows) {
    const files = await db.filesOf(r.id);
    items.push({ ...rowToJson(r, true), files: files.map(fileToJson) });
  }
  return json(res, 200, { ok: true, total, limit, offset, filter, q, items });
}

async function handleAdminStats(req, res) {
  const stats = await db.adminStats();
  return json(res, 200, { ok: true, stats });
}

async function handleAdminDetail(req, res, id) {
  const row = await db.getSubmission(id);
  if (!row) return json(res, 404, { ok: false, error: '投稿不存在' });
  const files = await db.filesOf(id);
  return json(res, 200, { ok: true, item: { ...rowToJson(row, true), files: files.map(fileToJson) } });
}

async function handleFavorite(req, res, id) {
  const body = await readJsonBody(req);
  const row = await db.getSubmission(id);
  if (!row) return json(res, 404, { ok: false, error: '投稿不存在' });
  const want = body.favorite === undefined ? !row.favorite : !!body.favorite;
  await db.setFavorite(id, want);
  return json(res, 200, { ok: true, id, favorite: want });
}

/** 硬删除：投稿行、附件记录、磁盘上的附件文件全部真删，不留任何软删标记 */
async function handleDelete(req, res, id) {
  const row = await db.getSubmission(id);
  if (!row) return json(res, 404, { ok: false, error: '投稿不存在' });
  const { deleted, files } = await db.hardDeleteSubmission(id);
  const removed = [];
  for (const f of files) {
    if (!f.stored_path) continue;
    try {
      await fs.promises.rm(f.stored_path, { force: true });
      removed.push(f.original_name);
    } catch (e) {
      console.error('[delete] 附件删除失败', f.stored_path, e && e.message);
    }
  }
  console.log(`[admin] 硬删除投稿 ${id}（附件 ${removed.length} 个）`);
  return json(res, 200, {
    ok: true, id, deleted, removedFiles: removed,
    title: row.title, contact: `${row.contact_type} / ${row.contact_value}`,
  });
}

/* ---------------- 批量操作 ---------------- */

const MAX_BATCH = 200;

function pickIds(body) {
  if (!Array.isArray(body.ids)) return [];
  const seen = new Set();
  return body.ids
    .map((id) => String(id || ''))
    .filter((id) => /^[a-f0-9]{32}$/.test(id) && !seen.has(id) && seen.add(id))
    .slice(0, MAX_BATCH);
}

/** 批量收藏 / 取消收藏 */
async function handleBatchFavorite(req, res) {
  const body = await readJsonBody(req);
  const ids = pickIds(body);
  if (!ids.length) return json(res, 400, { ok: false, error: '没有选中任何单品' });
  const want = body.favorite === undefined ? true : !!body.favorite;
  const done = [];
  const missing = [];
  for (const id of ids) {
    const row = await db.getSubmission(id);
    if (!row) { missing.push(id); continue; }
    await db.setFavorite(id, want);
    done.push(id);
  }
  console.log(`[admin] 批量${want ? '收藏' : '取消收藏'} ${done.length} 条`);
  return json(res, 200, { ok: true, favorite: want, updated: done.length, ids: done, missing });
}

/** 批量硬删除：投稿行 + 附件记录 + 磁盘附件一起真删 */
async function handleBatchDelete(req, res) {
  const body = await readJsonBody(req);
  const ids = pickIds(body);
  if (!ids.length) return json(res, 400, { ok: false, error: '没有选中任何单品' });
  const done = [];
  const missing = [];
  const removedFiles = [];
  for (const id of ids) {
    const row = await db.getSubmission(id);
    if (!row) { missing.push(id); continue; }
    const { files } = await db.hardDeleteSubmission(id);
    for (const f of files) {
      if (!f.stored_path) continue;
      try {
        await fs.promises.rm(f.stored_path, { force: true });
        removedFiles.push(f.original_name);
      } catch (e) {
        console.error('[delete] 附件删除失败', f.stored_path, e && e.message);
      }
    }
    done.push(id);
  }
  console.log(`[admin] 批量硬删除投稿 ${done.length} 条（附件 ${removedFiles.length} 个）`);
  return json(res, 200, { ok: true, deleted: done.length, ids: done, missing, removedFiles });
}

async function handleAdminFile(req, res, id) {
  const f = await db.getFile(id);
  if (!f || !f.stored_path) return json(res, 404, { ok: false, error: '附件不存在' });
  let st;
  try { st = await up.statFile(f.stored_path); } catch (e) { return json(res, 404, { ok: false, error: '附件文件已丢失' }); }
  res.writeHead(200, {
    'Content-Type': f.mime || 'application/octet-stream',
    'Content-Length': st.size,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.original_name)}`,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(f.stored_path).pipe(res);
}

/* ---------------- 管理员账号（仅 super） ---------------- */

async function handleUsersList(req, res) {
  const rows = await db.listAdminUsers();
  return json(res, 200, {
    ok: true,
    items: rows.map((u) => ({
      id: u.id, username: u.username, role: u.role,
      createdAt: u.created_at, createdBy: u.created_by, lastLoginAt: u.last_login_at,
      hasSecret: !!u.has_secret,
      protected: u.username === PROTECTED_ADMIN,
    })),
  });
}

async function handleUserCreate(req, res, me) {
  const body = await readJsonBody(req);
  const username = String(body.username || '').trim();
  const secret = String(body.secret || '');
  const role = body.role === 'super' ? 'super' : 'admin';

  if (!auth.validUsername(username)) {
    return json(res, 400, { ok: false, error: '账号需 4–32 位，字母开头，只能含字母/数字/下划线/短横线' });
  }
  if (!auth.validSecret(secret)) {
    return json(res, 400, { ok: false, error: '口令至少 8 位，且不能是纯数字' });
  }
  if (await db.getAdminUserByName(username)) {
    return json(res, 409, { ok: false, error: '该账号已存在' });
  }

  const salt = auth.newSalt();
  const row = {
    id: auth.newId(16), username, salt,
    hash: auth.hashSecret(secret, salt), role,
    secretEnc: SECRET_KEY ? auth.encryptSecret(secret, SECRET_KEY) : null,
    createdBy: me.viaMaster ? 'master' : me.username,
  };
  await db.createAdminUser(row);
  return json(res, 201, {
    ok: true, user: { id: row.id, username, role, createdAt: new Date().toISOString() },
  });
}

async function handleUserSecret(req, res, id, me) {
  const body = await readJsonBody(req);
  const secret = String(body.secret || '');
  if (!auth.validSecret(secret)) {
    return json(res, 400, { ok: false, error: '口令至少 8 位，且不能是纯数字' });
  }
  const u = await db.getAdminUserById(id);
  if (!u) return json(res, 404, { ok: false, error: '账号不存在' });
  /* 重置权限：普通管理员的随便重置；超级管理员只能重置自己的（超管之间不行，总秘钥也不行） */
  const isSelf = !me.viaMaster && me.userId === u.id;
  if (u.role !== 'admin' && !isSelf) {
    return json(res, 403, { ok: false, error: '只能重置自己的口令（其他超级管理员不行）' });
  }
  const salt = auth.newSalt();
  const enc = SECRET_KEY ? auth.encryptSecret(secret, SECRET_KEY) : null;
  await db.updateAdminSecret(id, salt, auth.hashSecret(secret, salt), enc);
  /* 改了口令就作废该账号所有会话（含自己）：下次要用新口令重新登录 */
  await db.revokeUserSessions(id);
  return json(res, 200, { ok: true, id, username: u.username, selfReset: isSelf, sessionsRevoked: true });
}

/**
 * 查看账号口令（仅 super）。
 * 规则：普通管理员的口令都能看；超级管理员只能看**自己**的，看不到其他超管的。
 * 解密的是创建/重置时存下的加密副本；登录校验永远走哈希，不受影响。
 * 老账号（加这个功能之前建的）没有副本，只能重置一次后才能查看。
 */
async function handleUserReveal(req, res, id, me) {
  const u = await db.getAdminUserById(id);
  if (!u) return json(res, 404, { ok: false, error: '账号不存在' });
  const isSelf = !me.viaMaster && me.userId === u.id;
  if (u.role !== 'admin' && !isSelf) {
    return json(res, 403, { ok: false, error: '其他超级管理员的口令不提供查看' });
  }
  if (!u.secret_enc) {
    return json(res, 200, {
      ok: true, id, username: u.username, secret: null, stored: false,
      hint: '这个账号是在「可查看口令」之前建的，请点「重置口令」重设一次，之后就能查看。',
    });
  }
  if (!SECRET_KEY) return json(res, 500, { ok: false, error: '服务端未加载密钥' });
  const plain = auth.decryptSecret(u.secret_enc, SECRET_KEY);
  if (!plain) {
    return json(res, 200, {
      ok: true, id, username: u.username, secret: null, stored: true,
      hint: '口令副本解密失败（密钥文件可能换过了），请重置口令。',
    });
  }
  return json(res, 200, { ok: true, id, username: u.username, secret: plain, stored: true });
}

async function handleUserDelete(req, res, me, id) {
  const u = await db.getAdminUserById(id);
  if (!u) return json(res, 404, { ok: false, error: '账号不存在' });
  /* 内置超级管理员一直是系统的落脚点：谁都删不掉（包括总秘钥和它自己） */
  if (u.username === PROTECTED_ADMIN) {
    return json(res, 403, { ok: false, error: '内置超级管理员不可删除' });
  }
  if (!me.viaMaster && me.userId === id) {
    return json(res, 400, { ok: false, error: '不能删除自己' });
  }
  if (u.role === 'super' && (await db.countSupers(id)) === 0) {
    return json(res, 400, { ok: false, error: '至少要保留一个超级管理员' });
  }
  await db.deleteAdminUser(id);
  return json(res, 200, { ok: true, id, username: u.username });
}

/* ------------------------------------------------------------ 路由 */

const ROUTES = [
  ['GET', /^\/api\/health\/?$/, async (req, res) => json(res, 200, { ok: true, service: 'columbina-birthday', time: new Date().toISOString() }), null],
  ['POST', /^\/api\/uploads\/?$/, handleUploadsCreate, null],
  ['GET', /^\/api\/uploads\/([a-f0-9]{32})\/?$/, async (req, res, m) => handleUploadStatus(req, res, m[1]), null],
  ['PUT', /^\/api\/uploads\/([a-f0-9]{32})\/chunk\/(\d+)\/?$/, async (req, res, m) => handleUploadChunk(req, res, m[1], Number(m[2])), null],
  ['POST', /^\/api\/uploads\/([a-f0-9]{32})\/complete\/?$/, async (req, res, m) => handleUploadComplete(req, res, m[1]), null],
  ['POST', /^\/api\/submissions\/?$/, handleSubmit, null],
  ['POST', /^\/api\/submissions\/lookup\/?$/, handleSubmissionLookup, null],
  ['PUT', /^\/api\/submissions\/([a-f0-9]{32})\/?$/, async (req, res, m) => handleSubmissionUpdate(req, res, m[1]), null],
  ['GET', /^\/api\/submissions\/([a-f0-9]{32})\/?$/, async (req, res, m) => handleSubmissionReceipt(req, res, m[1]), null],

  /* 访客 QQ 登录（cookie 会话，与管理员体系完全分开） */
  ['GET', /^\/api\/auth\/qq\/start\/?$/, async (req, res, m, url) => handleQqStart(req, res, url), null],
  ['GET', /^\/api\/auth\/qq\/callback\/?$/, async (req, res, m, url) => handleQqCallback(req, res, url), null],
  ['GET', /^\/api\/auth\/me\/?$/, handleUserMe, null],
  ['POST', /^\/api\/auth\/logout\/?$/, handleUserLogout, null],

  /* 小游戏分数（需登录 cookie） */
  ['POST', /^\/api\/game\/score\/?$/, handleGameScore, null],
  ['GET', /^\/api\/game\/me\/?$/, handleGameMe, null],
  ['GET', /^\/api\/game\/leaderboard\/?$/, async (req, res, m, url) => handleGameLeaderboard(req, res, url), null],

  /* 管理端 */
  ['POST', /^\/api\/admin\/login\/?$/, handleLogin, null],
  ['POST', /^\/api\/admin\/logout\/?$/, async (req, res, m, url, me) => handleLogout(req, res, me), 'session'],
  ['GET', /^\/api\/admin\/me\/?$/, async (req, res, m, url, me) => handleMe(req, res, me), 'session'],
  ['GET', /^\/api\/admin\/stats\/?$/, handleAdminStats, 'session'],
  ['GET', /^\/api\/admin\/submissions\/?$/, async (req, res, m, url) => handleAdminList(req, res, url), 'session'],
  ['GET', /^\/api\/admin\/submissions\/([a-f0-9]{32})\/?$/, async (req, res, m) => handleAdminDetail(req, res, m[1]), 'session'],
  ['POST', /^\/api\/admin\/submissions\/batch\/favorite\/?$/, handleBatchFavorite, 'session'],
  ['POST', /^\/api\/admin\/submissions\/batch\/delete\/?$/, handleBatchDelete, 'session'],
  ['POST', /^\/api\/admin\/submissions\/([a-f0-9]{32})\/favorite\/?$/, async (req, res, m) => handleFavorite(req, res, m[1]), 'session'],
  ['DELETE', /^\/api\/admin\/submissions\/([a-f0-9]{32})\/?$/, async (req, res, m) => handleDelete(req, res, m[1]), 'session'],
  ['GET', /^\/api\/admin\/files\/([a-f0-9]{32})\/?$/, async (req, res, m) => handleAdminFile(req, res, m[1]), 'session'],
  ['GET', /^\/api\/admin\/users\/?$/, handleUsersList, 'super'],
  ['POST', /^\/api\/admin\/users\/?$/, async (req, res, m, url, me) => handleUserCreate(req, res, me), 'super'],
  ['POST', /^\/api\/admin\/users\/([a-f0-9]{32})\/secret\/?$/, async (req, res, m, url, me) => handleUserSecret(req, res, m[1], me), 'super'],
  ['GET', /^\/api\/admin\/users\/([a-f0-9]{32})\/secret\/?$/, async (req, res, m, url, me) => handleUserReveal(req, res, m[1], me), 'super'],
  ['DELETE', /^\/api\/admin\/users\/([a-f0-9]{32})\/?$/, async (req, res, m, url, me) => handleUserDelete(req, res, me, m[1]), 'super'],
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    for (const [method, re, fn, level] of ROUTES) {
      const m = re.exec(p);
      if (!m) continue;
      if (req.method !== method) continue;
      let me = null;
      if (level) {
        me = await resolveAuth(req, url);
        if (!me.ok) return json(res, 401, { ok: false, error: '未登录或登录已过期' });
        if (level === 'super' && me.role !== 'super') {
          return json(res, 403, { ok: false, error: '需要超级管理员权限' });
        }
      }
      return await fn(req, res, m, url, me);
    }
    return json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    const code = e && e.code && Number.isInteger(e.code) ? e.code : 500;
    if (code >= 500) console.error('[error]', req.method, p, e && e.stack || e);
    return json(res, code, { ok: false, error: code === 413 ? '请求体过大' : '服务器内部错误' });
  }
});

/* ------------------------------------------------------------ 启动 */

/** 库里一个账号都没有时，建一个超级管理员，随机口令写在 data/admin-init.txt（600） */
async function ensureSuperAdmin() {
  const n = await db.countAdmins();
  if (n > 0) return;
  const username = String((cfg.initAdmin && cfg.initAdmin.username) || 'admin');
  const secret = auth.newId(12);
  const salt = auth.newSalt();
  await db.createAdminUser({
    id: auth.newId(16), username, salt,
    hash: auth.hashSecret(secret, salt), role: 'super', createdBy: 'system',
    secretEnc: SECRET_KEY ? auth.encryptSecret(secret, SECRET_KEY) : null,
  });
  const p = path.join(DATA_DIR, 'admin-init.txt');
  fs.writeFileSync(
    p,
    `账号：${username}\n口令：${secret}\n创建时间：${new Date().toISOString()}\n（首次登录后请在后台改掉）\n`,
    { mode: 0o600 }
  );
  console.log(`[init] 已创建超级管理员「${username}」，初始口令写在 ${p}（600 权限）`);
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  up.initDirs(DATA_DIR);
  SECRET_KEY = auth.loadKey(keyFilePath());
  QQ_CFG = qq.readConfig(DATA_DIR);
  await db.init();
  await ensureSuperAdmin();
  const retentionDays = Number(cfg.retentionDays || 7);
  const sweep = async () => {
    try {
      const r = await up.cleanup(DATA_DIR, retentionDays * 86400 * 1000);
      const stale = await db.staleUploads(new Date(Date.now() - retentionDays * 86400 * 1000));
      for (const s of stale) if (s.state === 'open') await db.dropUpload(s.id);
      await db.purgeSessions();
      await db.purgeUserSessions();
      if (r.removedTmp) console.log(`[cleanup] 清理过期分片目录 ${r.removedTmp} 个`);
    } catch (e) {
      console.error('[cleanup] 失败', e && e.message);
    }
  };
  await sweep();
  setInterval(sweep, 6 * 3600 * 1000);

  server.listen(PORT, HOST, () => {
    console.log(`columbina-birthday api listening on http://${HOST}:${PORT}${PUBLIC_BASE || ''}`);
    console.log(qq.enabled(QQ_CFG)
      ? `[qq] QQ 登录已启用，回调地址 ${QQ_CFG.redirectUri}`
      : '[qq] QQ 登录未配置（缺 data/qq.json 或 QQ_APP_ID/QQ_APP_KEY 环境变量），/api/auth/* 返回 503');
  });
}

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT', () => { server.close(() => process.exit(0)); });

main().catch((e) => {
  console.error('启动失败：', e);
  process.exit(1);
});
