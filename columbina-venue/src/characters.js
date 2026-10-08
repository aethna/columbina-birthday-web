/**
 * 角色素材系统
 *
 * 支持两种角色形象，通过配置切换：
 *
 *   A. 立绘模式（sprite）—— 一张图，不走路，适合 NPC
 *      配置：sprite: 'assets/chars/xxx.png'
 *      效果：静止站立 + 轻微呼吸浮动
 *
 *   B. 行走图模式（sheet）—— 4×4 雪碧图，4 方向走路动画，适合主角
 *      配置：sheet: 'assets/chars/xxx.png'
 *      规格：4 行 × 4 列，行序=下/左/右/上，每帧 48×64
 *
 *   C. 占位模式 —— 上面都没配，用代码画的火柴人
 *
 * 换成真素材时只要填配置，这个文件一般不用动。
 */

import { PLAYER } from './config.js';

// 行走图规格（和主流免费素材一致，方便直接套用）
// ROWS = 8：占位火柴人也按 8 方向出图，和 DIRS 对齐（斜向行沿用 right 的朝向画）
const FRAME_W = 48;
const FRAME_H = 64;
const ROWS = 8;
const COLS = 4;

// ---------------------------------------------------------------------------
// ★ 每个方向的帧数可以不一样（v2 雪碧图）
//
// 为什么需要：
//   走路不是 4 帧能做出来的 —— 逐帧 img2img 只能还原源图里存在的腿姿数，
//   而我们的 3D 源图每个方向只有 2 个（腿分开 / 腿并拢），所以 4 帧走路
//   看起来是「两条腿在抖」。正解是图生视频后抽帧，一个真实迈步循环要 8 帧。
//   于是雪碧图变成：down 4 帧、left 8 帧、right 8 帧、up 4 帧。
//
//   Phaser 的 spritesheet 是等宽高矩形网格，每格尺寸一致就没问题 ——
//   真正的约束在【动画注册】这一层：不能再用写死的 COLS 去算帧号。
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ★ 8 方向（2026-10-06 加斜向行走）
//
//   数组下标 = 行号 = 雪碧图里的第几行，**必须和 tools/build-hero-sheet2.py
//   的 ROWS 顺序逐字对应**，改一边就要改另一边。
//
//   为什么用连写（downright 而不是 down-right）：
//     VenueScene.safePlay() 用 `suffix.split('-')[1]` 取方向名，
//     方向名里再出现横线就会被截断。
//
//   前 4 向 = 旧素材，后 4 向 = 2026-10-06 用制图 AI 新做的 45° 斜向素材。
// ---------------------------------------------------------------------------
export const DIRS = [
  'down', 'left', 'right', 'up',
  'downright', 'downleft', 'upright', 'upleft',
];

export const DIR_ROW = DIRS.reduce((m, d, i) => { m[d] = i; return m; }, {});

const DEFAULT_FRAMES_PER_DIR = DIRS.reduce((m, d) => { m[d] = COLS; return m; }, {});

/** 取某个方向的帧数（没配就回落到 4） */
export function framesOf(info, dir) {
  const map = (info && info.framesPerDir) || DEFAULT_FRAMES_PER_DIR;
  return map[dir] || COLS;
}

// 列数 = 所有方向里最多的那个（雪碧图宽度按它算）
export function colsOf(framesPerDir) {
  const map = framesPerDir || DEFAULT_FRAMES_PER_DIR;
  return Math.max(...DIRS.map((d) => map[d] || COLS));
}

// ---------------------------------------------------------------------------
// 立绘加载
// ---------------------------------------------------------------------------
/**
 * 在 preload 阶段调用，加载所有立绘
 * @param {Phaser.Scene} scene
 * @param {Array} chars 角色配置数组（每个含 sprite 或 sheet 字段）
 */
export function preloadCharacters(scene, chars) {
  chars.forEach((c) => {
    const key = `char-${c.id}`;

    if (c.sheet) {
      // 行走图：按网格切分
      // 注意：优先用配置里的 frameWidth/frameHeight，
      // 因为不同素材的帧尺寸可能不同（主角的渲染帧就和占位图不一样）
      scene.load.spritesheet(key, c.sheet, {
        frameWidth: c.frameWidth || c.frameW || FRAME_W,
        frameHeight: c.frameHeight || c.frameH || FRAME_H,
      });
    } else if (c.sprite) {
      // 立绘：整张图
      scene.load.image(key, c.sprite);
    }
    // 都没配 → 不加载，后面用占位火柴人
  });
}

