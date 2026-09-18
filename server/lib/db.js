'use strict';
/**
 * 数据层（MySQL / mysql2）。
 * 投稿内容、投稿附件元数据、分片上传会话全部存在库里；
 * 附件本体以文件形式落在 server/data/uploads/files/ 下（视频体积大，不进 BLOB）。
 * 连接参数来自 server/config.json 的 db 段；口令可直接写，也可放文件（secretFile）。
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');

let pool = null;

function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
}

function readSecret(dbCfg) {
  if (dbCfg.secret) return String(dbCfg.secret);
  if (dbCfg.secretFile) {
    const p = path.isAbsolute(dbCfg.secretFile) ? dbCfg.secretFile : path.join(ROOT, dbCfg.secretFile);
    return fs.readFileSync(p, 'utf8').trim();
  }
  return '';
}

function readAdminSecret(cfg) {
  if (cfg.adminSecret) return String(cfg.adminSecret);
  if (cfg.adminSecretFile) {
    const p = path.isAbsolute(cfg.adminSecretFile) ? cfg.adminSecretFile : path.join(ROOT, cfg.adminSecretFile);
    try { return fs.readFileSync(p, 'utf8').trim(); } catch (e) { return ''; }
  }
  return '';
}

/* ------------------------------------------------------------ 建表 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS submissions (
     id VARCHAR(32) NOT NULL PRIMARY KEY,
     contact_type VARCHAR(16) NOT NULL,
     contact_value VARCHAR(255) NOT NULL,
     nicknames VARCHAR(600) NULL,
     creation_type VARCHAR(16) NOT NULL,
     team_members JSON NULL,
     title VARCHAR(255) NOT NULL,
     category VARCHAR(32) NOT NULL,
     intro TEXT NOT NULL,
     duration VARCHAR(32) NOT NULL,
     has_other_chars TINYINT(1) NOT NULL DEFAULT 0,
     other_chars JSON NULL,
     progress VARCHAR(32) NULL,
     preview_type VARCHAR(16) NULL,
     preview_link VARCHAR(1024) NULL,
     agreed TINYINT(1) NOT NULL DEFAULT 0,
     ip VARCHAR(64) NULL,
     ua VARCHAR(500) NULL,
     created_at DATETIME NOT NULL,
     KEY idx_created (created_at)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS submission_files (
     id VARCHAR(32) NOT NULL PRIMARY KEY,
     submission_id VARCHAR(32) NULL,
     original_name VARCHAR(255) NOT NULL,
     stored_path VARCHAR(500) NOT NULL,
     size BIGINT NOT NULL,
     mime VARCHAR(160) NULL,
     created_at DATETIME NOT NULL,
     KEY idx_sub (submission_id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS upload_sessions (
     id VARCHAR(32) NOT NULL PRIMARY KEY,
     original_name VARCHAR(255) NOT NULL,
     size BIGINT NOT NULL,
     mime VARCHAR(160) NULL,
     chunk_size INT NOT NULL,
     chunks_total INT NOT NULL,
     state VARCHAR(16) NOT NULL DEFAULT 'open',
     created_at DATETIME NOT NULL,
     updated_at DATETIME NOT NULL,
     KEY idx_updated (updated_at)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS admin_users (
     id VARCHAR(32) NOT NULL PRIMARY KEY,
     username VARCHAR(64) NOT NULL UNIQUE,
     salt CHAR(32) NOT NULL,
     hash CHAR(128) NOT NULL,
     role VARCHAR(16) NOT NULL DEFAULT 'admin',
     created_at DATETIME NOT NULL,
     created_by VARCHAR(64) NULL,
     last_login_at DATETIME NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS admin_sessions (
     tk CHAR(64) NOT NULL PRIMARY KEY,
     user_id VARCHAR(32) NOT NULL,
     role VARCHAR(16) NOT NULL,
     created_at DATETIME NOT NULL,
     expires_at DATETIME NOT NULL,
     KEY idx_expires (expires_at)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

/* 已有库的增量变更（CREATE TABLE IF NOT EXISTS 不会加列） */
const MIGRATIONS = [
  { table: 'submissions', column: 'favorite', sql: "ALTER TABLE submissions ADD COLUMN favorite TINYINT(1) NOT NULL DEFAULT 0" },
  { table: 'submissions', column: 'favorited_at', sql: "ALTER TABLE submissions ADD COLUMN favorited_at DATETIME NULL" },
  { table: 'admin_users', column: 'secret_enc', sql: "ALTER TABLE admin_users ADD COLUMN secret_enc VARCHAR(255) NULL" },
  { table: 'submissions', column: 'updated_at', sql: "ALTER TABLE submissions ADD COLUMN updated_at DATETIME NULL" },
];

