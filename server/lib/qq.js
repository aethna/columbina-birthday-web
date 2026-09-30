'use strict';
/**
 * QQ 互联 OAuth 2.0 登录（授权码模式）。
 *
 * 密钥不落仓库：优先读环境变量 QQ_APP_ID / QQ_APP_KEY / QQ_REDIRECT_URI，
 * 否则读 <dataDir>/qq.json（部署脚本排除 data/，所以密钥永远进不了 public 仓库）。
 *
 * 流程：authorizeUrl(跳 QQ) → exchangeToken(code→access_token) → fetchOpenid → fetchUserInfo
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const GRAPH = 'https://graph.qq.com';
const TIMEOUT_MS = 12000;
const MAX_BYTES = 256 * 1024;

/** 读配置：环境变量优先，其次 <dataDir>/qq.json */
function readConfig(dataDir) {
  let fileCfg = {};
  const p = path.join(dataDir, 'qq.json');
  try {
    if (fs.existsSync(p)) fileCfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error('[qq] 读取 qq.json 失败：', e && e.message);
  }
  return {
    appId: String(process.env.QQ_APP_ID || fileCfg.appId || fileCfg.app_id || '').trim(),
    appKey: String(process.env.QQ_APP_KEY || fileCfg.appKey || fileCfg.app_key || '').trim(),
    redirectUri: String(process.env.QQ_REDIRECT_URI || fileCfg.redirectUri || fileCfg.redirect_uri || '').trim(),
  };
}

function enabled(cfg) {
  return !!(cfg && cfg.appId && cfg.appKey && cfg.redirectUri);
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: TIMEOUT_MS }, (res) => {
      const parts = [];
      let size = 0;
      res.on('data', (d) => {
        size += d.length;
        if (size > MAX_BYTES) { req.destroy(new Error('QQ 返回体过大')); return; }
        parts.push(d);
      });
      res.on('end', () => {
        const raw = Buffer.concat(parts).toString('utf8');
        try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error(`QQ 返回不是 JSON：${raw.slice(0, 200)}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('QQ 接口超时')));
    req.on('error', reject);
  });
}

function authorizeUrl(cfg, state) {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.appId,
    redirect_uri: cfg.redirectUri,
    state,
    scope: 'get_user_info',
  });
  return `${GRAPH}/oauth2.0/authorize?${q.toString()}`;
}

async function exchangeToken(cfg, code) {
  const q = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: cfg.appId,
    client_secret: cfg.appKey,
    code,
    redirect_uri: cfg.redirectUri,
    fmt: 'json',
  });
  const data = await getJson(`${GRAPH}/oauth2.0/token?${q.toString()}`);
  if (!data || !data.access_token) {
    throw new Error(`换取 access_token 失败：${JSON.stringify(data || {}).slice(0, 200)}`);
  }
  return {
    accessToken: String(data.access_token),
    refreshToken: String(data.refresh_token || ''),
    expiresIn: Number(data.expires_in || 0),
  };
}

async function fetchOpenid(accessToken) {
  const q = new URLSearchParams({ access_token: accessToken, fmt: 'json' });
  const data = await getJson(`${GRAPH}/oauth2.0/me?${q.toString()}`);
  if (!data || !data.openid) {
    throw new Error(`获取 openid 失败：${JSON.stringify(data || {}).slice(0, 200)}`);
  }
  return { openid: String(data.openid), unionid: String(data.unionid || '') };
}

/** ret !== 0 时（例如未填昵称）不报错，返回空资料，登录照常放行 */
async function fetchUserInfo(cfg, accessToken, openid) {
  const q = new URLSearchParams({
    access_token: accessToken,
    oauth_consumer_key: cfg.appId,
    openid,
    fmt: 'json',
  });
  const data = await getJson(`${GRAPH}/user/get_user_info?${q.toString()}`);
  if (!data || Number(data.ret) !== 0) {
    return { nickname: '', avatar: '', gender: '', raw: data || {} };
  }
  return {
    nickname: String(data.nickname || ''),
    avatar: String(data.figureurl_qq_2 || data.figureurl_2 || data.figureurl_qq_1 || ''),
    gender: String(data.gender || ''),
    raw: data,
  };
}

module.exports = { readConfig, enabled, authorizeUrl, exchangeToken, fetchOpenid, fetchUserInfo, GRAPH };