// ---------------------------------------------------------------------------
// 处理已加载的立绘
// ---------------------------------------------------------------------------
/**
 * 在 create 阶段调用
 * @returns {Object} 每个角色最终使用的纹理名和模式
 */
export function setupCharacters(scene, chars) {
  const result = {};

  chars.forEach((c) => {
    const key = `char-${c.id}`;
    const loaded = scene.textures.exists(key) && scene.textures.get(key).key !== '__MISSING';

    if (!loaded) {
      // 没素材 → 占位火柴人
      const phKey = `ph-${c.id}`;
      createPlaceholderSheet(scene, phKey, c.color || 0xa0c0e0);
      result[c.id] = { mode: 'placeholder', key: phKey, dir: 'down' };
      return;
    }

    if (c.sheet) {
      // 行走图：注册 8 个动画
      const framesPerDir = c.framesPerDir || DEFAULT_FRAMES_PER_DIR;
      registerWalkAnims(scene, key, framesPerDir);
      // 把帧尺寸带出去，创建精灵时要按它算缩放
      const tex = scene.textures.get(key);
      const srcImg = tex.getSourceImage();
      const frameW = c.frameWidth || FRAME_W;
      const frameH = c.frameHeight || FRAME_H;
      result[c.id] = {
        mode: 'sheet',
        key,
        dir: 'down',
        frameWidth: frameW,
        frameHeight: frameH,
        framesPerDir,
        cols: colsOf(framesPerDir),
        // 顺便记下整张图的尺寸，便于排查
        sheetWidth: srcImg ? srcImg.width : 0,
        sheetHeight: srcImg ? srcImg.height : 0,
      };
    } else {
      // 立绘：什么都不用注册，直接用
      result[c.id] = { mode: 'sprite', key, dir: 'down' };
    }
  });

  return result;
}

// ---------------------------------------------------------------------------
// 创建角色精灵（统一入口，屏蔽两种模式的差异）
// ---------------------------------------------------------------------------
/**
 * @param {Phaser.Scene} scene
 * @param {Object} info setupCharacters 返回的信息
 * @param {number} x
 * @param {number} y
 * @param {Object} opts { displayHeight } 立绘显示高度
 */
export function createCharSprite(scene, info, x, y, opts = {}) {
  if (info.mode === 'sheet') {
    const s = scene.add.sprite(x, y, info.key);

    // 行走图：按目标显示高度缩放
    // 帧高度从 info 里读（拼图脚本输出时记录下来）
    const targetH = opts.displayHeight || 224;
    const frameH = info.frameHeight || 336;
    s.setScale(targetH / frameH);

    // 锚点放在脚底：这样角色"站"在地面上，而不是以中心为基准浮着
    s.setOrigin(0.5, 1);

    s.play(`${info.key}-idle-down`);
    return s;
  }

  if (info.mode === 'sprite') {
    // 立绘：按目标高度缩放
    const s = scene.add.sprite(x, y, info.key);
    s.setOrigin(0.5, 0.85);   // 锚点在脚部附近，站位更自然

    const targetH = opts.displayHeight || 150;
    const src = scene.textures.get(info.key).getSourceImage();
    if (src && src.height) {
      s.setScale(targetH / src.height);
    }

    // 轻微的呼吸浮动，让静态立绘不显得死板
    scene.tweens.add({
      targets: s,
      y: y - 3,
      duration: 1600,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.inOut',
    });

    return s;
  }

  // 占位火柴人
  const s = scene.add.sprite(x, y, info.key);
  s.play(`${info.key}-idle-down`);
  return s;
}

/** 切换朝向（只对行走图模式有效） */
export function setCharDir(sprite, info, dir) {
  if (info.mode === 'sheet') {
    info.dir = dir;
    sprite.play(`${info.key}-idle-${dir}`, true);
  }
}

/** 播放走路（只对行走图模式有效） */
export function setCharWalk(sprite, info, dir) {
  if (info.mode === 'sheet') {
    info.dir = dir;
    sprite.play(`${info.key}-walk-${dir}`, true);
  }
}

