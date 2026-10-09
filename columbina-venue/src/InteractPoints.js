/**
 * 交互点系统
 *
 * 场景里的「走到附近按 E」的功能点：
 *   - 书桌：写邀请函
 *   - 信箱：投递邀请函
 *   - 池塘水边、花丛等：任务目标（只是看看）
 *
 * 与 NPC 的区别：
 *   NPC 是活的角色，有对话；
 *   交互点是静物，按 E 直接执行动作。
 */

import { TILE_SIZE } from './config.js';
import { INTERACT_POINTS } from './quests.js';
import { isPartyTime } from './celebration.js';

/**
 * 交互点图标 / 文字气泡的绘制层级
 *
 * 需求（2026-10-08 第七轮）：「所有互动点图层改为地图之上，哥伦比娅之下。」
 *
 * 原来这里写死 9000（和 UI 同一层），结果哥伦比娅走到点位上时，
 * 图标和文字会压在她头顶上，看起来像她把图标顶在头上。
 *
 * 420 是照各层深度夹出来的，不是拍的：
 *     0        场景背景（地图）        —— 在它之上 ✅
 *     2        地面光圈 marker         —— 同层之上
 *     300+     NPC（300 + y*0.001）    —— 在它之上
 *     400      庆功宴远排坐姿           —— 在它之上
 *     425      庆功宴主位影子           —— 在它之上
 *     430      庆功宴主位的哥伦比娅     —— 在它之下 ✅
 *     450      庆功宴大桌子             —— 在它之下（桌子挡人，不挡图标会穿帮）
 *     500+     平时行走的哥伦比娅       —— 在它之下 ✅
 */
export const INTERACT_ICON_DEPTH = 420;

/** 地面光圈：贴着地面画，在所有角色之下 */
export const MARKER_DEPTH = 2;

/** 图标 / 文字相对落点的默认偏移（向上为负） */
const ICON_DY = -26;
const LABEL_DY = 24;

/** 上下浮动动画的目标偏移 */
const ICON_FLOAT_DY = -30;

// ---------------------------------------------------------------------------
// 交互点符号 -> 提示文字用的字符
//
// ★ 为什么需要这个映射（修 [object Object] 的根因）：
//   提示条原来是 `${pointActive.icon} ${pointActive.label}` 这样拼的，
//   但 `icon` 是 makeIcon() 返回的 **Phaser.Graphics 对象**，不是字符串。
//   模板字符串把对象转成 "[object Object]"，
//   于是提示变成了「[object Object] 花丛」。
//
//   NPC 那条提示没这个问题，因为 NPC 用的是 `iconText`（本来就是字符串）。
//   这里补上同样的字段，命名也统一叫 iconText，两边一致。
// ---------------------------------------------------------------------------
const ICON_TEXT = {
  drop: '💧',
  fish: '🐟',
  flower: '🌸',
  mushroom: '🍄',
  wood: '🪵',
  letter: '✉',
  mailbox: '📮',
  pen: '✎',
  cake: '🎂',
  dot: '◆',
};

/** 取交互点的提示符号（拿不到就用兜底菱形） */
function iconTextOf(shape) {
  return ICON_TEXT[shape] || ICON_TEXT.dot;
}

/**
 * 求值交互点字段
 *
 * label / hint / shape / requires 都可以写成 (story) => ... 的函数
 * （书桌那个点就是如此：写完了就变成「桌上的邀请函」，图标从笔换成信封）。
 * 不是函数就原样返回。
 */
function resolve(value, story) {
  return typeof value === 'function' ? value(story) : value;
}

export default class InteractPointSystem {
  /**
   * @param {Phaser.Scene} scene
   * @param {StorySystem} story
   */
  constructor(scene, story, quests) {
    this.scene = scene;
    this.story = story;
    this.quests = quests || null;   // 任务系统（用来判断委托是否已完成）
    this.points = [];      // 当前场景的交互点（运行时对象）
    this.active = null;    // 玩家当前靠近的那个
  }

  /**
   * 这个交互点对应的委托是否已经完成
   *
   * 用途：委托做完之后，地图上那个点位就该消失 ——
   * 不然玩家会一直看到一个"没用的图标"，以为是漏了什么东西。
   */
  isQuestDone(p) {
    if (!p.questId || !this.quests) return false;
    try {
      return this.quests.getStateById
        ? this.quests.getStateById(p.questId) === 'completed'
        : false;
    } catch {
      return false;
    }
  }