async function migrate() {
  for (const m of MIGRATIONS) {
    const [rows] = await pool.query(
      'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      [m.table, m.column]
    );
    if (!rows.length) await pool.query(m.sql);
  }
}

async function init() {
  const cfg = loadConfig();
  const dbCfg = cfg.db;
  pool = mysql.createPool({
    host: dbCfg.host || '127.0.0.1',
    port: dbCfg.port || 3306,
    user: dbCfg.user,
    password: readSecret(dbCfg),
    database: dbCfg.database,
    connectionLimit: dbCfg.connectionLimit || 8,
    charset: 'utf8mb4_unicode_ci',
    timezone: '+08:00',
    namedPlaceholders: false,
    supportBigNumbers: true,
    bigNumberStrings: false,
  });
  for (const sql of SCHEMA) await pool.query(sql);
  await migrate();
  return pool;
}

function get() {
  if (!pool) throw new Error('db not initialized');
  return pool;
}

const now = () => new Date();

/* ------------------------------------------------------------ 上传会话 */

async function createUpload(row) {
  await get().query(
    `INSERT INTO upload_sessions
       (id, original_name, size, mime, chunk_size, chunks_total, state, created_at, updated_at)
     VALUES (?,?,?,?,?,?,'open',?,?)`,
    [row.id, row.originalName, row.size, row.mime, row.chunkSize, row.chunksTotal, now(), now()]
  );
}

