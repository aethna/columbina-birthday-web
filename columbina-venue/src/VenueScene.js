/**
 * 林间生日会 —— 多场景会场
 *
 * 架构：
 *   VenueScene      游戏循环、玩家、对话、任务、剧情、小地图、引导箭头
 *   SceneManager    当前场景 / 场景切换
 *   StorySystem     主线剧情（写邀请函 → 投递 → NPC 前来）
 *   InteractPoints  场景交互点（书桌、信箱、任务目标点）
 *   Minimap         小地图（场景图 / 世界图）
 *
 * 为什么不做 A* 寻路：
 *   场景只有一个屏幕大小，玩家走两步就到，寻路没有价值，
 *   反而会带来"算不出路""卡片""绕远"等问题。
 *   改用「方向箭头引导」——箭头指向任务目标；
 *   如果目标在别的场景，箭头指向通往那个场景的出口。
 *
 * 视觉分层：
 *   0      场景背景
 *   2      交互点光圈
 *   300+   NPC（按 y 排序）
 *   500    玩家
 *   9000   UI
 *   9500   小地图
 */

import Phaser from 'phaser';
import { TILE_SIZE, NPCS, PLAYER, INTERACT } from './config.js';
import { QUESTS, INTERACT_POINTS } from './quests.js';
import { SCENES, SCENE_COLS, SCENE_ROWS, SCENE_W, SCENE_H } from './scenes.js';
import { preloadCharacters, setupCharacters, createCharSprite, CHARACTER_FRAME } from './characters.js';
import DialogSystem from './DialogSystem.js';
import LetterSystem from './LetterSystem.js';
import QuestSystem from './QuestSystem.js';
import SceneManager from './SceneManager.js';
import Minimap from './Minimap.js';
import StorySystem from './StorySystem.js';
import InteractPointSystem from './InteractPoints.js';

export default class VenueScene extends Phaser.Scene {
  constructor() {
    super({ key: 'VenueScene' });
    this.npcs = [];
    this.activeNpc = null;
  }

  // ---------------------------------------------------------------------------
  preload() {
    SCENES.forEach((s) => this.load.image(`scene-bg-${s.id}`, s.bg));

    // 委托道具的贴图
    //
    // 为什么必须在这里统一加载、不能"用的时候再 load"：
    //   Phaser 的 load.image 是「排队 -> 加载 -> 解码」的异步流程。
    //   在 spawnProps 里临时加载来不及解码就要用，
    //   textures.exists() 会返回 false，道具就静默地不出现。
    this.loadPropTextures();

    preloadCharacters(this, [
      {
        id: 'player',
        sprite: PLAYER.sprite,
        sheet: PLAYER.sheet,
        color: PLAYER.color,
        frameWidth: PLAYER.frameWidth,
        frameHeight: PLAYER.frameHeight,
        displayHeight: PLAYER.displayHeight,
        // 每方向帧数（left/right 是视频抽帧的 8 帧真实迈步）
        framesPerDir: PLAYER.framesPerDir,
      },
      ...NPCS,
    ]);
  }

  // ---------------------------------------------------------------------------
  create() {
    // ---- 剧情（要在 NPC 创建前初始化）----
    this.story = new StorySystem((sys, kind) => this.onStoryChanged(kind));

    // ---- 角色 ----
    this.charInfo = setupCharacters(this, [
      {
        id: 'player',
        sprite: PLAYER.sprite,
        sheet: PLAYER.sheet,
        color: PLAYER.color,
        frameWidth: PLAYER.frameWidth,
        frameHeight: PLAYER.frameHeight,
        displayHeight: PLAYER.displayHeight,
        // 每方向帧数（left/right 是视频抽帧的 8 帧真实迈步）
        framesPerDir: PLAYER.framesPerDir,
      },
      ...NPCS,
    ]);
    this.playerInfo = this.charInfo['player'];

    // ---- 玩家 ----
    this.player = this.physics.add.sprite(0, 0, this.playerInfo.key);
    this.player.setDepth(500);
    this.player.setCollideWorldBounds(true);
    this.playerDir = 'down';

    // -------------------------------------------------------------------------
    // ★ 相机跟随玩家
    //
    // 之前整个项目里【从来没有人调用过 startFollow】，
    // 所以相机一直固定在 (274,154) 不动。后果：
    //   可见范围只有世界坐标 x 274~2103 / y 154~1183，
    //   地图下边那 350px 永远看不到 —— 而下方出口就在 y=1408。
    //   表现就是「下方传送光圈怎么都看不见」，
    //   而且玩家走到屏幕边缘外就彻底迷失方向。
    //
    // lerp 用 1（立即跟上）而不是缓动：这个游戏场景不大，
    // 缓动会让人觉得角色在飘。
    // -------------------------------------------------------------------------
    this.cameras.main.startFollow(this.player, true, 1, 1);

    // 按配置的显示高度缩放（行走图/立绘都要）
    const heroH = PLAYER.displayHeight || 224;
    this.playerH = heroH;
    if (this.playerInfo.mode === 'sheet') {
      const frameH = this.playerInfo.frameHeight || 336;
      this.player.setScale(heroH / frameH);
      this.player.setOrigin(0.5, 1);       // 锚点在脚底
      this.safePlay('idle-down');

      // 物理体：只覆盖脚部一小块，遮挡关系更自然
      // 注意 setSize 用的是"未缩放的纹理像素"，所以要把显示尺寸除以缩放
      const scale = heroH / frameH;
      const bodyW = 28 / scale;
      const bodyH = 20 / scale;
      this.player.body.setSize(bodyW, bodyH);
      this.player.body.setOffset(
        (this.playerInfo.frameWidth - bodyW) / 2,
        frameH - bodyH
      );
    } else if (this.playerInfo.mode === 'sprite') {
      this.player.setOrigin(0.5, 0.85);
      const src = this.textures.get(this.playerInfo.key).getSourceImage();
      if (src && src.height) this.player.setScale(heroH / src.height);
    } else {
      this.player.setOrigin(0.5, 1);
      const fw = CHARACTER_FRAME.w;
      const fh = CHARACTER_FRAME.h;
      const s = heroH / fh;
      this.player.setScale(s);
      this.player.body.setSize(24 / s, 20 / s);
      this.player.body.setOffset((fw - 24 / s) / 2, fh - 20 / s);
      this.safePlay('idle-down');
    }

    // 脚下的影子
    // 原版 2D RPG 角色脚下都有影子，没有影子会显得"悬空"。
    // 用一个椭圆模拟，跟随角色移动，不随动画帧变化。
    this.playerShadow = this.add.ellipse(
      this.player.x, this.player.y,
      Math.max(36, heroH * 0.30), Math.max(12, heroH * 0.10),
      0x000000, 0.30
    );
    this.playerShadow.setDepth(499);

    // ---- 输入 ----
    this.cursors = this.input.keyboard.createCursorKeys();
    this.keyW = this.input.keyboard.addKey('W');
    this.keyA = this.input.keyboard.addKey('A');
    this.keyS = this.input.keyboard.addKey('S');
    this.keyD = this.input.keyboard.addKey('D');
    this.keyE = this.input.keyboard.addKey('E');
    this.keyQ = this.input.keyboard.addKey('Q');
    this.keyM = this.input.keyboard.addKey('M');
    // F1：切换可走区显示（调试用）
    this.input.keyboard.on('keydown-F1', () => this.toggleWalkDebug());
    // F2：全图核对视图（一屏看完整个地图）
    this.input.keyboard.on('keydown-F2', () => this.toggleFullMap());

    // ---- 系统 ----
    this.dialog = new DialogSystem();
    // 信纸过场（写邀请函）：书桌前按 E → 信纸逐行展开 → 收归信封
    this.letter = new LetterSystem();
    // ★ 把 story 传进去：主线进度存在 StorySystem 里（邀请函写了几封 / 投没投递），
    //   QuestSystem 必须能问到它，否则主线永远显示「进行中 0%」。
    this.quests = new QuestSystem((qs, quest, kind) => {
      this.refreshQuestUI();
      if (kind === 'ready') this.toast('目标达成！');

      // 委托交付 -> 解锁对应道具，回会场就能看到
      // （道具和任务是一一对应的：抓鱼给鱼篓、打水给水桶，
      //   不会出现"捉完鱼冒出来一张桌子"）
      if (kind === 'delivered' && quest && quest.propReward) {
        this.unlockProp(quest.propReward.id);
        this.toast(`${quest.propReward.name} 已经摆到会场了`);

        // ★ 必须立刻重新摆一次道具
        //
        //   之前只 unlockProp 就完事了，而 spawnProps 只在
        //   onSceneChanged 里调用 —— 也就是说道具要等玩家
        //   【离开会场再回来】才会出现。
        //   而所有委托都是在会场交付的，所以"交付完看不到东西"
        //   是必然的。
        //
        //   稍微延后一点是为了让任务状态先落定（deliver 里还会 refreshQuestUI）。
        this.time.delayedCall(120, () => {
          if (this.scenes.current && this.scenes.current.id === 'venue') {
            this.spawnProps('venue');
          }
        });
      }
    }, this.story);

    // ---- UI ----
    this.buildUI();

    // ---- 场景管理 ----
    this.walkDebug = null;   // 可走区调试图层
    this.verLabel = null;    // 版本信息（调试用）
    this.fullMap = null;     // F2 全图核对视图
    this.initItemSystem();
    this.initPropSystem();
    this.scenes = new SceneManager(this);
    window.addEventListener('venue:scene-changed', (e) => this.onSceneChanged(e.detail));

    this.scenes.load(SCENES[0].id, null, true);
    this.physics.add.collider(this.player, this.scenes.getObstacleGroup());

    // ---- 交互点（要在场景加载后建）----
    // 第三个参数是任务系统 —— 交互点要能判断「这个委托做完了没」，
    // 做完了就把点位从地图上收掉
    this.interactPoints = new InteractPointSystem(this, this.story, this.quests);
    this.interactPoints.rebuild(this.scenes.current.id);

    this.spawnNpcsForCurrentScene();

    // ---- 引导箭头 ----
    this.guide = this.buildGuideArrow();

    // ---- 小地图 ----
    this.minimap = new Minimap(this);

    // ★ 进游戏先对齐一次主线状态
    //   存档（StorySystem 的数据）里可能邀请函早就写完/投递了，
    //   但 QuestSystem 的状态是另存的。不同步的话，
    //   刷新页面后主线又会显示成「进行中 0%」。
    this.quests.syncStoryQuests();

    this.refreshQuestUI();
    this.showSceneIntro();

    // ---- 尺寸 ----
    this.scale.on('resize', (gs) => this.handleResize(gs));
    this.time.delayedCall(60, () => this.handleResize(this.scale.gameSize));

    // ---- 对外 ----
    window.__venueScene = this;
    window.__venueQuests = this.quests;
    window.__venueStory = this.story;

    window.addEventListener('venue:quest-panel', () => this.toggleQuestPanel());
    window.addEventListener('venue:goto-quest', (e) => this.handleGotoQuest(e.detail.questId));
  }