  /** 场景切换时重建 */
  rebuild(sceneId) {
    // 清掉旧的
    this.points.forEach((p) => {
      if (p.marker) p.marker.destroy();
      if (p.icon) p.icon.destroy();
      if (p.labelObj) p.labelObj.destroy();
    });
    this.points = [];
    this.active = null;

    const defs = INTERACT_POINTS.filter((d) => d.scene === sceneId);
    const story = this.story;   // 下面的 getter 要闭包用到

    defs.forEach((def) => {
      // ★ hideWhenUnavailable：前置条件不满足时【连这个点都不建】
      //
      //   默认行为（见 update()）是把 marker 压暗到 0.06，表示"这里以后有用" ——
      //   信箱就适合这种。但书桌在 11 封写完之后是彻底没用了，
      //   留一个暗图标 + 暗 marker 会让玩家以为还能按 E，按下去却没反应，
      //   正是用户 2026-10-04 反馈的那类卡顿。这类点直接不出现。
      if (def.hideWhenUnavailable && !this.requiresMet(def.requires)) return;

      const x = def.tileX * TILE_SIZE + TILE_SIZE / 2;
      const y = def.tileY * TILE_SIZE + TILE_SIZE / 2;

      // 图标 / 文字相对落点的偏移，可按点位覆盖
      //   （切蛋糕那个点落在庆功宴桌沿上，文字得抬到桌面之上才看得见）
      const iconDy = def.iconDy ?? ICON_DY;
      const labelDy = def.labelDy ?? LABEL_DY;

      // 地面标记（一个柔和的光圈，提示这里可以交互）
      const marker = this.scene.add.circle(x, y, 24, 0xffd97a, 0.13)
        .setDepth(MARKER_DEPTH);

      // 图标
      //
      // 为什么不用 emoji（✍️ 📮 🐟 这类）：
      //   emoji 依赖系统字体，在没有该字体的环境里会渲染成「豆腐块」白方块，
      //   而且大小和位置不好控制。
      //   这里改成用代码画：一个圆底 + 一个简单符号，任何环境都一样。
      const icon = this.makeIcon(x, y + iconDy, resolve(def.shape, this.story), def.iconDepth);

      // 名字（只在靠近时显示，平时不显示以免画面杂乱）
      const labelObj = this.scene.add.text(x, y + labelDy, resolve(def.label, this.story), {
        fontFamily: 'system-ui, "Microsoft YaHei", sans-serif',
        fontSize: '12px',
        color: '#ffe9b8',
        backgroundColor: '#000000aa',
        padding: { x: 6, y: 2 },
      }).setOrigin(0.5).setDepth(def.labelDepth || INTERACT_ICON_DEPTH).setVisible(false);

      // 轻微上下浮动，让静物有点生气
      this.scene.tweens.add({
        targets: icon,
        y: y + iconDy - 4,
        duration: 1400,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.inOut',
      });

      this.points.push({
        ...def,
        x,
        y,
        marker,
        icon,
        labelObj,
        // label / hint / iconText 用 getter 实时求值 ——
        // 书桌那一个点在「没写完 / 写完了」两种状态下显示的文字不一样，
        // 用 getter 就不必每次剧情推进都重建整个交互点（重建会打断浮动动画）。
        get labelText() { return resolve(def.label, story) || ''; },
        get hintText() { return resolve(def.hint, story) || ''; },
        get iconText() { return iconTextOf(resolve(def.shape, story)); },
      });
    });
  }

