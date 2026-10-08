/**
 * 世界地图
 *
 * 只做一张「场景连线图」，不显示背景、不做格子小地图。
 *
 * 为什么不做格子小地图：
 *   每个场景只有一个屏幕大小，玩家走两步就看全了，
 *   格子小地图没有信息量。真正需要的是「我在哪、要去哪」，
 *   一张连线图就够了。
 *
 * 显示内容：
 *   - 场景节点（圆点 + 名字）
 *   - 场景之间的通路（连线）
 *   - 当前位置（高亮）
 *   - 任务目标方向（如果目标在别的场景，那条连线会高亮）
 *
 * 按 M 开关。加新场景时自动适配。
 */

import { SCENES } from './scenes.js';

// 配色
const C = {
  bg: 0x0d1117,
  border: 0x8a6d3b,
  node: 0x4a6fa5,
  nodeCurrent: 0xffd97a,
  line: 0x3a4a63,
  lineActive: 0x9ecbff,
  text: '#e8eef8',
  textDim: '#93a8c4',
  textCurrent: '#ffd97a',
};

// 场景在地图上的排布（相对坐标 0~1）
// 10 个场景构成一个环：home → mailbox → venue → icefield → pools →
// moonpath → starship → shallows → pond → grove → home
// 所以直接按环的顺序摆成一圈。
//   x = 0.50 + 0.36·cosθ   y = 0.46 + 0.36·sinθ（θ 从正下方 home 起，每 36° 一个）
// 纵向半径压到 0.36 是为了给最底下留出图例的位置，
// 否则「窗前书桌」会和图例文字叠在一起。
const LAYOUT = {
  home:      { x: 0.500, y: 0.820 },
  mailbox:   { x: 0.288, y: 0.751 },
  venue:     { x: 0.158, y: 0.571 },
  icefield:  { x: 0.158, y: 0.349 },
  pools:     { x: 0.288, y: 0.169 },
  moonpath:  { x: 0.500, y: 0.100 },
  starship:  { x: 0.712, y: 0.169 },
  shallows:  { x: 0.842, y: 0.349 },
  pond:      { x: 0.842, y: 0.571 },
  grove:     { x: 0.712, y: 0.751 },
};

export default class Minimap {
  constructor(scene) {
    this.scene = scene;
    this.visible = false;

    // 10 个场景排成一圈之后，260x300 会让最下面那排名字互相压住，
    // 所以面板整体放大一档（320x340）
    this.panelW = 320;
    this.panelH = 340;

    this.build();
  }

  build() {
    const scene = this.scene;

    this.container = scene.add.container(0, 0)
      .setScrollFactor(0)
      .setDepth(20000)
      .setVisible(false);

    // 半透明底板
    this.bg = scene.add.rectangle(0, 0, this.panelW, this.panelH, C.bg, 0.92)
      .setOrigin(0.5)
      .setStrokeStyle(2, C.border);

    // 标题
    // 标题：加了 5 个月面场景之后就不只是「林间」了
    this.title = scene.add.text(0, 0, '世界地图', {
      fontFamily: 'system-ui, "Microsoft YaHei", sans-serif',
      fontSize: '15px',
      color: '#ffd97a',
    }).setOrigin(0.5, 0);

    // 连线与节点都画在这上面
    this.gfx = scene.add.graphics();

    // 文字标签（每次重绘时重建）
    this.labels = [];

    this.container.add([this.bg, this.gfx, this.title]);

    this.layout();
    scene.scale.on('resize', () => this.layout());
  }

  layout() {
    const w = this.scene.scale.width;
    const h = this.scene.scale.height;

    // 放在屏幕正中偏右（避开左侧的 NPC 和右侧的任务面板）
    // 注意：这里用绝对屏幕坐标，每次 layout 都重新算，
    // 否则窗口尺寸变化或场景还没布局完时位置会错。
    const x = Math.round(w / 2);
    const y = Math.round(h / 2);

    this.container.setPosition(x, y);
    this.bg.setPosition(0, 0);
    this.title.setPosition(0, -this.panelH / 2 + 12);
  }

  toggle() {
    this.visible = !this.visible;
    if (this.visible) this.layout();   // 每次打开时重新定位，避免位置错乱
    this.container.setVisible(this.visible);
    return this.visible;
  }

