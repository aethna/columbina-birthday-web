/**
 * 庆功宴：所有委托都完成之后，林间空地换成的「围桌庆祝」形态。
 *
 * ★ 本文件由 tools/prep-celebration.py 生成，不要手改。
 *   要调整桌子大小 / 座位位置 / 主角主位，改那个脚本再重跑：
 *       python tools/prep-celebration.py
 *
 * 设计要点（对应用户 2026-10-07 的需求）：
 *   - 桌子在中间，14 位 NPC 围着桌子坐；
 *   - 远排（front，面向镜头）画在桌子【之前】，让桌面盖住他们的腰，
 *     看起来才是「坐在桌边」而不是「站在桌子后面」；
 *   - 近排（back，背对镜头）画在桌子【之后】；
 *   - 哥伦比娅不坐，站在主位 (1252,622)：左边两位旅行者、右边桑多涅；
 *   - 整坨（桌子 + 14 位坐姿）摆在空地正中，上下左右都留出 >=2 格的行走通道；
 *   - 桌子与每个坐姿模型【实际压住的所有格子】都变成禁行区，
 *     不只是落点格 —— 否则哥伦比娅会走到 NPC 的模型上。
 */

/** 桌子：贴图 + 左上角 + 显示尺寸 */
export const PARTY_TABLE = {
  tex: 'assets/celebration/banquet-table.png',
  x: 555, y: 512, w: 1450, h: 456, depth: 450,
};

/** 14 位围坐的 NPC（id 对应 config.js 的 NPCS） */
export const PARTY_SEATS = [
  { id: 'ainuo', dir: 'front', x: 700, y: 622, h: 120, depth: 400, tex: 'assets/celebration/sit-ainuo-front.png' },
  { id: 'traveler', dir: 'front', x: 900, y: 622, h: 172, depth: 400, tex: 'assets/celebration/sit-traveler-front.png' },
  { id: 'aether', dir: 'front', x: 1100, y: 622, h: 172, depth: 400, tex: 'assets/celebration/sit-aether-front.png' },
  { id: 'sandrone', dir: 'front', x: 1404, y: 622, h: 172, depth: 400, tex: 'assets/celebration/sit-sandrone-front.png' },
  { id: 'lyney', dir: 'front', x: 1576, y: 622, h: 172, depth: 400, tex: 'assets/celebration/sit-lyney-front.png' },
  { id: 'lynette', dir: 'front', x: 1748, y: 622, h: 172, depth: 400, tex: 'assets/celebration/sit-lynette-front.png' },
  { id: 'nefer', dir: 'front', x: 1920, y: 622, h: 172, depth: 400, tex: 'assets/celebration/sit-nefer-front.png' },
  { id: 'neuvillette', dir: 'back', x: 700, y: 1002, h: 172, depth: 460, tex: 'assets/celebration/sit-neuvillette-back.png' },
  { id: 'furina', dir: 'back', x: 900, y: 1002, h: 172, depth: 460, tex: 'assets/celebration/sit-furina-back.png' },
  { id: 'arlecchino', dir: 'back', x: 1100, y: 1002, h: 172, depth: 460, tex: 'assets/celebration/sit-arlecchino-back.png' },
  { id: 'philins', dir: 'back', x: 1404, y: 1002, h: 172, depth: 460, tex: 'assets/celebration/sit-philins-back.png' },
  { id: 'lawuma', dir: 'back', x: 1576, y: 1002, h: 172, depth: 460, tex: 'assets/celebration/sit-lawuma-back.png' },
  { id: 'freminet', dir: 'back', x: 1748, y: 1002, h: 172, depth: 460, tex: 'assets/celebration/sit-freminet-back.png' },
  { id: 'ineffa', dir: 'back', x: 1920, y: 1002, h: 172, depth: 460, tex: 'assets/celebration/sit-ineffa-back.png' },
];

/** 主角站立的主位（不坐下）—— 深度夹在远排(400)与桌子(450)之间，
 *  所以桌子（含向上探出的月亮蛋糕）会盖住她的下半身，只露上半身。
 *  用户原话：「下半身会被桌子挡住，上半身露出……如果她的图层在桌子上面，就会变成她踩在桌子上」 */
export const PARTY_HERO = { x: 1252, y: 622, h: 192, depth: 430 };

/** 主角影子在庆祝态下的深度：必须在桌子(450)之下，否则桌面上会糊一个黑椭圆 */
export const PARTY_SHADOW_DEPTH = 425;

/** 庆祝态下新增的禁行格：[格子x0, 格子y0, 格子x1, 格子y1]（含头含尾） */
export const PARTY_BLOCKS = [
  [10, 7, 11, 7],
  [13, 7, 14, 7],
  [16, 7, 18, 7],
  [21, 7, 27, 7],
  [29, 7, 30, 7],
  [8, 8, 18, 8],
  [20, 8, 31, 8],
  [8, 9, 18, 9],
  [20, 9, 31, 9],
  [8, 10, 31, 10],
  [8, 11, 31, 11],
  [8, 12, 31, 12],
  [8, 13, 31, 13],
  [8, 14, 31, 14],
  [8, 15, 31, 15],
];

/**
 * 判断「所有委托都完成了没」。
 * 用 snapshot() 而不是写死任务清单 —— 用户还会继续往里加委托，
 * 这样加完自动生效，不用回来改这里。
 *
 * ★ afterParty 的任务要排除在外（2026-10-08 加的「切蛋糕」）：
 *   那条任务本身就是「庆功宴开了才出现」的，如果算进这个判定，
 *   它会一直停在 active，围桌就永远开不起来了。
 *
 * 优先走 QuestSystem.allDone()：它是直接扫 QUESTS 的，
 * 不经过 snapshot()。而 snapshot() 反过来要问「庆功宴开没开」来决定
 * 要不要列出切蛋糕那条 —— 走 snapshot 会绕成死递归。
 */
export function isPartyTime(quests) {
  if (!quests) return false;
  if (typeof quests.allDone === 'function') return quests.allDone();
  if (typeof quests.snapshot !== 'function') return false;
  const all = quests.snapshot().filter((q) => !q.afterParty);
  if (!all.length) return false;
  return all.every((q) => q.state === 'completed');
}