  /**
   * 画一个交互点图标（不依赖 emoji 字体）
   *
   * 做法：半径 13 的圆底 + 中间一个小符号。
   * 符号用 shape 代号，没有对应形状就用一个小菱形兜底。
   * @param {string} s 已经求值过的 shape 代号
   * @param {number} [depth] 该点单独的图层；不传就用全局 INTERACT_ICON_DEPTH
   */
  makeIcon(x, y, s, depth) {
    const g = this.scene.add.graphics().setDepth(depth || INTERACT_ICON_DEPTH);

    // 圆底
    g.fillStyle(0x2a2018, 0.72);
    g.fillCircle(0, 0, 13);
    g.lineStyle(2, 0xffd97a, 0.95);
    g.strokeCircle(0, 0, 13);

    // 符号
    g.fillStyle(0xffe9b8, 1);
    s = s || 'dot';
    if (s === 'drop') {
      g.fillCircle(0, 2, 4.5);
      g.fillTriangle(-4.6, 1.5, 4.6, 1.5, 0, -7);
    } else if (s === 'fish') {
      g.fillEllipse(0, 0, 15, 8);
      g.fillTriangle(6, 0, 11, -4.5, 11, 4.5);
    } else if (s === 'flower') {
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
        g.fillCircle(Math.cos(a) * 4.5, Math.sin(a) * 4.5, 3);
      }
      g.fillStyle(0xffb84d, 1);
      g.fillCircle(0, 0, 2.6);
    } else if (s === 'mushroom') {
      g.fillEllipse(0, -2, 15, 9);
      g.fillRect(-2.2, 0, 4.4, 7);
    } else if (s === 'wood') {
      g.fillRoundedRect(-7, -2.5, 14, 5, 2.5);
      g.fillRoundedRect(-6, 2, 12, 4, 2);
    } else if (s === 'letter') {
      g.fillRoundedRect(-7, -5, 14, 10, 2);
      g.lineStyle(1.6, 0x2a2018, 1);
      g.beginPath();
      g.moveTo(-7, -5); g.lineTo(0, 1); g.lineTo(7, -5);
      g.strokePath();
    } else if (s === 'mailbox') {
      g.fillRoundedRect(-7, -4, 14, 8, 2);
      g.fillRect(-1.2, 4, 2.4, 4);
      g.fillStyle(0xff7a5c, 1);
      g.fillTriangle(6, -3, 6, 1, 11, -1);
    } else if (s === 'pen') {
      g.fillTriangle(-6, 6, -2, -6, 2, -6);
      g.fillRect(-2, -8, 4, 3);
    } else if (s === 'cake') {
      // 生日蛋糕：两层奶油 + 一根点燃的蜡烛
      g.fillStyle(0xffe9b8, 1);
      g.fillRect(-7, 0, 14, 6);
      g.fillRect(-5, -5, 10, 5);
      g.fillStyle(0xff7a5c, 1);
      g.fillRect(-1, -10, 2, 5);
      g.fillStyle(0xffe066, 1);
      g.fillCircle(0, -12, 2.2);
    } else {
      // 兜底：菱形
      g.fillTriangle(0, -6, 6, 0, 0, 6);
      g.fillTriangle(0, -6, -6, 0, 0, 6);
    }