  // ---------------------------------------------------------------------------
  // 场景切换
  // ---------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // 委托道具：任务交付后出现在会场
  //
  // 数据来源：QUESTS 里每个委托的 propReward
  //   propReward: { id, name, tileX, tileY, h }
  //
  // 存档键 venue-props-v1 存的是一组已解锁的道具 id。
  // 单独存而不是从委托状态推导，因为道具是累加的 ——
  // 重置某个委托不该让已经摆出来的东西消失。
  // -------------------------------------------------------------------------
  initPropSystem() {
    this.PROPS_KEY = 'venue-props-v1';
    this.props = [];          // 当前场景里的道具精灵
    this.propGroup = null;    // 碰撞组
  }

  /**
   * 加载所有委托道具的贴图（在 preload 里调用）
   *
   * 道具清单直接从 QUESTS 的 propReward 里取，
   * 这样加新委托时不用再来改这里 —— 单一数据源。
   */
  loadPropTextures() {
    const seen = new Set();
    for (const q of QUESTS) {
      const pr = q.propReward;
      if (!pr || seen.has(pr.id)) continue;
      seen.add(pr.id);
      this.load.image(`prop-${pr.id}`, `assets/props/${pr.id}.png`);
    }
  }

  /** 已解锁的道具 id 集合 */
  unlockedProps() {
    try {
      return new Set(JSON.parse(localStorage.getItem(this.PROPS_KEY) || '[]'));
    } catch {
      return new Set();
    }
  }

  /** 解锁一个道具（委托交付时调用） */
  unlockProp(propId) {
    if (!propId) return;
    const s = this.unlockedProps();
    if (s.has(propId)) return;
    s.add(propId);
    localStorage.setItem(this.PROPS_KEY, JSON.stringify([...s]));
  }

  /** 把已解锁的道具摆到当前场景（只摆会场） */
  spawnProps(sceneId) {
    for (const p of this.props) p.destroy();
    this.props = [];
    if (this.propGroup) { this.propGroup.clear(true, true); this.propGroup = null; }

    if (sceneId !== 'venue') return;

    const unlocked = this.unlockedProps();
    if (!unlocked.size) return;

    // 从委托定义里取道具的位置和尺寸
    const defs = [];
    for (const q of QUESTS) {
      const pr = q.propReward;
      if (pr && unlocked.has(pr.id)) defs.push({ ...pr, questId: q.id });
    }
    if (!defs.length) return;

    this.propGroup = this.physics.add.staticGroup();

    for (const d of defs) {
      const key = `prop-${d.id}`;
      if (!this.textures.exists(key)) {
        console.warn('[道具] 贴图缺失:', key);
        continue;
      }

      const tx = d.tileX * TILE_SIZE + TILE_SIZE / 2;
      const ty = d.tileY * TILE_SIZE + TILE_SIZE / 2;

      const sp = this.add.image(tx, ty, key).setOrigin(0.5, 1);
      // 按目标高度缩放
      const src = this.textures.get(key).getSourceImage();
      sp.setScale(d.h / src.height);
      // 深度用底部 y 排序，和角色一致
      sp.setDepth(ty);

      // 影子：没有影子道具会像"贴"在地上
      const shadow = this.add.ellipse(
        tx, ty - 2,
        Math.max(24, d.h * 0.62), Math.max(10, d.h * 0.22),
        0x000000, 0.24
      ).setDepth(ty - 1);
      this.props.push(shadow);

      this.props.push(sp);

      // 碰撞：道具底座不能走上去
      const boxW = Math.max(20, src.width * sp.scaleX * 0.75);
      const boxH = Math.max(12, d.h * 0.30);
      const body = this.propGroup.create(tx, ty - boxH / 2, undefined);
      body.setVisible(false);
      // ★ 不要调 updateFromGameObject()
      //   它按 GameObject 的尺寸覆盖刚设的 setSize，
      //   而道具是用 undefined 贴图建的（默认 32x32），
      //   结果碰撞盒被压小 —— 和挡板那个 bug 是同一个原因。
      body.body.setSize(boxW, boxH);
    }

    console.log(`[道具] 会场摆了 ${this.props.length} 个道具`);
  }

  onSceneChanged(detail) {
    if (this.sceneLabel) this.sceneLabel.setText(detail.name);
    this.updateVerLabel();

    this.time.delayedCall(50, () => {
      // 摆出已解锁的委托道具
      //
      // 为什么要放在 delayedCall 里：
      //   此刻 scenes.current 才是新场景。
      //   在外面调用时它还是旧场景，会判断错场景、道具摆不出来。
      this.spawnProps(this.scenes.current.id);
      // 如果开着可走区显示，切场景后要重画
      if (this.walkDebug) { this.walkDebug.destroy(); this.walkDebug = null; this.toggleWalkDebug(); }
      this.physics.add.collider(this.player, this.scenes.getObstacleGroup());
      this.interactPoints.rebuild(this.scenes.current.id);
      this.spawnNpcsForCurrentScene();
      this.showSceneIntro();
      this.refreshQuestUI();
    });
  }

  showSceneIntro() {
    const cfg = this.scenes.current;
    if (cfg && cfg.name) this.toast(`— ${cfg.name} —`);
  }

