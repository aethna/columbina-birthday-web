/**
 * 场景管理器 —— 负责当前显示哪个场景、以及场景之间的切换
 *
 * 设计说明：
 *   游戏里所有场景共用同一个 Phaser Scene（VenueScene），
 *   切换场景时只是「卸载当前场景的对象 → 加载新场景的对象」，
 *   而不是创建新的 Phaser Scene。
 *
 *   这样做的好处：
 *     - 玩家、对话框、任务系统等保持不变，不用重新初始化
 *     - 切换开销小
 *     - 代码只有一套
 */

import { SCENES, SCENE_MAPS, SCENE_COLS, SCENE_ROWS, SCENE_W, SCENE_H } from './scenes.js';

export default class SceneManager {
  /**
   * @param {Phaser.Scene} scene 宿主场景（VenueScene）
   */
  constructor(scene) {
    this.scene = scene;
    this.current = null;        // 当前场景配置
    this.objects = [];          // 当前场景创建的所有显示对象（切换时销毁）
    this.obstacles = null;      // 当前场景的碰撞组
    this.exits = [];            // 当前场景的出入口（运行时数据）
    this.switching = false;     // 防止切换过程中重复触发
  }

  /** 取场景配置 */
  getScene(id) {
    return SCENES.find((s) => s.id === id) || SCENES[0];
  }

  /** 取场景的可走地图 */
  getMap(id) {
    return SCENE_MAPS[id] || SCENE_MAPS[SCENES[0].id];
  }

