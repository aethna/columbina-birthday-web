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
  dot: '◆',
};

/** 取交互点的提示符号（拿不到就用兜底菱形） */
function iconTextOf(def) {
  return (def && ICON_TEXT[def.shape]) || ICON_TEXT.dot;
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

    defs.forEach((def) => {
      const x = def.tileX * TILE_SIZE + TILE_SIZE / 2;
      const y = def.tileY * TILE_SIZE + TILE_SIZE / 2;

      // 地面标记（一个柔和的光圈，提示这里可以交互）
      const marker = this.scene.add.circle(x, y, 24, 0xffd97a, 0.13)
        .setDepth(2);

      // 图标
      //
      // 为什么不用 emoji（✍️ 📮 🐟 这类）：
      //   emoji 依赖系统字体，在没有该字体的环境里会渲染成「豆腐块」白方块，
      //   而且大小和位置不好控制。
      //   这里改成用代码画：一个圆底 + 一个简单符号，任何环境都一样。
      const icon = this.makeIcon(x, y - 26, def);

      // 名字（只在靠近时显示，平时不显示以免画面杂乱）
      const labelObj = this.scene.add.text(x, y + 24, def.label, {
        fontFamily: 'system-ui, "Microsoft YaHei", sans-serif',
        fontSize: '12px',
        color: '#ffe9b8',
        backgroundColor: '#000000aa',
        padding: { x: 6, y: 2 },
      }).setOrigin(0.5).setDepth(9000).setVisible(false);

      // 轻微上下浮动，让静物有点生气
      this.scene.tweens.add({
        targets: icon,
        y: y - 30,
        duration: 1400,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.inOut',
      });

      this.points.push({ ...def, x, y, marker, icon, iconText: iconTextOf(def), labelObj });
    });
  }

  /**
   * 画一个交互点图标（不依赖 emoji 字体）
   *
   * 做法：半径 13 的圆底 + 中间一个小符号。
   * 符号用 shape 代号，没有对应形状就用一个小菱形兜底。
   */
  makeIcon(x, y, def) {
    const g = this.scene.add.graphics().setDepth(9000);

    // 圆底
    g.fillStyle(0x2a2018, 0.72);
    g.fillCircle(0, 0, 13);
    g.lineStyle(2, 0xffd97a, 0.95);
    g.strokeCircle(0, 0, 13);

    // 符号
    g.fillStyle(0xffe9b8, 1);
    const s = def.shape || 'dot';
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
      if (nearest) nearest.labelObj.setVisible(true);
      this.active = nearest;
    }

    // 可交互的点做呼吸效果
    this.points.forEach((p) => {
      if (this.isQuestDone(p)) return;   // 已完成的点不参与呼吸
      const avail = this.isAvailable(p);
      p.marker.setAlpha(avail ? (p === this.active ? 0.3 : 0.14) : 0.05);
    });

    return this.active;
  }

  /** 判断交互点的前置条件是否满足 */
  isAvailable(p) {
    if (!p.requires) return true;

    switch (p.requires) {
      // ★ 'notAllWritten'（书桌写信）已随「去掉写信环节」一并删除。

      case 'hasLettersOnDesk':
        // 桌上有写好的信 → 可以拿走
        return this.story.onDeskCount > 0;

      case 'allWrittenNotDelivered':
        // 信都拿在身上、还没投递 → 信箱可交互
        return this.story.allWritten
          && this.story.carriedCount > 0
          && !this.story.isDelivered;

      default:
        return true;
    }
  }

  /**
   * 触发当前交互点
   * @returns {Object|null} 触发结果 { type, data }
   */
  trigger() {
    const p = this.active;
    if (!p || !this.isAvailable(p)) return null;

    switch (p.action) {
      // ★ 'writeLetter'（书桌写信）已随「去掉写信环节」一并删除。

      case 'takeLetters': {
        const n = this.story.takeLetters();
        return { type: 'takeLetters', ok: n > 0, count: n };
      }

      case 'deliver': {
        const ok = this.story.deliverLetters();
        return { type: 'deliver', ok };
      }

      default:
        return { type: 'none', point: p };
    }
  }
}