  /** 剧情推进时刷新界面 */
  onStoryChanged(kind) {
    // ★ 先把主线任务状态和剧情进度对齐，再刷新 UI。
    //
    //   顺序不能反：写邀请函 / 投递这两件事走的是 StorySystem，
    //   而主线任务的状态在 QuestSystem 里。
    //   如果先刷新 UI，拿到的还是「进行中 0%」的旧状态，
    //   要等下一次别的操作才会刷新成"已完成"。
    if (this.quests) this.quests.syncStoryQuests();

    // 剧情变化可能影响 NPC 是否出现
    this.spawnNpcsForCurrentScene();
    this.refreshQuestUI();

    // ★ 书桌那一个交互点要跟着剧情换脸
    //   （icon 从 ✎ 变成 ✉、标签从「窗前的书桌」变成「桌上的邀请函」）
    //   label/hint/icon 文字是 getter，本来就会实时求值；
    //   但【图标图形】是 rebuild 时按 shape 画出来的，所以这里得重建一次。
    if (kind === 'write' || kind === 'take' || kind === 'reset') {
      if (this.scenes && this.scenes.current) {
        this.interactPoints.rebuild(this.scenes.current.id);
      }
    }

    if (kind === 'deliver') {
      this.toast('邀请函已寄出，朋友们正在赶来…');
      // 稍等一会儿再刷新 NPC，让玩家看到"来了"
      this.time.delayedCall(1800, () => {
        this.spawnNpcsForCurrentScene();
        this.toast('大家收到邀请，来到会场了！');
      });
    }
  }

  // ---------------------------------------------------------------------------
  // NPC
  // ---------------------------------------------------------------------------
  spawnNpcsForCurrentScene() {
    // 清掉旧的
    this.npcs.forEach((n) => {
      if (n.body) n.body.destroy();
      if (n.icon) n.icon.destroy();
      if (n.nameObj) n.nameObj.destroy();
      if (n.shadow) n.shadow.destroy();
    });
    this.npcs = [];
    this.activeNpc = null;

    const sceneId = this.scenes.current ? this.scenes.current.id : SCENES[0].id;

    NPCS.filter((def) => {
      // 只出现在所属场景
      if ((def.scene || 'venue') !== sceneId) return false;
      // 需要受邀的 NPC，在收到邀请函前不出现
      if (def.guest && !this.story.isGuestArrived(def.id)) return false;
      return true;
    }).forEach((def) => {
      const info = this.charInfo[def.id];
      if (!info) return;

      const x = def.tileX * TILE_SIZE + TILE_SIZE / 2;
      const y = def.tileY * TILE_SIZE + TILE_SIZE / 2;

      const body = createCharSprite(this, info, x, y, {
        displayHeight: def.displayHeight || 160,
      });
      body.setDepth(300 + y * 0.001);
      body.setInteractive({ useHandCursor: true });

      const isSprite = info.mode === 'sprite';
      const topOffset = isSprite ? -(def.displayHeight || 160) - 16 : -46;
      const nameOffset = isSprite ? 8 : 34;

      const icon = this.add.text(x, y + topOffset, def.icon || '💬', {
        fontSize: '24px',
      }).setOrigin(0.5).setDepth(9000);

      const name = this.add.text(x, y + nameOffset, def.name, {
        fontFamily: 'system-ui, "Microsoft YaHei", sans-serif',
        fontSize: '13px',
        color: '#dfe9f7',
        backgroundColor: '#000000cc',
        padding: { x: 6, y: 2 },
      }).setOrigin(0.5).setDepth(9000);

      // NPC 脚下的影子（和主角一样，避免"悬空"）
      const npcH = def.displayHeight || 160;
      const shadow = this.add.ellipse(
        x, y - 2,
        Math.max(30, npcH * 0.30), Math.max(10, npcH * 0.10),
        0x000000, 0.28
      );
      shadow.setDepth(299);

      const npc = { ...def, x, y, body, icon, nameObj: name, info, shadow, iconText: def.icon || '💬', talked: false };
      body.on('pointerdown', () => this.startDialog(npc));
      this.npcs.push(npc);
    });
  }

  // ---------------------------------------------------------------------------
  // 引导箭头
  // ---------------------------------------------------------------------------
  buildGuideArrow() {
    // ★ 已按需求关闭
    //
    //   原来这里画一个金色三角形（0xffd97a）飘在任务目标上做引导。
    //   用户反馈这个箭头太抢眼，去掉了。
    //   注意：getGuideTarget() 不能删 —— 任务面板的「前往」按钮
    //   还要靠它算目标位置。
    return null;
  }

  /** 旧实现保留在注释里，方便以后想恢复时参考
  _buildGuideArrowLegacy() {
    const container = this.add.container(0, 0).setDepth(8000);

    const tri = this.add.triangle(0, 0, 0, -14, -11, 10, 11, 10, 0xffd97a, 1)
      .setOrigin(0.5);
    const halo = this.add.circle(0, 0, 22, 0xffd97a, 0.12);

    container.add([halo, tri]);

    // 上下浮动动画
    this.tweens.add({
      targets: tri,
      y: -6,
      duration: 700,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.inOut',
    });

    return { container, tri, halo, text: null };
  }
  */


  /**
   * 计算并显示引导箭头
   *
   * 逻辑：
   *   1. 找出当前最该做的任务
   *   2. 如果目标在当前场景 → 箭头指向目标点
   *   3. 如果目标在别的场景 → 箭头指向通往那个场景的出口
   *   4. 没有目标 → 隐藏箭头
   */
  updateGuide() {
    // 引导箭头已关闭（见 buildGuideArrow）
    if (!this.guide) return;

    const target = this.getGuideTarget();

    if (!target) {
      this.guide.container.setVisible(false);
      return;
    }

    this.guide.container.setVisible(true);
    this.guide.container.setPosition(target.x, target.y);

    // 箭头朝向玩家方向（从目标指向玩家，让玩家知道"目标在那头"）
    const ang = Math.atan2(this.player.y - target.y, this.player.x - target.x);
    // 三角形默认朝上，所以 +90 度
    this.guide.tri.setRotation(ang + Math.PI / 2);

    // 颜色：跨场景用不同颜色区分
    const color = target.crossScene ? 0x9ecbff : 0xffd97a;
    this.guide.tri.setFillStyle(color);
    this.guide.halo.setFillStyle(color, 0.12);
  }

  /**
   * 求出当前应该引导去哪
   * @returns {{x:number, y:number, crossScene:boolean}|null}
   */
  getGuideTarget() {
    const here = this.scenes.current ? this.scenes.current.id : 'venue';

    // ---- 优先：主线剧情 ----
    // ★ 流程改版（2026-09-28）：去掉了「写信」这一步。
    //   开局 5 封信就已经写好摆在桌上，所以现在只有两步：
    //     步骤1：桌上有信 → 去书桌旁收起
    //     步骤2：信在身上但没投递 → 去信箱
    //   （原来"步骤1：还没写完 → 去书桌写"整段已删除）

    // 步骤1：桌上有写好的信 → 去拿走
    if (this.story.onDeskCount > 0) {
      if (here === 'home') {
        return this.pointPos('ip-letters');
      }
      return this.exitPosTo('home');
    }

    // 步骤2：信在身上但没投递 → 去信箱
    if (this.story.carriedCount > 0 && !this.story.isDelivered) {
      if (here === 'mailbox') {
        return this.pointPos('ip-mailbox');
      }
      return this.exitPosTo('mailbox');
    }

    // ---- 其次：进行中的委托 ----
    const active = QUESTS.find((q) => {
      const st = this.quests.getState(q);
      return (st === 'active' || st === 'ready') && !q.special;
    });

    if (active) {
      const state = this.quests.getState(active);
      const t = active.target;

      // 可交付 → 去交付 NPC 那里
      if (state === 'ready') {
        const npcId = active.deliverNpcId || active.giverNpcId;
        const npcDef = NPCS.find((n) => n.id === npcId);
        if (npcDef) {
          if ((npcDef.scene || 'venue') === here) {
            return { x: npcDef.tileX * TILE_SIZE + 32, y: npcDef.tileY * TILE_SIZE + 32, crossScene: false };
          }
          return this.exitPosTo(npcDef.scene || 'venue');
        }
      }

      // 未完成 → 去目标地点
      if (t.type === 'visit') {
        const tScene = t.scene || active.scene || 'venue';
        if (tScene === here) {
          return { x: t.tileX * TILE_SIZE + 32, y: t.tileY * TILE_SIZE + 32, crossScene: false };
        }
        return this.exitPosTo(tScene);
      }

      if (t.type === 'talk' && t.npcId) {
        const npcDef = NPCS.find((n) => n.id === t.npcId);
        if (npcDef) {
          if ((npcDef.scene || 'venue') === here) {
            return { x: npcDef.tileX * TILE_SIZE + 32, y: npcDef.tileY * TILE_SIZE + 32, crossScene: false };
          }
          return this.exitPosTo(npcDef.scene || 'venue');
        }
      }
    }

    // ---- 没写的委托 → 提示去找委托官 ----
    // 委托没解锁前不指引（NPC 还没到场）
    const storyDone = this.story.allWritten && this.story.isDelivered;
    const available = storyDone
      ? QUESTS.find((q) => this.quests.getState(q) === 'available' && !q.special)
      : null;
    if (available) {
      const npcDef = NPCS.find((n) => n.id === available.giverNpcId);
      if (npcDef) {
        if ((npcDef.scene || 'venue') === here) {
          return { x: npcDef.tileX * TILE_SIZE + 32, y: npcDef.tileY * TILE_SIZE + 32, crossScene: false };
        }
        return this.exitPosTo(npcDef.scene || 'venue');
      }
    }

    return null;
  }

