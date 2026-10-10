/**
 * 把游戏成绩上报到主站后端（分数与 QQ 账号绑定）。
 *
 * 游戏页（/game/）与主站同域，登录态是主站下发的 HttpOnly cookie，
 * 所以这里只要 credentials: 'same-origin'，前端拿不到也不需要 token。
 *
 * 未登录、网络失败、后端拒绝——一律静默忽略，绝不打断游戏本身。
 */

const ENDPOINT = '/api/game/score'

function send(payload) {
  try {
    return fetch(ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => null)
  } catch (e) {
    return Promise.resolve(null)
  }
}

/** 跑分类：报原始分数，后端取历史最高（云隙轻歌 / 无尽巡游） */
export function reportBestScore(game, score) {
  const n = Math.max(0, Math.floor(Number(score) || 0))
  if (!n) return Promise.resolve(null)
  return send({ game, score: n })
}

/** 棋盘类：报胜负 + 难度，后端按 胜3/负1/平0 × 难度倍数 累加 */
export function reportBoardResult(game, outcome, difficulty) {
  /* 平局 0 分，直接不必上报 */
  if (outcome !== 'wins' && outcome !== 'losses') return Promise.resolve(null)
  const level = difficulty === 'easy' || difficulty === 'hard' ? difficulty : 'medium'
  return send({ game, outcome, difficulty: level })
}