  /**
   * 加载场景
   * @param {string} id 场景 id
   * @param {Object} arriveAt 到达位置 { tileX, tileY }（可选）
   * @param {boolean} instant 是否跳过淡入
   */
  /**
   * 校验到达坐标：非法就退回该场景的出生点
   *
   * 非法的情况：
   *   - arriveAt 是 null / 缺字段 / NaN / 越界
   *   - 落点在一个障碍格里（玩家一进去就被卡住）
   */
  sanitizeArrive(arriveAt, cfg) {
    const valid = (v) => Number.isFinite(v) && v >= 0 && v < (v < 100 ? 1e9 : 1e9);

    const okTile = (t) =>
      t && Number.isFinite(t.tileX) && Number.isFinite(t.tileY) &&
      t.tileX >= 0 && t.tileX < SCENE_COLS &&
      t.tileY >= 0 && t.tileY < SCENE_ROWS;

    const map = this.getMap(cfg.id);
    const walkable = (t) => map && map[t.tileY] && map[t.tileY][t.tileX] === '.';

    if (okTile(arriveAt) && walkable(arriveAt)) return arriveAt;

    // 落点不可走 -> 在附近找最近的可走格
    if (okTile(arriveAt)) {
      for (let r = 1; r <= 12; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const nx = arriveAt.tileX + dx, ny = arriveAt.tileY + dy;
            if (nx >= 0 && nx < SCENE_COLS && ny >= 0 && ny < SCENE_ROWS &&
                map[ny] && map[ny][nx] === '.') {
              console.warn('[场景] 落点不可走，挪到最近可走格', { from: arriveAt, to: { tileX: nx, tileY: ny } });
              return { tileX: nx, tileY: ny };
            }
          }
        }
      }
    }

    console.warn('[场景] 到达坐标非法，退回出生点', arriveAt);
    return cfg.spawn;
  }

  load(id, arriveAt = null, instant = false) {
    const cfg = this.getScene(id);
    this.current = cfg;

    // 清掉上一个场景
    this.clear();

    const scene = this.scene;

    // ---- 背景图 ----
    const bgKey = `scene-bg-${cfg.id}`;
    if (scene.textures.exists(bgKey)) {
      const src = scene.textures.get(bgKey).getSourceImage();
      const bg = scene.add.image(0, 0, bgKey).setOrigin(0, 0).setDepth(0);
      if (src && src.width) {
        // 铺满场景（背景图按场景比例生成，不会裁掉内容）
        const s = Math.max(SCENE_W / src.width, SCENE_H / src.height);
        bg.setScale(s);
      }
      this.objects.push(bg);
    } else {
      // 缺图兜底
      const bg = scene.add.rectangle(0, 0, SCENE_W, SCENE_H, 0x2a3a2a).setOrigin(0, 0).setDepth(0);
      this.objects.push(bg);
      console.warn(`场景背景图缺失: ${cfg.bg}`);
    }

    // ---- 碰撞 + 出入口 ----
    this.obstacles = scene.physics.add.staticGroup();
    const map = this.getMap(cfg.id);

    for (let ty = 0; ty < SCENE_ROWS; ty++) {
      const row = map[ty] || '';
      for (let tx = 0; tx < SCENE_COLS; tx++) {
        const ch = row[tx] || '#';
        const x = tx * 64 + 32;
        const y = ty * 64 + 32;

        if (ch !== '.') {
          // 不可走 → 隐形挡板
          const b = this.obstacles.create(x, y, undefined);
          b.setVisible(false);

          // ★ 不要在这里调 updateFromGameObject()
          //
          //   障碍是用 undefined 贴图创建的，Phaser 给它的默认尺寸是 32x32。
          //   updateFromGameObject() 会按 GameObject 的尺寸【覆盖】刚设的 setSize，
          //   结果每个障碍只剩半格大 —— 角色能挤进墙里 16px。
          //
          //   setSize(w, h) 默认会把体居中到 GameObject 上，这里正好是一整格。
          b.body.setSize(64, 64);
        }
      }
    }

    // ---- 出入口（地面光圈）----
    //
    // 参考剑侠情缘 / miu2d 的做法：切屏点不是「地图边缘」，
    // 而是摆在地图上的物件 —— 门(kind=5，阻挡) 或 陷阱(kind=6，可踩)。
    //
    // 我们采用「路尽头的地面光圈」：
    //   玩家看到光圈就知道那是出口，踩上去切场景。
    //   这比让玩家走到看不见的地图边缘去撞要好懂得多。
    this.exits = [];
    (cfg.exits || []).forEach((ex) => {
      const T = 64;

      // 出口矩形（贴边）
      const exX = ex.tileX * T;
      const exY = ex.tileY * T;
      const exW = ex.w * T;
      const exH = ex.h * T;

      const touchesLeft = exX <= 0;
      const touchesRight = exX + exW >= SCENE_W;
      const touchesTop = exY <= 0;
      const touchesBottom = exY + exH >= SCENE_H;

      // 光圈尺寸（椭圆：45 度俯视下地面上的圆看起来是扁的）
      const rx = 86;
      const ry = 44;

      // 光圈位置：先在出口中心，再往场景内侧退，
      // 保证整个椭圆在场景内、且角色站上去时整人在画面里
      let px = exX + exW / 2;
      let py = exY + exH / 2;

      const EDGE_GAP = 54;   // 椭圆边缘离地图边界留多远
      if (touchesRight)  px = SCENE_W - EDGE_GAP - rx;
      if (touchesLeft)   px = EDGE_GAP + rx;
      if (touchesTop)    py = EDGE_GAP + ry;
      if (touchesBottom) py = SCENE_H - EDGE_GAP - ry;

      // 不贴边的那条轴也限制在场景内
      px = Math.max(rx + 20, Math.min(SCENE_W - rx - 20, px));
      py = Math.max(ry + 20, Math.min(SCENE_H - ry - 20, py));

      // ---- 画光圈 ----
      //
      // ★ 要够醒目
      //   之前叠得太淡（填充只有 0.05~0.15，呼吸最低到 0.72 透明），
      //   压在花花绿绿的林地背景上几乎看不出来，
      //   用户反馈「传送圈怎么都看不到」。
      //   现在把填充和描边都提上去，并加一个向上的箭头提示方位。
      const portal = scene.add.container(px, py).setDepth(3);

      // 外发光：从外到内多层叠加
      const glow = scene.add.graphics();
      for (let i = 6; i >= 1; i--) {
        const k = i / 6;
        glow.fillStyle(0xffd45a, 0.10 + (1 - k) * 0.16);
        glow.fillEllipse(0, 0, rx * 2 * k, ry * 2 * k);
      }
      portal.add(glow);

      // 亮边 + 内圈
      const ring = scene.add.graphics();
      ring.lineStyle(6, 0xfff3c4, 1);            // 外圈：亮，粗
      ring.strokeEllipse(0, 0, rx * 2 - 6, ry * 2 - 6);
      ring.lineStyle(3, 0xffc93c, 0.95);         // 中圈：金黄
      ring.strokeEllipse(0, 0, rx * 1.42, ry * 1.42);
      ring.lineStyle(2, 0xffe9a0, 0.75);         // 内圈：淡金
      ring.strokeEllipse(0, 0, rx * 0.85, ry * 0.85);
      portal.add(ring);

      // 中心亮斑
      const core = scene.add.graphics();
      core.fillStyle(0xfffbe8, 0.72);
      core.fillEllipse(0, 0, rx * 0.5, ry * 0.5);
      portal.add(core);


      // 呼吸动画：整体缩放 + 透明度振荡
      // 透明度不要低于 0.9，否则在最暗的一拍又看不见了
      scene.tweens.add({
        targets: portal,
        scaleX: { from: 0.95, to: 1.08 },
        scaleY: { from: 0.95, to: 1.08 },
        alpha: { from: 0.9, to: 1 },
        duration: 1400,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
      // 内圈反向呼吸，增加层次（但保持高位，不要暗下去）
      scene.tweens.add({
        targets: ring,
        alpha: { from: 1, to: 0.72 },
        duration: 900,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });

      this.objects.push(portal);

      this.exits.push({
        ...ex,
        centerX: px,
        centerY: py,
        portalX: px,
        portalY: py,
        rx,
        ry,
        // 椭圆触发判定（不再是矩形）
        contains(x, y) {
          const dx = (x - px) / rx;
          const dy = (y - py) / ry;
          return dx * dx + dy * dy <= 1;
        },
        portal,
      });
    });

    // ---- 玩家位置 ----
    // ★ 落点兜底
    //
    // 为什么必须做：出口的 toTileX/toTileY 一旦缺失或非法，
    //   setPosition(NaN, NaN) 会让角色永久卡死（画不出、动不了、也碰不到出口）。
    //   与其保证数据永远不出错，不如代码能兜底。
    const target = this.sanitizeArrive(arriveAt, cfg);

    if (scene.player && target) {
      scene.player.setPosition(target.tileX * 64 + 32, target.tileY * 64 + 32);
      scene.player.setVelocity(0, 0);
      scene.player.setVisible(true);
      scene.player.setActive(true);
    }

    // ---- 通知外部（HTML 层显示场景名） ----
    window.dispatchEvent(new CustomEvent('venue:scene-changed', {
      detail: { id: cfg.id, name: cfg.name, desc: cfg.desc },
    }));

    // ---- 相机边界 ----
    scene.physics.world.setBounds(0, 0, SCENE_W, SCENE_H);
    scene.cameras.main.setBounds(0, 0, SCENE_W, SCENE_H);
    scene.applyCameraFit();

    // ---- 淡入 ----
    if (!instant) {
      scene.cameras.main.fadeIn(280, 0, 0, 0);
    }

    this.switching = false;
    return cfg;
  }

  /** 清空当前场景的所有对象 */
  clear() {
    this.objects.forEach((o) => {
      if (o && o.destroy) o.destroy();
    });
    this.objects = [];

    if (this.obstacles) {
      this.obstacles.clear(true, true);
      this.obstacles = null;
    }

    this.exits = [];
  }

  /**
   * 检查玩家是否踩到了出入口
   * 在场景 update 里每帧调用
   */
  checkExits(playerX, playerY) {
    if (this.switching) return null;

    // 按出口顺序找第一个命中的
    // 判定用椭圆（对应地面上的圆形光圈），不是矩形
    for (const ex of this.exits) {
      if (typeof ex.contains === 'function') {
        if (ex.contains(playerX, playerY)) return ex;
      } else if (ex.rect) {
        // 兜底：没有 contains 时退回矩形
        const r = ex.rect;
        if (playerX >= r.x && playerX <= r.x + r.w &&
            playerY >= r.y && playerY <= r.y + r.h) {
          return ex;
        }
      }
    }
    return null;
  }


  /**
   * 切换到另一个场景
   */
  goThrough(exit) {
    if (this.switching) return;
    this.switching = true;

    const scene = this.scene;
    const target = this.getScene(exit.to);

    // -------------------------------------------------------------------------
    // 落点要取【目标场景里"通回本场景"那个光圈】上记录的坐标
    //
    // 为什么不能直接用 exit.toTileX：
    //   出口上的 toTileX/toTileY 表示的是「在本场景里，从那个方向进来时站哪」，
    //   也就是【本场景的】落点。
    //   比如 home 的出口 -> mailbox 上写的是 home 自己的落点 (24,2)，
    //   直接拿去当 mailbox 的落点会落在墙上，被 sanitize 挪走，
    //   表现就是「进门后出生点不对」，甚至两边光圈互相触发来回弹。
    //
    //   所以：从 A 去 B，要查 B 的出口里"通回 A"的那一个，用它的落点。
    // -------------------------------------------------------------------------
    const back = (target.exits || []).find((e) => e.to === this.current.id);
    let land;
    if (back && Number.isFinite(back.toTileX) && Number.isFinite(back.toTileY)) {
      land = { tileX: back.toTileX, tileY: back.toTileY };
    } else {
      // 没有对应出口（理论上不会）→ 退回目标场景出生点
      land = { tileX: target.spawn.tileX, tileY: target.spawn.tileY };
    }

    // 淡出 → 加载 → 淡入
    scene.cameras.main.fadeOut(240, 0, 0, 0);

    scene.cameras.main.once('camerafadeoutcomplete', () => {
      this.load(exit.to, land);
      scene.toast(`进入 ${target.name}`);
    });
  }

  /** 当前场景的碰撞组（给玩家加碰撞用） */
  getObstacleGroup() {
    return this.obstacles;
  }
}