    g.setPosition(x, y);
    return g;
  }

  /**
   * 检查玩家是否靠近某个交互点
   * @returns {Object|null} 当前可交互的点
   */
  update(playerX, playerY, radius = 68) {
    let nearest = null;
    let nd = Infinity;

    for (const p of this.points) {
      // ★ 委托已完成 -> 整个点位从地图上消失
      if (this.isQuestDone(p)) {
        p.labelObj.setVisible(false);
        p.marker.setVisible(false);
        if (p.icon) p.icon.setVisible(false);
        continue;
      }

      // 判断这个点当前是否可交互（前置条件是否满足）
      if (!this.isAvailable(p)) {
        p.labelObj.setVisible(false);
        // 条件不满足（还没到时候）只是压暗，不是隐藏 —— 让玩家知道"这里以后有用"
        p.marker.setVisible(true);
        if (p.icon) p.icon.setVisible(true);
        p.marker.setAlpha(0.06);
        continue;
      }

      // 正常显示
      p.marker.setVisible(true);
      if (p.icon) p.icon.setVisible(true);

      const d = Phaser.Math.Distance.Between(playerX, playerY, p.x, p.y);
      if (d < radius && d < nd) {
        nearest = p;
        nd = d;
      }
    }

    if (nearest !== this.active) {
      this.points.forEach((p) => p.labelObj.setVisible(false));
      if (nearest) {
        // 标签文字可能随剧情变了（书桌：书桌 -> 桌上的邀请函），显示前重新取一次
        nearest.labelObj.setText(nearest.labelText);
        nearest.labelObj.setVisible(true);
      }
      this.active = nearest;
    }

    // 可交互的点做呼吸效果
    this.points.forEach((p) => {
      if (this.isQuestDone(p)) return;   // 已完成的点不参与呼吸
      // ★ 没接委托的采集点：点亮但压暗（用 isQuestAccepted，不是 isAvailable）
      //   这样它仍然可以被选中、按 E 会给出「请先去找 XX 接委托」的解释，
      //   而不是像 requires 不满足那样直接变成一块没法按的暗斑。
      const avail = this.isAvailable(p) && this.isQuestAccepted(p);
      p.marker.setAlpha(avail ? (p === this.active ? 0.3 : 0.14) : 0.05);
    });

    return this.active;
  }

  /**
   * 委托类交互点：对应的委托接过没有
   *
   * ★ 为什么需要它（用户 2026-10-05 反馈的 bug）：
   *   5 个采集点（池塘捉鱼 / 打水 / 采花 / 采蘑菇 / 捡柴）挂在委托上，
   *   但原来没有任何"得先接委托"的约束 —— 玩家路过就能把鱼捞走。
   *   捞到之后 `QuestSystem.markCollect()` 因为任务还不是 active 而拒绝计数，
   *   等玩家回头接了委托，任务永远差 1 个，**再也做不完**。
   *
   *   现在：没接委托 → trigger() 直接回 needQuest，VenueScene 弹提示，
   *   玩家得先找到发布人接任务，采集点才开始产出。
   *
   * 没有 questId 的点（书桌 / 信箱两条主线）不受影响，永远算「已接受」。
   */
  isQuestAccepted(p) {
    if (!p || !p.questId) return true;
    if (!this.quests || !this.quests.getStateById) return true;
    try {
      const st = this.quests.getStateById(p.questId);
      // completed 也放行：委托交完后再来按一次，应该给「已经拿到了」而不是「去接委托」
      return st === 'active' || st === 'ready' || st === 'completed';
    } catch {
      return true;
    }
  }

  /**
   * 前置条件是否满足
   *
   * 只吃 requires 本身（不需要点位对象），因为 rebuild() 要在建 UI 之前就问一次：
   * 见下面 hideWhenUnavailable 的处理。
   */
  requiresMet(requires) {
    if (!requires) return true;

    // 函数式前置条件（书桌：还没写完）
    if (typeof requires === 'function') {
      try {
        return !!requires(this.story);
      } catch {
        return false;
      }
    }

    switch (requires) {
      case 'hasLettersOnDesk':
        // 桌上有写好的信 → 可以拿走（v5 起正常流程不会再有这个状态，留给老存档）
        return this.story.onDeskCount > 0;

      case 'allWrittenNotDelivered':
        // 11 封都写好、还没投递 → 信箱可交互。
        // ★ 这里【不再】要求 carriedCount > 0：v5 起信在写信过场收尾时就进了 carried，
        //   但老存档可能还压在桌上，那种情况下 deliverLetters() 会顺手扫一遍。
        //   要求 carried>0 会让玩家站在信箱前既没提示也按不动（2026-10-04 反馈的问题4）。
        return this.story.allWritten && !this.story.isDelivered;

      case 'partyTime':
        // 切蛋糕：只有庆功宴（所有委托做完）开了才存在。
        //   直接复用 celebration.js 的那份判定，保证「什么时候开围桌」
        //   和「什么时候能切蛋糕」永远是同一个条件，两边不会走偏。
        return isPartyTime(this.quests);

      default:
        return true;
    }
  }

  /** 判断交互点的前置条件是否满足 */
  isAvailable(p) {
    return this.requiresMet(p.requires);
  }

  /**
   * 触发当前交互点
   * @returns {Object|null} 触发结果 { type, data }
   */
  trigger() {
    const p = this.active;
    if (!p || !this.isAvailable(p)) return null;

    // ★ 委托没接 → 先别给东西，交给调用方弹「请去找 XX 接委托」。
    //   顺序很关键：放在 switch 之前，所以 collectItem / exchangeItem
    //   这两种"会真的往背包里塞道具"的动作都拦得住。
    if (!this.isQuestAccepted(p)) {
      return { type: 'needQuest', point: p };
    }

    switch (p.action) {
      // 书桌：写下一封 或 收起桌上的信 —— 具体走哪条由调用方（VenueScene）按剧情决定
      case 'writeOrTake':
        return { type: 'desk', point: p };

      case 'takeLetters': {
        const n = this.story.takeLetters();
        return { type: 'takeLetters', ok: n > 0, count: n };
      }

      case 'deliver': {
        const ok = this.story.deliverLetters();
        return { type: 'deliver', ok };
      }

      // 切蛋糕：全屏展示「围坐切蛋糕」那张图，具体展示逻辑在 VenueScene
      //   （这里只负责报出「玩家在主位按了 E」，不掺 UI）
      case 'cake':
        return { type: 'cake', point: p };

      default:
        return { type: 'none', point: p };
    }
  }
}