  /**
   * 重绘
   * @param {Object} ctx
   *   sceneId   当前场景 id
   *   guide     引导目标 { crossScene, ... }（可选，用于高亮目标方向）
   */
  draw(ctx) {
    if (!this.visible) return;

    // 清旧标签
    this.labels.forEach((t) => t.destroy());
    this.labels = [];
    this.gfx.clear();

    // 绘制区（留出标题空间）
    const areaW = this.panelW - 50;
    const areaH = this.panelH - 70;
    const areaX = -areaW / 2;
    const areaY = -areaH / 2 + 14;

    const pos = {};
    Object.entries(LAYOUT).forEach(([id, p]) => {
      pos[id] = { x: areaX + p.x * areaW, y: areaY + p.y * areaH };
    });

    const cur = ctx.sceneId;

    // 找出需要高亮的连线（当前场景 → 任务目标的出口）
    let activeTarget = null;
    if (ctx.guide && ctx.guide.crossScene) {
      const cfg = SCENES.find((s) => s.id === cur);
      if (cfg) {
        const ex = (cfg.exits || []).find((e) => {
          const tx = (e.tileX + e.w / 2) * 64;
          const ty = (e.tileY + e.h / 2) * 64;
          return Math.abs(tx - ctx.guide.x) < 40 && Math.abs(ty - ctx.guide.y) < 40;
        });
        if (ex) activeTarget = ex.to;
      }
    }

    // ---- 连线 ----
    const drawn = new Set();
    SCENES.forEach((s) => {
      (s.exits || []).forEach((ex) => {
        const key = [s.id, ex.to].sort().join('-');
        if (drawn.has(key)) return;
        drawn.add(key);

        if (!pos[s.id] || !pos[ex.to]) return;

        const isActive =
          (s.id === cur && ex.to === activeTarget) ||
          (ex.to === cur && s.id === activeTarget);

        this.gfx.lineStyle(isActive ? 3 : 2, isActive ? C.lineActive : C.line, isActive ? 1 : 0.75);

        this.gfx.beginPath();
        this.gfx.moveTo(pos[s.id].x, pos[s.id].y);
        this.gfx.lineTo(pos[ex.to].x, pos[ex.to].y);
        this.gfx.strokePath();

        // 高亮的连线加个箭头，指示方向
        if (isActive) {
          const from = s.id === cur ? pos[s.id] : pos[ex.to];
          const to = s.id === cur ? pos[ex.to] : pos[s.id];
          const ang = Math.atan2(to.y - from.y, to.x - from.x);
          const mx = (from.x + to.x) / 2;
          const my = (from.y + to.y) / 2;

          this.gfx.fillStyle(C.lineActive, 1);
          this.gfx.fillTriangle(
            mx + Math.cos(ang) * 7, my + Math.sin(ang) * 7,
            mx + Math.cos(ang + 2.5) * 6, my + Math.sin(ang + 2.5) * 6,
            mx + Math.cos(ang - 2.5) * 6, my + Math.sin(ang - 2.5) * 6
          );
        }
      });
    });

    // ---- 节点 ----
    Object.entries(pos).forEach(([id, p]) => {
      const cfg = SCENES.find((s) => s.id === id);
      if (!cfg) return;

      const isCurrent = id === cur;
      const isTarget = id === activeTarget;

      // 当前场景：外圈光晕
      if (isCurrent) {
        this.gfx.fillStyle(C.nodeCurrent, 0.25);
        this.gfx.fillCircle(p.x, p.y, 14);
      }
      // 目标场景：蓝色光晕
      if (isTarget) {
        this.gfx.fillStyle(C.lineActive, 0.22);
        this.gfx.fillCircle(p.x, p.y, 12);
      }

      // 节点本体
      this.gfx.fillStyle(isCurrent ? C.nodeCurrent : C.node, 1);
      this.gfx.fillCircle(p.x, p.y, isCurrent ? 6 : 4.5);

      // 名字
      const label = this.scene.add.text(p.x, p.y + 10, cfg.name, {
        fontFamily: 'system-ui, "Microsoft YaHei", sans-serif',
        fontSize: '11px',
        color: isCurrent ? C.textCurrent : (isTarget ? '#9ecbff' : C.textDim),
      }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(20001);

      this.container.add(label);
      this.labels.push(label);
    });

    // ---- 图例 ----
    const legend = this.scene.add.text(
      0,
      this.panelH / 2 - 24,
      '金点=当前  蓝线=任务方向    M 关闭',
      {
        fontFamily: 'system-ui, "Microsoft YaHei", sans-serif',
        fontSize: '10px',
        color: C.textDim,
      }
    ).setOrigin(0.5).setScrollFactor(0).setDepth(20001);

    this.container.add(legend);
    this.labels.push(legend);
  }
}