async function getUpload(id) {
  const [rows] = await get().query('SELECT * FROM upload_sessions WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

async function touchUpload(id, state) {
  if (state) {
    await get().query('UPDATE upload_sessions SET updated_at = ?, state = ? WHERE id = ?', [now(), state, id]);
  } else {
    await get().query('UPDATE upload_sessions SET updated_at = ? WHERE id = ?', [now(), id]);
  }
}

async function findUploadByNameSize(name, size) {
  const [rows] = await get().query(
    'SELECT * FROM upload_sessions WHERE original_name = ? AND size = ? AND state = ? ORDER BY created_at DESC LIMIT 1',
    [name, size, 'open']
  );
  return rows[0] || null;
}

async function staleUploads(beforeDate) {
  const [rows] = await get().query('SELECT * FROM upload_sessions WHERE updated_at < ?', [beforeDate]);
  return rows;
}

async function dropUpload(id) {
  await get().query('DELETE FROM upload_sessions WHERE id = ?', [id]);
}

/* ------------------------------------------------------------ 附件 */

async function insertFile(row) {
  await get().query(
    `INSERT INTO submission_files
       (id, submission_id, original_name, stored_path, size, mime, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [row.id, row.submissionId || null, row.originalName, row.storedPath, row.size, row.mime || null, now()]
  );
}

async function getFile(id) {
  const [rows] = await get().query('SELECT * FROM submission_files WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

async function attachFiles(submissionId, ids) {
  if (!ids || !ids.length) return;
  const marks = ids.map(() => '?').join(',');
  await get().query(
    `UPDATE submission_files SET submission_id = ? WHERE id IN (${marks}) AND submission_id IS NULL`,
    [submissionId, ...ids]
  );
}

async function filesOf(submissionId) {
  const [rows] = await get().query('SELECT * FROM submission_files WHERE submission_id = ?', [submissionId]);
  return rows;
}

/* ------------------------------------------------------------ 投稿 */

const SUB_FIELDS = [
  'id', 'contact_type', 'contact_value', 'nicknames', 'creation_type', 'team_members',
  'title', 'category', 'intro', 'duration', 'has_other_chars', 'other_chars',
  'progress', 'preview_type', 'preview_link', 'agreed', 'ip', 'ua', 'created_at',
];
async function insertSubmission(row) {
  const cols = SUB_FIELDS.join(',');
  const marks = SUB_FIELDS.map(() => '?').join(',');
  await get().query(
    `INSERT INTO submissions (${cols}) VALUES (${marks})`,
    SUB_FIELDS.map((f) => row[f] === undefined ? null : row[f])
  );
}

/* 覆盖更新：投稿编号（id）与首次提交的 ip/ua 保持不变，只换内容 */
const SUB_UPDATE_FIELDS = [
  'contact_type', 'contact_value', 'nicknames', 'creation_type', 'team_members',
  'title', 'category', 'intro', 'duration', 'has_other_chars', 'other_chars',
  'progress', 'preview_type', 'preview_link', 'agreed', 'updated_at',
];
async function updateSubmission(id, row) {
  const sets = SUB_UPDATE_FIELDS.map((f) => `${f} = ?`).join(', ');
  await get().query(
    `UPDATE submissions SET ${sets} WHERE id = ?`,
    [...SUB_UPDATE_FIELDS.map((f) => (row[f] === undefined ? null : row[f])), id]
  );
}

async function getSubmission(id) {
  const [rows] = await get().query('SELECT * FROM submissions WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

/* 删除单条附件记录（返回被删的那行，便于调用方顺手删磁盘文件） */
async function deleteFileRecord(fileId) {
  const [rows] = await get().query('SELECT * FROM submission_files WHERE id = ? LIMIT 1', [fileId]);
  const row = rows[0] || null;
  if (row) await get().query('DELETE FROM submission_files WHERE id = ?', [fileId]);
  return row;
}

async function listSubmissions(limit, offset) {
  const [rows] = await get().query(
    'SELECT * FROM submissions ORDER BY created_at DESC LIMIT ? OFFSET ?',
    [Number(limit), Number(offset)]
  );
  return rows;
}

async function countSubmissions() {
  const [rows] = await get().query('SELECT COUNT(*) AS n FROM submissions');
  return Number(rows[0].n);
}

async function countRecentSubmissions(ip, since) {
  const [rows] = await get().query(
    'SELECT COUNT(*) AS n FROM submissions WHERE ip = ? AND created_at >= ?',
    [ip, since]
  );
  return Number(rows[0].n);
}

/* 管理端列表（可按收藏筛选 / 关键词搜索） */
async function listForAdmin({ filter, q, limit, offset }) {
  const where = [];
  const args = [];
  if (filter === 'favorite') where.push('favorite = 1');
  if (filter === 'file') where.push("preview_type = 'file'");
  /* 24 小时内：与 adminStats() 的 last24h 同一时间窗口，保证卡片数字与列表条数一致 */
  if (filter === 'recent') { where.push('created_at >= ?'); args.push(new Date(Date.now() - 86400 * 1000)); }
  if (q) {
    where.push('(title LIKE ? OR intro LIKE ? OR contact_value LIKE ? OR nicknames LIKE ?)');
    const like = `%${q}%`;
    args.push(like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows] = await get().query(
    `SELECT * FROM submissions ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...args, Number(limit), Number(offset)]
  );
  const [cnt] = await get().query(`SELECT COUNT(*) AS n FROM submissions ${clause}`, args);
  return { rows, total: Number(cnt[0].n) };
}

async function adminStats() {
  const [rows] = await get().query(
    `SELECT COUNT(*) AS total,
            SUM(favorite = 1) AS favorites,
            SUM(preview_type = 'file') AS with_files,
            SUM(created_at >= ?) AS last24h
     FROM submissions`,
    [new Date(Date.now() - 86400 * 1000)]
  );
  const r = rows[0] || {};
  return {
    total: Number(r.total || 0),
    favorites: Number(r.favorites || 0),
    withFiles: Number(r.with_files || 0),
    last24h: Number(r.last24h || 0),
  };
}

async function setFavorite(id, favorite) {
  const [res] = await get().query(
    'UPDATE submissions SET favorite = ?, favorited_at = ? WHERE id = ?',
    [favorite ? 1 : 0, favorite ? now() : null, id]
  );
  return res.affectedRows;
}

/** 硬删除：直接删行（不留软删标记），附件与分片由调用方一并清掉 */
async function hardDeleteSubmission(id) {
  const files = await filesOf(id);
  await get().query('DELETE FROM submission_files WHERE submission_id = ?', [id]);
  const [res] = await get().query('DELETE FROM submissions WHERE id = ?', [id]);
  return { deleted: res.affectedRows, files };
}

/* ------------------------------------------------------------ 管理员账号 / 登录态 */

async function countAdmins() {
  const [rows] = await get().query('SELECT COUNT(*) AS n FROM admin_users');
  return Number(rows[0].n);
}

async function listAdminUsers() {
  const [rows] = await get().query(
    `SELECT id, username, role, created_at, created_by, last_login_at,
            (secret_enc IS NOT NULL) AS has_secret
       FROM admin_users ORDER BY created_at`
  );
  return rows;
}

async function getAdminUserById(id) {
  const [rows] = await get().query('SELECT * FROM admin_users WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

async function getAdminUserByName(username) {
  const [rows] = await get().query('SELECT * FROM admin_users WHERE username = ? LIMIT 1', [username]);
  return rows[0] || null;
}

async function createAdminUser(row) {
  await get().query(
    `INSERT INTO admin_users (id, username, salt, hash, role, created_at, created_by, secret_enc)
     VALUES (?,?,?,?,?,?,?,?)`,
    [row.id, row.username, row.salt, row.hash, row.role, now(), row.createdBy || null, row.secretEnc || null]
  );
}

async function updateAdminSecret(id, salt, hash, secretEnc) {
  await get().query(
    'UPDATE admin_users SET salt = ?, hash = ?, secret_enc = ? WHERE id = ?',
    [salt, hash, secretEnc || null, id]
  );
}

async function touchAdminLogin(id) {
  await get().query('UPDATE admin_users SET last_login_at = ? WHERE id = ?', [now(), id]);
}

async function deleteAdminUser(id) {
  await get().query('DELETE FROM admin_sessions WHERE user_id = ?', [id]);
  const [res] = await get().query('DELETE FROM admin_users WHERE id = ?', [id]);
  return res.affectedRows;
}

async function countSupers(exceptId) {
  const [rows] = await get().query(
    "SELECT COUNT(*) AS n FROM admin_users WHERE role = 'super' AND id <> ?",
    [exceptId || '']
  );
  return Number(rows[0].n);
}

async function createSession(row) {
  await get().query(
    'INSERT INTO admin_sessions (tk, user_id, role, created_at, expires_at) VALUES (?,?,?,?,?)',
    [row.tk, row.userId, row.role, now(), row.expiresAt]
  );
}

async function getSession(tk) {
  const [rows] = await get().query(
    'SELECT * FROM admin_sessions WHERE tk = ? AND expires_at > ? LIMIT 1',
    [tk, now()]
  );
  return rows[0] || null;
}

async function deleteSession(tk) {
  await get().query('DELETE FROM admin_sessions WHERE tk = ?', [tk]);
}

/**
 * 吊销某个账号的会话。
 * exceptTk：把当前这条排除在外（单点登录时用，新登录的会话自己不能被剔掉）。
 * 不传 exceptTk 就是全清（改口令后要求重新登录时用）。
 */
async function revokeUserSessions(userId, exceptTk = null) {
  const [res] = exceptTk
    ? await get().query('DELETE FROM admin_sessions WHERE user_id = ? AND tk <> ?', [userId, exceptTk])
    : await get().query('DELETE FROM admin_sessions WHERE user_id = ?', [userId]);
  return res.affectedRows || 0;
}

async function purgeSessions() {
  const [res] = await get().query('DELETE FROM admin_sessions WHERE expires_at <= ?', [now()]);
  return res.affectedRows || 0;
}

module.exports = {
  loadConfig, readAdminSecret, init, get, now,
  createUpload, getUpload, touchUpload, findUploadByNameSize, staleUploads, dropUpload,
  insertFile, getFile, attachFiles, filesOf,
  insertSubmission, updateSubmission, getSubmission, listSubmissions, countSubmissions, countRecentSubmissions,
  deleteFileRecord,
  listForAdmin, adminStats, setFavorite, hardDeleteSubmission,
  countAdmins, listAdminUsers, getAdminUserById, getAdminUserByName, createAdminUser,
  updateAdminSecret, touchAdminLogin, deleteAdminUser, countSupers,
  createSession, getSession, deleteSession, purgeSessions, revokeUserSessions,
};