// ---------------------------------------------------------------------------
// 行走图动画注册
// ---------------------------------------------------------------------------
/**
 * @param {Phaser.Scene} scene
 * @param {string} key  纹理名
 * @param {Object} framesPerDir 每方向帧数，如 {down:4,left:8,right:8,up:4}
 *
 * ★ 帧号算法变了（v2）：
 *   旧：first = row * COLS，然后取 first..first+3 —— COLS 固定 4。
 *   新：first = row * COLS_MAX，取 first..first+(该方向帧数-1)。
 *       COLS_MAX 是所有方向里最大的帧数（因为雪碧图每行等宽）。
 *   down / up 只有 4 帧但行宽是 8，多出来的 4 格在拼图时是循环复制的，
 *   这里只取真正有内容的那几帧就行 —— 取多了只是重复播放，不影响正确性。
 */
function registerWalkAnims(scene, key, framesPerDir) {
  const dirs = DIRS;
  const cols = colsOf(framesPerDir);

  dirs.forEach((dir) => {
    const row = DIR_ROW[dir];
    const first = row * cols;
    const n = (framesPerDir && framesPerDir[dir]) || COLS;

    const walkKey = `${key}-walk-${dir}`;
    const idleKey = `${key}-idle-${dir}`;

    if (!scene.anims.exists(walkKey)) {
      scene.anims.create({
        key: walkKey,
        frames: Array.from({ length: n }, (_, i) => ({ key, frame: first + i })),
        // frameRate 这里只是【初始占位值】。
        // 真正的帧率由 VenueScene.safePlay() 按「移动速度 ÷ 循环距离 × 帧数」
        // 动态算出来并重建动画 —— 这样角色跑得快腿就迈得快，不会脚底打滑。
        // 所以改速度手感要去调 VenueScene 里的 WALK_CYCLE_FACTOR，
        // 改这里的 8 是没有效果的。
        frameRate: 8,
        repeat: -1,
      });
    }

    if (!scene.anims.exists(idleKey)) {
      scene.anims.create({
        key: idleKey,
        frames: [{ key, frame: first }],
        frameRate: 1,
        repeat: -1,
      });
    }
  });
}

// ---------------------------------------------------------------------------
// 占位火柴人（代码绘制）
// ---------------------------------------------------------------------------
function drawStick(g, ox, oy, frame, dirRow, color) {
  const cx = ox + FRAME_W / 2;
  const bob = (frame % 2 === 1) ? -2 : 0;
  const spread = [5, 2, 5, 2][frame];

  const headR = 9;
  const bodyTop = oy + 22 + bob;
  const bodyH = 18;
  const legTop = bodyTop + bodyH;
  const legH = 18;

  g.fillStyle(color, 1);
  g.fillRect(cx - spread - 3, legTop, 6, legH);
  g.fillRect(cx + spread - 3, legTop, 6, legH);
  g.fillRect(cx - 9, bodyTop, 18, bodyH);

  g.fillStyle(0xffe0bd, 1);
  g.fillCircle(cx, oy + 14 + bob, headR);

  g.fillStyle(0x222222, 1);
  if (dirRow === DIR_ROW.down) {
    g.fillCircle(cx - 3, oy + 13 + bob, 1.6);
    g.fillCircle(cx + 3, oy + 13 + bob, 1.6);
  } else if (dirRow === DIR_ROW.up) {
    g.fillStyle(0x4a3520, 1);
    g.fillCircle(cx, oy + 12 + bob, 8);
  } else if (dirRow === DIR_ROW.left) {
    g.fillCircle(cx - 4, oy + 13 + bob, 1.6);
  } else {
    g.fillCircle(cx + 4, oy + 13 + bob, 1.6);
  }
}

export function createPlaceholderSheet(scene, key, color) {
  if (scene.textures.exists(key)) return;

  const totalW = FRAME_W * COLS;
  const totalH = FRAME_H * ROWS;

  const g = scene.make.graphics({ x: 0, y: 0, add: false });
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      drawStick(g, col * FRAME_W, row * FRAME_H, col, row, color);
    }
  }
  g.generateTexture(key, totalW, totalH);
  g.destroy();

  const tex = scene.textures.get(key);
  if (tex.frameTotal <= 1) {
    tex.add('__BASE', 0, 0, 0, totalW, totalH);
    let idx = 0;
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        tex.add(idx, 0, col * FRAME_W, row * FRAME_H, FRAME_W, FRAME_H);
        idx += 1;
      }
    }
  }

  registerWalkAnims(scene, key);
}

export function createPlayerTexture(scene) {
  createPlaceholderSheet(scene, 'player', PLAYER.color);
}

export const CHARACTER_FRAME = { w: FRAME_W, h: FRAME_H };