  /** 交互点的世界坐标 */
  pointPos(pointId) {
    const def = INTERACT_POINTS.find((p) => p.id === pointId);
    if (!def) return null;
    return { x: def.tileX * TILE_SIZE + 32, y: def.tileY * TILE_SIZE + 32, crossScene: false };
  }

  /** 找到通往目标场景的出口坐标 */
  exitPosTo(targetSceneId) {
    const cfg = this.scenes.current;
    if (!cfg) return null;

    const ex = (cfg.exits || []).find((e) => e.to === targetSceneId);
    if (!ex) return null;

    return {
      x: (ex.tileX + ex.w / 2) * TILE_SIZE,
      y: (ex.tileY + ex.h / 2) * TILE_SIZE,
      crossScene: true,
    };
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------
  buildUI() {
    const font = 'system-ui, "Microsoft YaHei", sans-serif';

    this.add.text(16, 14, 'WASD 移动   E 交互 / 对话   Q 任务   M 地图', {
      fontFamily: font, fontSize: '15px', color: '#e8eef8',
      backgroundColor: '#00000088', padding: { x: 10, y: 6 },
    }).setScrollFactor(0).setDepth(9000);

    this.sceneLabel = this.add.text(16, 52, '', {
      fontFamily: font, fontSize: '17px', color: '#ffd97a',
      backgroundColor: '#00000099', padding: { x: 10, y: 5 },
    }).setScrollFactor(0).setDepth(9000);

    // 底部交互提示（NPC 或交互点共用）
    this.npcTip = this.add.text(this.scale.width / 2, this.scale.height - 68, '', {
      fontFamily: font, fontSize: '18px', align: 'center',
      color: '#ffffff', backgroundColor: '#000000cc',
      padding: { x: 18, y: 10 },
    }).setOrigin(0.5).setScrollFactor(0).setDepth(9000).setVisible(false);

    this.toastText = this.add.text(this.scale.width / 2, 80, '', {
      fontFamily: font, fontSize: '17px', color: '#ffd97a',
      backgroundColor: '#000000cc', padding: { x: 16, y: 8 },
    }).setOrigin(0.5).setScrollFactor(0).setDepth(9000).setAlpha(0);

    // 获得物品提示（比普通 toast 更显眼）
    this.gainText = this.add.text(this.scale.width / 2, 130, '', {
      fontFamily: font, fontSize: '19px', color: '#7ed7a0',
      backgroundColor: '#0d1a12ee', padding: { x: 20, y: 12 },
    }).setOrigin(0.5).setScrollFactor(0).setDepth(9100).setAlpha(0);
  }

  toast(msg) {
    this.toastText.setText(msg);
    this.tweens.killTweensOf(this.toastText);
    this.toastText.setAlpha(1);
    this.tweens.add({ targets: this.toastText, alpha: 0, delay: 1600, duration: 600 });
  }

  /** 获得物品的提示 */
  gainToast(msg) {
    this.gainText.setText(`获得 ${msg}`);
    this.tweens.killTweensOf(this.gainText);
    this.gainText.setAlpha(1);
    this.gainText.setScale(0.9);
    this.tweens.add({ targets: this.gainText, scale: 1, duration: 220, ease: 'Back.out' });
    this.tweens.add({ targets: this.gainText, alpha: 0, delay: 2000, duration: 700 });
  }

  refreshQuestUI() {
    const story = this.story.snapshot();

    // ★ 主线是否走完（邀请函全部写完 + 已投递）
    //   没走完时 NPC 还没到场，委托自然也还不存在 ——
    //   所以这里把委托全部过滤掉，只留主线。
    const storyDone = this.story.allWritten && this.story.isDelivered;

    const all = this.quests.snapshot();
    const list = all.filter((q) => {
      // 主线（id 以 main- 开头）：
      //   做完了就该从列表里消失 —— 不然"写邀请函""投递邀请函"会一直挂着，
      //   玩家会以为还没做完。
      if (String(q.id).startsWith('main-')) {
        return q.state !== 'completed';
      }
      // 委托：必须等主线走完才出现
      return storyDone;
    });

    window.dispatchEvent(new CustomEvent('venue:quests-updated', {
      detail: {
        quests: list,
        story,
        guide: this.quests.activeGuide(),
        // 告诉 UI 层：委托还没解锁（可以显示一行提示）
        commissionsLocked: !storyDone,
        hiddenCount: all.length - list.length,
      },
    }));
  }

  toggleQuestPanel() {
    window.dispatchEvent(new CustomEvent('venue:toggle-quest-panel'));
  }

  handleResize(gameSize) {
    const w = gameSize.width, h = gameSize.height;
    if (this.npcTip) this.npcTip.setPosition(w / 2, h - 68);
    if (this.toastText) this.toastText.setPosition(w / 2, 80);
    if (this.gainText) this.gainText.setPosition(w / 2, 130);
    const cam = this.cameras.main;
    if (cam) { cam.setSize(w, h); cam.setViewport(0, 0, w, h); }
    this.applyCameraFit();
  }

  applyCameraFit() {
    const cam = this.cameras.main;
    if (!cam) return;
    const vw = cam.width, vh = cam.height;
    if (!vw || !vh) return;
    const coverZoom = Math.max(vw / SCENE_W, vh / SCENE_H);
    const viewZoom = Math.min(vw / (SCENE_W * 0.7), vh / (SCENE_H * 0.7));
    let zoom = Math.min(coverZoom, viewZoom * 1.2);
    zoom = Phaser.Math.Clamp(zoom, 0.7, 2.4);
    cam.setZoom(zoom);
  }

  /**
   * 播放主角动画
   *
   * ★ 重要：动画名必须用 playerInfo.key 作前缀。
   *   characters.js 注册的动画名是 `${info.key}-walk-${dir}`，
   *   而 info.key 是 `char-player`（行走图）或 `ph-player`（占位）。
   *   之前这里写死了 'player-walk-xxx'，少一个前缀，
   *   导致 anims.exists() 永远为 false，动画静默不播放
   *   —— 表现出来就是"一张图片在地上平移"。
   *
   * @param {string} suffix 形如 'walk-down' / 'idle-left'
   */
  safePlay(suffix, ignoreIfPlaying = true) {
    const prefix = this.playerInfo?.key || 'char-player';
    const key = `${prefix}-${suffix}`;

    if (!this.anims.exists(key)) {
      if (!this._animWarned) {
        this._animWarned = true;
        console.warn(`[动画] 找不到 ${key}`);
      }
      return;
    }

    // ★ 走路动画要和移动速度同步，否则会"脚底打滑"
    //
    // 原理：
    //   一个走路循环跨出两步。帧率 = (移动速度 / 循环距离) × 帧数
    //   如果帧率固定而角色移动很快，脚就会"滑"；反之则像在原地踏步。
    //
    //   ── 为什么帧数和循环距离要一起看（踩过的坑）──
    //   frames 从 4 变成 8（left/right 改成视频抽帧）之后，
    //   同一个 cycleDistance 除以 8 帧，帧率直接翻倍 → 从 4.5 变成 9.5，
    //   肉眼就是"腿抡得飞快"。
    //   根因：8 帧不是 4 帧的替代，而是把同一个循环切得更细。
    //        同一个循环应该走完同样的距离、花同样的时间 —— 帧率翻倍是必然的。
    //   所以"调慢"不能去改帧率数字，要改【循环距离】（一个循环走多远）。
    //
    // ★ WALK_CYCLE_FACTOR：一个循环走几个身高
    //   1.0  = 一个循环走一个身高（物理上最合理，但 Q 版腿短，看起来像滑行）
    //   0.55 = 老版本（4 帧时代）的取值
    //   0.92 = 8 帧视频抽帧版第一次接入时的取值 → 9.5 fps，实测偏快
    //   1.2  = 现在（调慢后）→ 7.5 fps，比上一版慢约 21%，步速接近老版本手感
    //
    //   想再快/再慢，只改这一个数：
    //     调大 = 更慢（一个循环走更远，帧率被压低）
    //     调小 = 更快
    const WALK_CYCLE_FACTOR = 1.2;
    if (suffix.startsWith('walk-')) {
      const anim = this.anims.get(key);
      const frames = anim ? anim.frames.length : 4;
      const cycleDistance = Math.max(60, (this.playerH || 192) * WALK_CYCLE_FACTOR);
      const wantRate = (PLAYER.speed / cycleDistance) * frames;
      // 上限放到 14：8 帧走路算出来接近 10，夹在 10 会让"再调慢"失效
      // （调大 cycleDistance 想让帧率降下来时，如果本来贴着上限，会看不出变化）
      const rate = Phaser.Math.Clamp(Math.round(wantRate * 2) / 2, 3, 14);

      const cur = this.player.anims.currentAnim;
      // 只在切换动画或帧率变了的时候重建，避免每帧都重建
      if (!cur || cur.key !== key || this._walkRate !== rate) {
        this._walkRate = rate;
        if (this.anims.exists(key)) this.anims.remove(key);
        // ★ 行首帧号 = 行号 × 每行格数。
        //   每行格数不是 4 —— left/right 有 8 帧，雪碧图整行就是 8 格宽。
        //   取帧数时用该方向自己的帧数（down/up 是 4）。
        const cols = this.playerInfo?.cols || 4;
        const dir = suffix.split('-')[1];
        const n = this.playerInfo?.framesPerDir?.[dir] || frames;
        const first = this._animRow(suffix) * cols;
        this.anims.create({
          key,
          frames: Array.from({ length: n }, (_, i) => ({ key: prefix, frame: first + i })),
          frameRate: rate,
          repeat: -1,
        });
        this.player.play(key, ignoreIfPlaying);
        return;
      }
    }

    this.player.play(key, ignoreIfPlaying);
  }

  /** 求方向对应的行号（0=down 1=left 2=right 3=up） */
  _animRow(suffix) {
    const dir = suffix.split('-')[1];
    return { down: 0, left: 1, right: 2, up: 3 }[dir] ?? 0;
  }

  // ---------------------------------------------------------------------------
  update() {
    if (this.scenes.switching) {
      this.player.setVelocity(0);
      return;
    }

    if (window.__venuePaused || this.dialog.isOpen() || (this.letter && this.letter.isOpen())) {
      this.player.setVelocity(0);
      this.safePlay(`idle-${this.playerDir}`);
      if (this.interactPoints) this.interactPoints.update(this.player.x, this.player.y);
      this.handleMinimap();
      return;
    }

    this.handleKeyboardMove();
    this.updateShadow();
    this.handleProximity();
    this.handleInteract();
    this.handleMinimap();
    this.updateGuide();

    // 出口检测：两种方式
    //   1. 踩在出口矩形里（传统方式）
    //   2. 碰到屏幕边缘 + 朝那方向走 + 那侧有出口
    // 第 2 种是为了修「角色走出屏幕了却迟迟不切场景」——
    // 相机滚到头以后角色会继续往屏幕外走，那时应该立即切。
    const ex = this.scenes.checkExits(this.player.x, this.player.y)
            || this.checkScreenEdgeExit();
    if (ex) {
      this.scenes.goThrough(ex);
      return;
    }

    this.handleQuestVisit();
  }

  /** 更新影子位置（跟着主角脚底走） */
  updateShadow() {
    if (this.playerShadow && this.player) {
      this.playerShadow.setPosition(this.player.x, this.player.y - 2);
    }
  }

  /**
   * 屏幕边缘出口检测
   *
   * 为什么需要：
   *   相机滚到边界后会停住，角色继续走就会「走出屏幕」。
   *   而出口定义在地图边缘，角色得在屏幕外再走一段才碰到，
   *   玩家会觉得"走出去了怎么不切场景"。
   *
   * 做法：
   *   角色碰到屏幕边缘（留几像素容差），且正在朝那个方向移动，
   *   且那一侧存在出口 -> 直接触发。
   */
  checkScreenEdgeExit() {
    if (this.scenes.switching) return null;

    const cam = this.cameras.main;
    const wv = cam.worldView;
    const W = cam.width / cam.zoom;   // 可见区域的世界宽
    const H = cam.height / cam.zoom;
    const M = 8;                      // 边缘容差（世界像素）

    // 角色在可见区域内的相对位置
    const rx = this.player.x - wv.x;
    const ry = this.player.y - wv.y;

    // 判断贴着哪条边（世界坐标下）
    let side = null;
    if (rx <= M) side = 'left';
    else if (rx >= W - M) side = 'right';
    else if (ry <= M) side = 'up';
    else if (ry >= H - M) side = 'down';

    if (!side) return null;

    // 必须正在朝那个方向移动（避免相机刚好夹在边界时误触发）
    const v = this.player.body ? this.player.body.velocity : { x: 0, y: 0 };
    if (side === 'right' && v.x <= 0) return null;
    if (side === 'left' && v.x >= 0) return null;
    if (side === 'down' && v.y <= 0) return null;
    if (side === 'up' && v.y >= 0) return null;

    // 找那一侧的出口
    //
    // ★ 这里原来写的是 ex.rect.x / ex.rect.w —— 但出口对象上根本没有 rect 字段
    //   （SceneManager 里 push 的是 centerX/centerY/portalX/portalY/rx/ry/w/h）。
    //   所以 r 是 undefined，这一行每帧都抛 TypeError，
    //   把整个 update() 打断 —— 表现就是「角色走到某个位置突然卡死、
    //   相机也不再跟随」，因为那一帧之后再也没跑过 update。
    //
    //   现在改用出口实际有的字段：中心用 centerX/centerY，尺寸用 w/h（单位是格）。
    for (const ex of this.scenes.exits) {
      const cx = Number.isFinite(ex.centerX) ? ex.centerX : ex.portalX;
      const cy = Number.isFinite(ex.centerY) ? ex.centerY : ex.portalY;
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;

      const rw = (ex.w || 1) * TILE_SIZE;
      const rh = (ex.h || 1) * TILE_SIZE;

      if (side === 'right' && cx > this.player.x && Math.abs(cy - this.player.y) < rh) return ex;
      if (side === 'left' && cx < this.player.x && Math.abs(cy - this.player.y) < rh) return ex;
      if (side === 'down' && cy > this.player.y && Math.abs(cx - this.player.x) < rw) return ex;
      if (side === 'up' && cy < this.player.y && Math.abs(cx - this.player.x) < rw) return ex;
    }
    return null;
  }

  handleKeyboardMove() {
    let vx = 0, vy = 0;
    if (this.cursors.left.isDown || this.keyA.isDown) vx -= 1;
    if (this.cursors.right.isDown || this.keyD.isDown) vx += 1;
    if (this.cursors.up.isDown || this.keyW.isDown) vy -= 1;
    if (this.cursors.down.isDown || this.keyS.isDown) vy += 1;

    if (vx && vy) { const inv = 1 / Math.sqrt(2); vx *= inv; vy *= inv; }

    this.player.setVelocity(vx * PLAYER.speed, vy * PLAYER.speed);
    this.player.setDepth(500 + this.player.y * 0.001);

    if (vx || vy) {
      const dir = Math.abs(vx) > Math.abs(vy)
        ? (vx > 0 ? 'right' : 'left')
        : (vy > 0 ? 'down' : 'up');
      this.playerDir = dir;
      this.safePlay(`walk-${dir}`);
    } else {
      this.safePlay(`idle-${this.playerDir}`);
    }
  }

  /** NPC 和交互点的接近检测 */
  handleProximity() {
    // --- NPC ---
    let nearest = null, nd = Infinity;
    for (const n of this.npcs) {
      const d = Phaser.Math.Distance.Between(this.player.x, this.player.y, n.x, n.y);
      if (d < INTERACT.radius && d < nd) { nearest = n; nd = d; }
    }

    if (nearest !== this.activeNpc) {
      this.activeNpc = nearest;
      this.npcs.forEach((n) => n.icon.setScale(1));
      if (nearest) nearest.icon.setScale(1.3);
    }

    // --- 交互点 ---
    const pointActive = this.interactPoints
      ? this.interactPoints.update(this.player.x, this.player.y)
      : null;

    // --- 显示提示（NPC 优先）---
    if (nearest) {
      this.npcTip.setText(`${nearest.iconText} ${nearest.name}\n按 E 对话`).setVisible(true);
      this.activePoint = null;
    } else if (pointActive) {
      // ★ 这里必须用 pointActive.iconText（字符串），不能用 pointActive.icon。
      //   icon 是 makeIcon() 返回的 Graphics 对象，
      //   拼进模板字符串会变成 "[object Object]"（曾经显示成「[object Object] 花丛」）。
      this.npcTip.setText(`${pointActive.iconText || '◆'} ${pointActive.label}\n${pointActive.hint || '按 E 互动'}`).setVisible(true);
      this.activePoint = pointActive;
    } else {
      this.npcTip.setVisible(false);
      this.activePoint = null;
    }
  }

  handleInteract() {
    if (!Phaser.Input.Keyboard.JustDown(this.keyE)) {
      if (Phaser.Input.Keyboard.JustDown(this.keyQ)) this.toggleQuestPanel();
      return;
    }

    // NPC 优先
    if (this.activeNpc) {
      this.startDialog(this.activeNpc);
      return;
    }

    // 交互点
    if (this.activePoint) {
      this.triggerPoint(this.activePoint);
    }
  }


  // ---------------------------------------------------------------------------
  // 物品系统
  //
  // 为什么单独做一套：
  //   打水这类任务需要「先拿到空桶、再装水、再交回去」这样的中间状态。
  //   只靠"走到某处就算完成"表达不了，所以需要记录玩家手上有什么。
  //
  // 存法很简单：{ 物品id: 数量 }，放在 localStorage。
  // ---------------------------------------------------------------------------
  initItemSystem() {
    this.ITEMS_KEY = 'venue-items-v1';
  }

  getItems() {
    try {
      return JSON.parse(localStorage.getItem(this.ITEMS_KEY) || '{}');
    } catch {
      return {};
    }
  }

  saveItems(o) {
    localStorage.setItem(this.ITEMS_KEY, JSON.stringify(o));
  }

  /** 获得物品 */
  giveItem(id, name) {
    if (!id) return;
    const o = this.getItems();
    o[id] = (o[id] || 0) + 1;
    this.saveItems(o);
    this.toast(`获得：${name || id}`);
    if (this.gainToast) this.gainToast(name || id);
  }

  /** 手上有没有这个物品 */
  hasItem(id) {
    if (!id) return false;
    return (this.getItems()[id] || 0) > 0;
  }

  /** 消耗一个物品 */
  takeItem(id) {
    if (!id) return false;
    const o = this.getItems();
    if (!o[id]) return false;
    o[id] -= 1;
    if (o[id] <= 0) delete o[id];
    this.saveItems(o);
    return true;
  }

  /** 清空（调试用） */
  clearItems() {
    localStorage.removeItem(this.ITEMS_KEY);
  }

  /**
   * 通用「换物」交互
   *
   * 交互点里配：
   *   action: 'exchangeItem'
   *   needItem  需要什么（没有就提示 needHint）
   *   giveItem  给什么
   *   doneItem  已经有的完成标记（有就提示 doneHint，避免重复刷）
   *   collectId 通知任务系统收集了这个 id
   *
   * 这样一个动作就能覆盖"空桶 -> 装满水的桶"这类流程，
   * 以后别的收集任务也能直接复用。
   */
  doExchangeItem(p) {
    if (p.doneItem && this.hasItem(p.doneItem)) {
      this.toast(p.doneHint || '已经做好了');
      return;
    }
    if (p.needItem && !this.hasItem(p.needItem)) {
      this.dialog.open(
        { name: p.label || '提示', portrait: '❓', portraitBg: '#2a2a33' },
        [{ text: p.needHint || '你还没有需要的东西。' }],
        null
      );
      return;
    }

    if (p.needItem) this.takeItem(p.needItem);
    if (p.giveItem) this.giveItem(p.giveItem, p.giveName);
    if (p.collectId) this.quests.markCollect(p.collectId, 1);

    if (p.okText) {
      this.dialog.open(
        { name: p.label || '交互', portrait: '💧', portraitBg: '#223a3d' },
        [{ text: p.okText }],
        null
      );
    }
    this.refreshQuestUI();
  }


  // ---------------------------------------------------------------------------
  // 可走区可视化（调试用）
  //
  // 碰撞地图平时是隐形的，只能靠"走"去试。
  // 按 F1 把每一格画出来，一眼就能看出哪能走、哪挡住。
  // 绿色 = 可走，红色 = 挡住。
  // ---------------------------------------------------------------------------
  toggleWalkDebug() {
    if (this.walkDebug) {
      this.walkDebug.destroy();
      this.walkDebug = null;
      this.toast('关闭可走区显示');
      return;
    }

    const g = this.scenes.getMap(this.scenes.current.id);
    if (!g) return;

    const gfx = this.add.graphics().setDepth(50000);
    const T = TILE_SIZE;

    for (let y = 0; y < g.length; y++) {
      for (let x = 0; x < g[y].length; x++) {
        const walk = g[y][x] === '.';
        if (walk) {
          gfx.fillStyle(0x3cff8c, 0.28);
          gfx.fillRect(x * T, y * T, T - 1, T - 1);
        } else {
          gfx.fillStyle(0xff3c3c, 0.22);
          gfx.fillRect(x * T + 2, y * T + 2, T - 5, T - 5);
        }
      }
    }
    // 格线
    gfx.lineStyle(1, 0xffffff, 0.18);
    for (let x = 0; x <= 40; x++) gfx.lineBetween(x * T, 0, x * T, 24 * T);
    for (let y = 0; y <= 24; y++) gfx.lineBetween(0, y * T, 40 * T, y * T);

    this.walkDebug = gfx;
    this.toast('显示可走区（绿=可走 红=挡住）再按一次关闭');
  }


  /**
   * 更新屏幕上的版本信息（调试用）
   *
   * 为什么要这个：
   *   改完地图后如果浏览器跑的是旧代码，光看画面很难发现。
   *   这里直接把「可走格数」显示出来 —— 和预期值一比就知道对不对。
   *   （home 170 / mailbox 321 / venue 284 / pond 199 / grove 232）
   */
  updateVerLabel() {
    // ★ 版本提示条默认隐藏
    //
    // 这条绿色信息（[54d8a3] venue 可走 284 格 出口 2 / F1 可走区 F2 全图核对）
    // 是开发期的调试信息，正式给玩家看的时候要收起来，避免干扰画面。
    //
    // 但没有删掉 —— F1/F2 那套可走区/全图核对视图是验收流程在用的
    // （见 继续任务.md 8.x），全删了以后排查地图还得重写。
    // 所以保留功能，只把显示藏掉：
    //   想看的时候在控制台执行  window.__venueShowVer = true  再按 F3 刷新即可。
    const SHOW_VER_LABEL = window.__venueShowVer === true;

    if (!SHOW_VER_LABEL) {
      if (this.verLabel) { this.verLabel.destroy(); this.verLabel = null; }
      return;
    }

    const MAPVER = '54d8a3';
    if (!this.verLabel) {
      this.verLabel = this.add.text(10, 10, '', {
        fontFamily: 'Consolas, monospace',
        fontSize: '13px',
        color: '#8fffc0',
        backgroundColor: '#000000cc',
        padding: { x: 8, y: 4 },
      }).setScrollFactor(0).setDepth(100000);
    }
    const sid = this.scenes.current ? this.scenes.current.id : '?';
    const g = this.scenes.getMap(sid);
    let walk = 0;
    if (g) for (let y = 0; y < g.length; y++) for (let x = 0; x < g[y].length; x++) if (g[y][x] === '.') walk++;
    const ex = this.scenes.exits ? this.scenes.exits.length : 0;
    this.verLabel.setText(`[${MAPVER}] ${sid}  可走 ${walk} 格  出口 ${ex}\nF1 可走区  F2 全图核对`);
  }


  /**
   * F2 —— 全图核对视图
   *
   * 把整张地图缩到一屏，叠加可走区/光圈/落点/NPC/互动点。
   * 用途：一屏核对「涂的格子有没有全部落地」，尤其是地图四边 ——
   *       平时相机只显示 1829x1029，边缘看不到。
   */
  toggleFullMap() {
    if (this.fullMap) {
      this.fullMap.destroy();
      this.fullMap = null;
      this.toast('关闭全图');
      return;
    }

    const sid = this.scenes.current.id;
    const g = this.scenes.getMap(sid);
    if (!g) return;

    const W = 2560, H = 1536;
    // 缩到一屏内（留出边距）
    const k = Math.min((this.scale.width - 80) / W, (this.scale.height - 90) / H);
    const ox = (this.scale.width - W * k) / 2;
    const oy = (this.scale.height - H * k) / 2 + 12;

    const box = this.add.container(0, 0).setScrollFactor(0).setDepth(90000);

    // 底板
    const bg = this.add.graphics().setScrollFactor(0);
    bg.fillStyle(0x000000, 0.82);
    bg.fillRect(0, 0, this.scale.width, this.scale.height);
    box.add(bg);

    // 场景背景图（缩小后铺上，便于认出是哪张图）
    const cfg = this.scenes.current;
    // SceneManager 里背景图的纹理 key 是 scene-bg-<场景id>
    const bgKey = 'scene-bg-' + sid;
    if (bgKey && this.textures.exists(bgKey)) {
      box.add(this.add.image(ox, oy, bgKey)
        .setOrigin(0, 0).setDisplaySize(W * k, H * k).setScrollFactor(0).setAlpha(0.85));
    }

    const gfx = this.add.graphics().setScrollFactor(0);

    // 可走 / 挡住
    const T = 64;
    for (let y = 0; y < g.length; y++) {
      for (let x = 0; x < g[y].length; x++) {
        const px = ox + x * T * k, py = oy + y * T * k;
        if (g[y][x] === '.') {
          gfx.fillStyle(0x3cff8c, 0.42);
          gfx.fillRect(px, py, T * k - 0.5, T * k - 0.5);
        } else {
          gfx.fillStyle(0xff3c3c, 0.30);
          gfx.fillRect(px + 1, py + 1, T * k - 2, T * k - 2);
        }
      }
    }

    // 棋格线（每 5 格加粗）
    for (let x = 0; x <= 40; x++) {
      gfx.lineStyle(x % 5 === 0 ? 1.6 : 0.5, 0xffffff, x % 5 === 0 ? 0.5 : 0.16);
      gfx.lineBetween(ox + x * T * k, oy, ox + x * T * k, oy + H * k);
    }
    for (let y = 0; y <= 24; y++) {
      gfx.lineStyle(y % 5 === 0 ? 1.6 : 0.5, 0xffffff, y % 5 === 0 ? 0.5 : 0.16);
      gfx.lineBetween(ox, oy + y * T * k, ox + W * k, oy + y * T * k);
    }
    box.add(gfx);

    // 坐标数字
    for (let x = 0; x <= 40; x += 5) {
      box.add(this.add.text(ox + x * T * k, oy - 16, String(x), {
        fontFamily: 'Consolas, monospace', fontSize: '12px', color: '#9fe8ff' }).setScrollFactor(0).setOrigin(0.5, 0));
    }
    for (let y = 0; y <= 24; y += 5) {
      box.add(this.add.text(ox - 18, oy + y * T * k, String(y), {
        fontFamily: 'Consolas, monospace', fontSize: '12px', color: '#ffd79f' }).setScrollFactor(0).setOrigin(0.5, 0.5));
    }

    // 传送光圈 + 落点
    const ex = this.scenes.exits || [];
    for (const e of ex) {
      const px = ox + e.tileX * T * k, py = oy + e.tileY * T * k;
      gfx.lineStyle(3, 0xffd24a, 1);
      gfx.strokeRect(px, py, e.w * T * k, e.h * T * k);
      const lx = ox + e.toTileX * T * k + T * k / 2, ly = oy + e.toTileY * T * k + T * k / 2;
      gfx.fillStyle(0xff78c8, 1);
      gfx.fillCircle(lx, ly, 4);
      box.add(this.add.text(px + e.w * T * k + 4, py, `→${e.to}`, {
        fontFamily: 'Consolas, monospace', fontSize: '11px', color: '#ffe08a' }).setScrollFactor(0).setOrigin(0, 0));
    }

    // NPC / 互动点 / 道具
    const dot = (tx, ty, color, label) => {
      const px = ox + tx * T * k + T * k / 2, py = oy + ty * T * k + T * k / 2;
      gfx.fillStyle(color, 1);
      gfx.fillCircle(px, py, 4.5);
      gfx.lineStyle(1, 0xffffff, 0.9);
      gfx.strokeCircle(px, py, 4.5);
      if (label) box.add(this.add.text(px + 6, py - 6, label, {
        fontFamily: 'Consolas, monospace', fontSize: '10px', color: '#ffffff' }).setScrollFactor(0));
    };
    for (const n of this.npcs || []) dot(Math.floor(n.x / T), Math.floor(n.y / T), 0xc882ff, n.name || '');
    for (const p of this.interactPoints ? this.interactPoints.points : []) {
      if (this.scenes.current.id === p.scene) dot(p.tileX, p.tileY, 0x50e6e6, p.label || '');
    }
    for (const pr of this.props || []) {
      if (pr.texture && pr.tileX !== undefined) dot(pr.tileX, pr.tileY, 0xffaa3c, '');
    }

    // 玩家
    const pt = Math.floor(this.player.x / T), pty = Math.floor(this.player.y / T);
    dot(pt, pty, 0x3c8cff, '你');

    // 标题
    box.add(this.add.text(ox, oy - 40, `全图核对  ${this.scenes.current.name}（${sid}）   绿=可走 红=挡住  黄框=光圈  粉点=落点`, {
      fontFamily: 'Consolas, monospace', fontSize: '14px', color: '#c8ffd8' }).setScrollFactor(0));

    this.fullMap = box;
  }


  /**
   * 采集交互：按 E 拿到任务物品
   *
   * 交互点里配：
   *   action: 'collectItem'
   *   collectId  任务系统要记的物品 id（要和任务目标的 itemId 对上）
   *   okText     采集时弹出的描述文字
   *
   * 为什么单独做一个（不复用 exchangeItem）：
   *   采集不需要"消耗前置物品"，只管拿和记进度，逻辑更简单。
   */
  doCollectItem(p) {
    if (this.hasItem(p.collectId) && !p.repeatable) {
      this.toast(p.doneHint || '已经拿到了');
      return;
    }
    if (p.collectId) {
      this.giveItem(p.collectId, p.giveName || p.label);
      this.quests.markCollect(p.collectId, 1);
    }
    if (p.okText) {
      this.dialog.open(
        { name: p.label || '采集', portrait: '✋', portraitBg: '#2a3a2e' },
        [{ text: p.okText }],
        null
      );
    }
    this.refreshQuestUI();
  }

  /** 触发交互点 */
  triggerPoint(point) {
    const r = this.interactPoints.trigger();
    if (!r) return;

    if (r.type === 'desk') {
      // 书桌前的两种情况：还没写完 → 写下一封；写完了 → 把桌上的信收起来
      if (!this.story.allWritten) {
        this.startLetterWriting();
      } else if (this.story.onDeskCount > 0) {
        const n = this.story.takeLetters();
        this.toast(`收起了 ${n} 封邀请函`);
        this.gainToast(`邀请函 x${n}`);
      } else {
        this.toast('邀请函都收好了');
      }
    } else if (r.type === 'takeLetters') {
      if (r.ok) {
        this.toast(`收起了 ${r.count} 封邀请函`);
        this.gainToast(`邀请函 x${r.count}`);
      } else {
        this.toast('桌上没有信');
      }
    } else if (r.type === 'deliver') {
      if (r.ok) {
        this.gainToast('邀请函已寄出');
      } else {
        this.toast('要先从书桌把信拿走');
      }
    } else if (r.point && r.point.action === 'exchangeItem') {
      this.doExchangeItem(r.point);
    } else if (r.point && r.point.action === 'collectItem') {
      this.doCollectItem(r.point);
    } else {
      this.toast(point.hint || point.label);
    }
  }

  // ---------------------------------------------------------------------------
  // 写邀请函（书桌前的信纸过场）
  // ---------------------------------------------------------------------------
  /**
   * 写「下一封」邀请函。
   *
   * 为什么是一封一封写、而不是一次性写完 11 封：
   *   邀请函的每一封正文都不一样（11 封信，13 位客人，林尼/琳妮特/菲米尼
   *   三个人共收一封）。一封一封地展开，才能把每一封都真的念一遍；
   *   一口气写完 11 封，就只能看到一张纸。
   *
   * 收到的那一封是 StorySystem 里的哪个 nextGuest()：
   *   GUESTS 的顺序 = 邀请函 docx 里的出场顺序，
   *   所以写出来的顺序和用户手里那叠信的顺序是一致的。
   */
  startLetterWriting() {
    // 已经打开（比如连按了两下 E）就不重复开
    if (this.letter.isOpen()) return;

    const guest = this.story.nextGuest();
    if (!guest) {
      this.toast('邀请函都写完了');
      return;
    }

    // 「写的是第几封」——用【已经写好多少封】来算，不能用 story 里此刻的 onDeskCount：
    // onDesk 要等这封写完了才 +1，而这里是在打开信纸之前取的值。
    const index = this.story.writtenCount;
    const total = this.story.totalCount;

    this.letter.open(guest, {
      index,
      total,
      onDone: (g) => {
        const written = this.story.writeLetter();
        if (!written) return;
        this.toast(`写好了：${written.name}`);
        this.gainToast(`邀请函「${written.name}」`);
        // 全部写完 → 提示下一步（quests 那边已经自动把 main-write 标完成）
        if (this.story.allWritten) {
          this.time.delayedCall(700, () => this.toast('桌上已经摞好了全部邀请函，按 E 收起来'));
        }
      },
    });
  }

  // ---------------------------------------------------------------------------
  // 对话（仙剑风格：大头像 + 对话框）
  // ---------------------------------------------------------------------------
  startDialog(npc) {
    const lines = this.buildDialogLines(npc);
    this.dialog.open(npc, lines, () => {
      if (!npc.talked) npc.talked = true;
      this.quests.markTalked(npc.id);
    });
  }

  buildDialogLines(npc) {
    const lines = [...(npc.dialog || [])];
    const here = this.scenes.current ? this.scenes.current.id : 'venue';

    for (const q of QUESTS) {
      if (q.special) continue;   // 主线不走 NPC 发放

      const state = this.quests.getState(q);
      const isGiver = q.giverNpcId === npc.id;
      const isDeliver = (q.deliverNpcId || q.giverNpcId) === npc.id;

      // 可接取
      if (isGiver && state === 'available') {
        lines.push({
          text: `对了，有件事想请你帮忙。\n【${q.title}】\n${q.desc}\n完成后给你：${q.reward}`,
          link: { label: '接下委托', action: 'accept', questId: q.id },
        });
      }

      // 进行中
      if (isGiver && state === 'active') {
        lines.push({
          text: `【${q.title}】还在进行中\n${this.questHint(q)}`,
        });
      }

      // 可交付
      if (isDeliver && state === 'ready') {
        lines.push({
          text: `【${q.title}】\n你办好了！这是答应给你的谢礼：${q.reward}`,
          link: { label: '交付委托', action: 'deliver', questId: q.id },
        });
      }

      // 已交付
      if (isDeliver && state === 'completed') {
        lines.push({ text: `【${q.title}】已经完成啦，多谢你。` });
      }
    }

    // ---- NPC 功能入口（小游戏 / 单品）----
    //
    // ★ 必须等这个 NPC 的委托【交付完成】之后才显示。
    //   之前是无条件加进去，结果玩家刚进会场、委托还没做，
    //   对话里就冒出"打开小游戏"之类的选项 —— 像是跳过了流程。
    //
    //   规则：找到这个 NPC 派发/接收的委托，全部 completed 才放行。
    const myQuests = QUESTS.filter(
      (x) => x.giverNpcId === npc.id || x.deliverNpcId === npc.id
    );
    const allDone = myQuests.length > 0
      && myQuests.every((x) => this.quests.getState(x) === 'completed');

    if (allDone) {
      (npc.offers || []).forEach((o) => {
        lines.push({
          text: o.text || '要不要看看这个？',
          link: { label: o.label, url: o.url, newTab: !!o.newTab },
        });
      });
    } else if (myQuests.length) {
      lines.push({ text: '（把委托办完，我还有别的东西给你看）' });
    }

    return lines;
  }

  questHint(q) {
    const t = q.target;
    if (t.type === 'visit') {
      const s = SCENES.find((x) => x.id === (t.scene || q.scene));
      const item = t.needLabel || '目标地点';
      return `${item}　→　${s ? s.name : '未知地点'}`;
    }
    if (t.type === 'talk') {
      const n = NPCS.find((x) => x.id === t.npcId);
      return `去找「${n ? n.name : t.npcId}」`;
    }
    if (t.type === 'writeLetters') {
      return `已经写了 ${this.quests.getCounter(q.id)} / ${t.count} 封`;
    }
    if (t.type === 'deliverLetters') {
      return '把邀请函投进信箱';
    }
    if (t.type === 'openGame') return '玩一次小游戏';
    return '';
  }

  handleGotoQuest(questId) {
    const q = QUESTS.find((x) => x.id === questId);
    if (!q) return;
    // 现在用箭头引导，点击「前往」只给出文字提示
    const t = q.target;
    if (t && t.type === 'visit') {
      const s = SCENES.find((x) => x.id === (t.scene || q.scene));
      this.toast(`目标在「${s ? s.name : '未知'}」，跟着金色箭头走`);
    } else {
      this.toast('跟着金色箭头走');
    }
  }

  handleQuestAction(action, questId) {
    const q = QUESTS.find((x) => x.id === questId);
    if (!q) return;

    if (action === 'accept') {
      if (this.quests.accept(q)) {
        this.toast(`已接取：${q.title}`);
        // 接任务时发放的东西（比如打水任务给一个空桶）
        if (q.onAcceptGive) this.giveItem(q.onAcceptGive.id, q.onAcceptGive.name);
        this.refreshQuestUI();
      }
    } else if (action === 'deliver') {
      if (this.quests.deliver(q)) {
        this.gainToast(q.reward);
        this.refreshQuestUI();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 任务目标检测
  // ---------------------------------------------------------------------------
  handleQuestVisit() {
    const tx = Math.floor(this.player.x / TILE_SIZE);
    const ty = Math.floor(this.player.y / TILE_SIZE);
    const sceneId = this.scenes.current ? this.scenes.current.id : 'venue';

    // 检查是否有进行中的 visit 类任务被达成
    for (const q of QUESTS) {
      if (this.quests.getState(q) !== 'active') continue;
      const t = q.target;
      if (t.type !== 'visit') continue;

      const tScene = t.scene || q.scene || 'venue';
      if (tScene !== sceneId) continue;

      const dx = Math.abs(t.tileX - tx);
      const dy = Math.abs(t.tileY - ty);
      const r = t.radius ?? 1;

      if (dx <= r && dy <= r) {
        // 到达目标点
        this.quests.markVisit(q.id);
        this.gainToast(t.needLabel || '任务物品');
        return;
      }
    }

    // 剧情任务计数（写邀请函 / 投递）由交互点直接推进，这里不用管
  }

  // ---------------------------------------------------------------------------
  /** 世界地图：M 键开关（只有这一张图，不做格子小地图） */
  handleMinimap() {
    if (!this.minimap) return;

    if (Phaser.Input.Keyboard.JustDown(this.keyM)) {
      const on = this.minimap.toggle();
      if (on) this.toast('世界地图');
    }

    this.minimap.draw({
      sceneId: this.scenes.current ? this.scenes.current.id : 'venue',
      guide: this.getGuideTarget(),
    });
  }

  showSceneIntro2() { /* 保留占位 */ }
}
