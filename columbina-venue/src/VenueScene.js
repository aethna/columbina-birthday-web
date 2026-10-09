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
import { preloadCharacters, setupCharacters, createCharSprite, CHARACTER_FRAME, DIR_ROW } from './characters.js';
import DialogSystem from './DialogSystem.js';
import LetterSystem from './LetterSystem.js';
import QuestSystem from './QuestSystem.js';
import SceneManager from './SceneManager.js';
import Minimap from './Minimap.js';
import StorySystem from './StorySystem.js';
import InteractPointSystem from './InteractPoints.js';
import {
  PARTY_TABLE, PARTY_SEATS, PARTY_HERO, PARTY_SHADOW_DEPTH, PARTY_BLOCKS, isPartyTime,
} from './celebration.js';
import { CAKE_ART } from './cutscene.js';
import { partyTalkOf, PHOTO_PROMPT, OFFER_PROMPT } from './party-talk.js';

/**
 * 全屏插画（切蛋糕 / 合影）的绘制层级
 *
 * 必须压过现有的一切：
 *   9000   交互点原来那一层 + 顶部提示条
 *   9500   小地图
 *   10000  小游戏
 * 12000 放最上面，保证插画期间屏幕上只剩它和「点击收起」那一行字。
 */
const D_OVERLAY = 12000;

/**
 * 由移动向量取朝向名（8 方向）
 *
 *   两轴都非零 → 斜向（右下 / 左下 / 右上 / 左上）
 *   只有一个轴 → 上下左右
 *
 * 名字必须连写（downright），不能写成 down-right：
 * safePlay() 用 `suffix.split('-')[1]` 取方向名，横线会被截断。
 *
 * 注意：要在 vx/vy 归一化【之前】调用 —— 归一化会把 ±1 变成 ±0.707，
 * 但符号不变，所以其实取符号就够，这里只是顺手放在前面更直观。
 *
 * @returns {string|null} 两轴都为 0 时返回 null
 */
export function dirNameFrom(vx, vy) {
  const sx = Math.sign(vx);
  const sy = Math.sign(vy);
  if (sx && sy) {
    if (sy > 0) return sx > 0 ? 'downright' : 'downleft';
    return sx > 0 ? 'upright' : 'upleft';
  }
  if (sx) return sx > 0 ? 'right' : 'left';
  if (sy) return sy > 0 ? 'down' : 'up';
  return null;
}

export default class VenueScene extends Phaser.Scene {
  constructor() {
    super({ key: 'VenueScene' });
    this.npcs = [];
    this.activeNpc = null;
    // 庆功宴（所有委托完成后的围桌形态）是否已开启
    this.party = false;
    this.partyObjs = [];
    // 围坐 NPC 的互动对象（大合影完成前是空的可互动集合，见 spawnParty / enablePartyTalk）
    this.seatedNpcs = [];
    this.activeSeat = null;
    // 围坐 NPC 现在能不能搭话：切完蛋糕（大合影看过）才放开
    this.partyTalk = false;
    // 全屏插画（切蛋糕 / 合影）的临时对象；非 null 就表示正在展示
    this.overlay = null;
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

    // 庆功宴贴图（大桌子 + 14 张坐姿）
    //
    // 和道具一样必须在这里排队加载：spawnParty() 在切场景时才跑，
    // 那时临时 load 来不及解码。用资源路径当 texture key，简单且不会撞名。
    this.load.image(PARTY_TABLE.tex, PARTY_TABLE.tex);
    PARTY_SEATS.forEach((s) => {
      if (!this.textures.exists(s.tex)) this.load.image(s.tex, s.tex);
    });

    // 切蛋糕的全屏插画（所有人围坐 + 哥伦比娅切蛋糕）
    //   同样必须提前排队：玩家在主位按 E 那一刻再 load 是来不及解码的。
    if (!this.textures.exists(CAKE_ART.tex)) {
      this.load.image(CAKE_ART.tex, CAKE_ART.tex);
    }
    // 合影成图（哥伦比娅 + 这位客人 + 他所在场景的背景，tools/gen-photo.py 离线拼的）
    //
    // ★ 只给受邀客人排队。空（npc-aether）没有合影素材，
    //   给他排队只会让 loader 报 loaderror（图不存在）。
    //
    // ★ 注意：合影【背景】图（assets/cutscene/bg-*.png）不在游戏里加载 ——
    //   它只是 tools/gen-photo.py 的拼图素材，拼好的成图已经把背景吃进去了。
    //   在运行时多排队 8 张 1536×1024 纯属浪费带宽和显存。
    NPCS.forEach((n) => {
      if (!n.guest) return;
      const tex = `assets/cutscene/photo-${n.id}.png`;
      if (!this.textures.exists(tex)) this.load.image(tex, tex);
    });

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
    this.player.setDepth(this.isBehindPartyTable() ? PARTY_HERO.depth : 500);
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
    this.playerShadow.setDepth(this.isBehindPartyTable() ? PARTY_SHADOW_DEPTH : 499);

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

      // ★ 委托状态一变就判一次「是不是全做完了」——
      //   这样用户以后往 QUESTS 里加新委托，庆功宴自动跟着新清单走。
      if (kind === 'delivered' || kind === 'completed' || kind === 'ready') {
        this.time.delayedCall(400, () => this.maybeStartParty());
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

    // ★ 存档里委托可能早就全做完了 —— 那进游戏就该直接是围桌形态
    this.maybeStartParty();

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

    // ★ 书桌那一个交互点要跟着剧情走
    //   （v5 起它只有「写」一种状态，11 封写完后 requires 不成立、点直接消失；
    //     这里 rebuild 是为了让"刚写满最后一封"时它立刻消失，而不是等切场景）
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
  // 站姿 NPC 的「模型占格」禁行区
  //
  // 需求（2026-10-08 第七轮）：
  //   - 站姿 NPC 分散到各个场景，站在【可走格】上（不再站禁行格）；
  //   - 但放下去之后，NPC 模型【长宽所占的所有格子】都要变成主角禁行区 ——
  //     不只是落点那一格。否则哥伦比娅会走到 NPC 身上，看起来像踩在他头上。
  //
  // 为什么必须整块封：
  //   主角的 depth 是 500 + y*0.001，NPC 是 300 + y*0.001 ——
  //   主角【永远】画在 NPC 之上，所以只要两个人的模型在屏幕上重叠，
  //   就是「哥伦比娅踩在 NPC 头上」。封掉模型占的每一格才是根因修复。
  //
  // 立绘锚点是 origin=(0.5, 0.85)（见 characters.js），所以：
  //   头顶 = y - 0.85h    脚底 = y + 0.15h    左右 = x ± 宽/2
  // ---------------------------------------------------------------------------

  /** 算出某个 NPC 模型在世界坐标里的包围盒 */
  npcModelRect(def, info) {
    const x = def.tileX * TILE_SIZE + TILE_SIZE / 2;
    const y = def.tileY * TILE_SIZE + TILE_SIZE / 2;
    const h = def.displayHeight || 160;

    let aspect = 0.55;
    const src = this.textures.get(info.key).getSourceImage?.();
    if (src && src.height) aspect = src.width / src.height;

    const w = h * aspect;
    return {
      x, y, w, h,
      left: x - w / 2,
      right: x + w / 2,
      top: y - 0.85 * h,
      bottom: y + 0.15 * h,
    };
  }

  /** 世界包围盒 -> 格子包围盒 [x0,y0,x1,y1]（含头含尾） */
  tileRectOf(mr) {
    return [
      Math.floor(mr.left / TILE_SIZE + 1e-6),
      Math.floor(mr.top / TILE_SIZE + 1e-6),
      Math.floor((mr.right - 1e-6) / TILE_SIZE),
      Math.floor((mr.bottom - 1e-6) / TILE_SIZE),
    ];
  }

  /**
   * 把所有场景里站姿 NPC 的模型占格登记成禁行区
   *
   * 每次「客人到没到 / 庆功宴开没开」变化后都要重算一遍：
   *   · 还没收到邀请函的客人不出现 -> 也不该封格
   *   · 庆功宴期间会场里的站姿全部撤走 -> 那一片改由 PARTY_BLOCKS 负责
   */
  refreshNpcBlocks() {
    if (!this.scenes || !this.charInfo) return;

    const byScene = new Map();
    NPCS.forEach((def) => {
      const sceneId = def.scene || 'venue';
      const info = this.charInfo[def.id];
      if (!info) return;

      // 需要受邀的客人，还没到就没有模型
      if (def.guest && !this.story.isGuestArrived(def.id)) return;
      // 庆功宴：会场的站姿全部换成围坐
      if (this.party && sceneId === 'venue') return;

      const r = this.tileRectOf(this.npcModelRect(def, info));
      if (!byScene.has(sceneId)) byScene.set(sceneId, []);
      byScene.get(sceneId).push(r);
    });

    // 每个场景都登记一遍（没有的传空数组 = 清掉旧登记）
    SCENES.forEach((s) => {
      const blocks = byScene.get(s.id) || [];
      this.scenes.setBlockSource(`npc:${s.id}`, s.id, blocks);
    });
  }

  // ---------------------------------------------------------------------------
  // 庆功宴：所有委托完成 → 所有人消失，围坐到带生日蛋糕的大桌子旁
  //
  // 需求（2026-10-07）：
  //   - 触发条件是「所有委托都完成」，而且要【动态】判定 ——
  //     用户还会继续往里加委托，加完不用回来改代码；
  //   - 触发后林间空地：NPC 全部消失、改摆坐姿围桌、桌子出现；
  //   - 哥伦比娅不坐下，站在主位（左边两位旅行者、右边桑多涅）；
  //   - ★ 桌子与每个坐姿模型【实际压住的所有格子】都要变禁行区，
  //     不只是落点格 —— 否则哥伦比娅会走到 NPC 的模型上面去。
  // ---------------------------------------------------------------------------

  /** 判定是否该开庆功宴；返回 true 表示「刚刚开启」 */
  maybeStartParty() {
    if (this.party) return false;
    if (!this.quests || !isPartyTime(this.quests)) return false;

    this.party = true;
    console.log('[庆功宴] 所有委托已完成，切到围桌庆祝形态');

    // ★ 禁行格交给 SceneManager 统一管理：它会跟着场景加载一起重建，
    //   所以在别的场景里切过去也照样生效。
    if (this.scenes) this.scenes.setExtraBlocks('venue', PARTY_BLOCKS);

    // 会场里的站姿全部撤走 -> 它们的模型占格也要一起撤掉（哪怕当前不在会场，
    // 因为玩家随时可能走回来，禁行区必须按最新状态登记好）
    this.refreshNpcBlocks();

    if (this.scenes && this.scenes.current && this.scenes.current.id === 'venue') {
      // 主角挪到主位（那里是专门留出来的站立空档）
      this.placeHeroAtPartySpot();
      this.spawnNpcsForCurrentScene();
      // ★ 切蛋糕那个交互点带 requires:'partyTime' + hideWhenUnavailable，
      //   宴会没开的时候根本不会建。这里必须重建一次 ——
      //   否则玩家恰好在会场里完成最后一个委托时，人已经站到主位了，
      //   但地上没有光圈、按 E 也没反应，得退出会场再进来才出现。
      this.interactPoints.rebuild(this.scenes.current.id);
      // ★ 相机取景：围桌这一坨（桌子+坐姿）在世界 y 384~1024，中心约 y=704；
      //   而主位在 y≈608。相机若以主角为正中（视野高 1029），可见范围是 94~1123，
      //   桌子下方（近排脚底 1002）就贴到屏幕底边了。
      //   setFollowOffset(0,-96) 让视野中心落到 y=704 → 可见 190~1219，整桌人都在画面里。
      this.camPartyOffset = -96;
      this.cameras.main.setFollowOffset(0, this.camPartyOffset);
      this.cameras.main.flash(420, 255, 236, 170);
      this.toast('所有委托都完成了 —— 大家围到了蛋糕旁');
    }

    // ★ 结局任务「【结局】切蛋糕」是在 allDone() 之后才由 snapshot() 放出来的，
    //   而任务面板只在 refreshQuestUI() 时重新渲染。
    //   玩家在别的地图里做完最后一个委托时，面板停在旧的一版上 ——
    //   回到会场也看不到「切蛋糕」那一条（用户 2026-10-09 反馈 2 的另一半）。
    //   庆功宴一开就重刷一次，保证这条一定出现在列表里。
    this.refreshQuestUI();

    return true;
  }

  /**
   * 庆功宴取景：围桌时把相机跟随点往上抬，让整桌人都进画面。
   *
   * 具体数值见 maybeStartParty() 里的说明（-96 是照桌子包围盒算出来的，不是拍的）。
   */
  applyPartyCamera(on) {
    if (!this.cameras || !this.cameras.main) return;
    const want = on ? -96 : 0;
    if (this.camPartyOffset === want) return;
    this.camPartyOffset = want;
    this.cameras.main.setFollowOffset(0, want);
  }

  /** 把哥伦比娅放到主位（并确保不在新的禁行格里） */
  placeHeroAtPartySpot() {
    if (!this.player) return;
    const tx = Math.floor(PARTY_HERO.x / TILE_SIZE);
    const ty = Math.floor(PARTY_HERO.y / TILE_SIZE);
    const safe = this.scenes.sanitizeArrive({ tileX: tx, tileY: ty }, this.scenes.current);
    this.player.setPosition(
      safe.tileX * TILE_SIZE + TILE_SIZE / 2,
      safe.tileY * TILE_SIZE + TILE_SIZE / 2
    );
    this.player.setVelocity(0, 0);
  }

  // ---------------------------------------------------------------------------
  // 全屏插画：切蛋糕 / 合影
  //
  // 需求：
  //   任务2「互动后，全屏显示这个图。点击鼠标收起。」
  //   任务4「合影直接用哥伦比娅立绘 + NPC 立绘 + 背景拼接即可」
  //
  // 实现要点：
  //   · 用一个 this.overlay 数组管住所有临时对象，收起时一次性销毁；
  //   · update() 见到 this.overlay 就把玩家冻住
  //     （不然玩家能一边看图一边把哥伦比娅走出去，回来时人在别处）；
  //   · 相机 zoom 不是 1（applyCameraFit 按窗口算出来的），
  //     而 setScrollFactor(0) 的对象照样会被 zoom 缩放，
  //     所以尺寸要【除以 zoom】才是屏幕上的像素数。
  // ---------------------------------------------------------------------------

  /**
   * 铺一张全屏插画，点击任意处收起
   *
   * @param {string} tex 贴图 key（就是资源路径）
   * @param {string} tip 底部那行提示
   * @returns {boolean} 是否铺上了（贴图没加载好会返回 false）
   */
  showOverlay(tex, tip = '点击任意处收起') {
    if (this.overlay) return false;
    if (!this.textures.exists(tex)) {
      console.warn('[插画] 贴图不存在：', tex);
      return false;
    }

    const cam = this.cameras.main;
    const z = cam.zoom || 1;
    const vw = cam.width / z;    // 相机空间里能看到的宽（= 屏幕像素 / zoom）
    const vh = cam.height / z;
    const cx = cam.width / 2;
    const cy = cam.height / 2;

    const veil = this.add.rectangle(cx, cy, vw, vh, 0x000000, 0.78)
      .setScrollFactor(0).setDepth(D_OVERLAY);

    const img = this.add.image(cx, cy, tex)
      .setScrollFactor(0).setDepth(D_OVERLAY + 1);
    // 等比缩放到画面内（留一圈边，免得顶到屏幕边）
    const s = Math.min((vw * 0.94) / img.width, (vh * 0.86) / img.height);
    img.setScale(s);

    const tipObj = this.add.text(cx, cy + vh * 0.43, tip, {
      fontFamily: 'system-ui, "Microsoft YaHei", sans-serif',
      fontSize: '26px',
      color: '#ffe9b8',
      backgroundColor: '#000000cc',
      padding: { x: 14, y: 8 },
    }).setOrigin(0.5).setScrollFactor(0).setDepth(D_OVERLAY + 2);

    this.overlay = [veil, img, tipObj];

    // 点一下收起。用 once —— 收起后这里会重新挂一次，不会越积越多。
    this.input.once('pointerdown', () => this.closeOverlay());
    return true;
  }

  /** 收起全屏插画 */
  closeOverlay() {
    if (!this.overlay) return;
    this.overlay.forEach((o) => o.destroy());
    this.overlay = null;
  }

  /**
   * 铺「所有人围坐、哥伦比娅切蛋糕」那张大合影（只看图，不改任务状态）
   *
   * 拆出来的原因：切完蛋糕之后还会从围坐 NPC 的「查看合影」再调一次，
   * 那时候任务早就是 completed 了，不该重复走完成逻辑。
   */
  showCakeArt() {
    if (this.overlay) return false;
    if (!this.showOverlay(CAKE_ART.tex, '点击任意处收起')) {
      this.toast('插画还没准备好，稍后再试');
      return false;
    }
    return true;
  }

  /**
   * 切蛋糕：全屏展示那张「所有人围坐、哥伦比娅切蛋糕」的插画
   *
   * 位置由交互点 ip-party-cake 决定（庆功宴主位，也就是哥伦比娅站的那格）。
   *
   * ★ 看完这张图 = 大合影拍完了 → 放开 14 位围坐 NPC 的搭话（用户 m09394）。
   */
  showCakeCutscene() {
    if (!this.showCakeArt()) return;
    // 看到图 = 切了蛋糕 -> 任务列表里那一条直接算完成
    if (this.quests && this.quests.completeById) {
      this.quests.completeById('q-party-cake');
    }
    this.enablePartyTalk();
  }

  /**
   * 合影：展示「哥伦比娅 + 这位 NPC + 当前场景背景」拼好的那张图
   *
   * 拼图是在 offline 阶段做好放进 assets/cutscene/photo-<npcId>.png 的
   * （见 tools/gen-photo.py），运行时只负责把它铺满屏幕 ——
   * 这样不用在浏览器里现拼，省得每次都要重算缩放和站位。
   */
  showPhoto(npc) {
    if (!npc) return;
    const tex = `assets/cutscene/photo-${npc.id}.png`;
    if (!this.showOverlay(tex, `与 ${npc.name} 的合影 —— 点击任意处收起`)) {
      this.toast('合影还没准备好，稍后再试');
      return;
    }
    this.toast(`咔嚓！和${npc.name}的合影拍好了`);
  }

  /** 清掉上一轮的庆祝贴图 */
  clearParty() {
    if (this.partyObjs) this.partyObjs.forEach((o) => o.destroy());
    this.partyObjs = [];
    // 围坐 NPC 的图标/名牌也在 partyObjs 里，一起没了；把逻辑侧一起清空
    this.seatedNpcs = [];
    this.activeSeat = null;
    this.partyTalk = false;
  }

  /**
   * 摆出庆祝态：大桌子 + 14 张坐姿 + 影子 + （切完蛋糕后）14 个可搭话的围坐 NPC
   *
   * ★ 围坐 NPC 的互动规则（用户 m09394）：
   *   「坐姿 NPC 出现后、到大合影完成前是【不能】互动的；
   *     大合影完成后，所有坐姿 NPC 此时可以互动。」
   *   所以这里先把图标建出来但 setVisible(false)，
   *   只有 partyTalk = true（= q-party-cake 已完成）时才亮起来、才参与接近检测。
   */
  spawnParty() {
    const tbl = this.add.image(PARTY_TABLE.x, PARTY_TABLE.y, PARTY_TABLE.tex)
      .setOrigin(0, 0)
      .setDepth(PARTY_TABLE.depth);
    tbl.setDisplaySize(PARTY_TABLE.w, PARTY_TABLE.h);
    this.partyObjs.push(tbl);

    PARTY_SEATS.forEach((s) => {
      if (!this.textures.exists(s.tex)) return;
      const src = this.textures.get(s.tex).getSourceImage();
      const sh = this.add.ellipse(
        s.x, s.y - 2,
        Math.max(30, s.h * 0.30), Math.max(10, s.h * 0.10),
        0x000000, 0.25
      ).setDepth(s.depth - 1);

      const im = this.add.image(s.x, s.y, s.tex)
        .setOrigin(0.5, 1)
        .setDepth(s.depth);
      if (src && src.height) im.setScale(s.h / src.height);

      this.partyObjs.push(sh, im);

      // ---- 围坐 NPC 的可搭话外壳 ----
      //
      // 为什么图标深度用 9000：和站姿 NPC 的图标一致（见 spawnNpcsForCurrentScene）。
      // 围坐贴图深度是 400/460，若图标也用 420 会被近排（460）盖住。
      const def = NPCS.find((n) => n.id === s.id || n.id === `npc-${s.id}`);
      if (!def) return;

      const icon = this.add.text(s.x, s.y - s.h - 26, def.icon || '💬', {
        fontSize: '24px',
      }).setOrigin(0.5).setDepth(9000).setVisible(false);

      const nameObj = this.add.text(s.x, s.y - s.h - 4, def.name, {
        fontFamily: 'system-ui, "Microsoft YaHei", sans-serif',
        fontSize: '13px',
        color: '#dfe9f7',
        backgroundColor: '#000000cc',
        padding: { x: 6, y: 2 },
      }).setOrigin(0.5).setDepth(9000).setVisible(false);

      this.partyObjs.push(icon, nameObj);

      // 模型包围盒：origin(0.5, 1) + setScale -> 上边 y-h、下边 y、左右各 w/2
      const w = src && src.height ? src.width * (s.h / src.height) : s.h;
      this.seatedNpcs.push({
        ...def,
        x: s.x, y: s.y, seat: s, seated: true,
        icon, nameObj, iconText: def.icon || '💬', talked: false,
        rect: { left: s.x - w / 2, right: s.x + w / 2, top: s.y - s.h, bottom: s.y },
      });
    });

    // 进会场时如果蛋糕早切过了，直接放开互动（不然要重开一次才亮）
    if (this.partyTalkReady()) this.enablePartyTalk();

    console.log(`[庆功宴] 摆出桌子 + ${PARTY_SEATS.length} 张坐姿（可搭话 ${this.partyTalk ? this.seatedNpcs.length : 0} 位）`);
  }

  /** 大合影（= 切蛋糕）看过了没 */
  partyTalkReady() {
    if (!this.quests) return false;
    if (typeof this.quests.getState !== 'function') return false;
    const q = QUESTS.find((x) => x.id === 'q-party-cake');
    if (!q) return false;
    return this.quests.getState(q) === 'completed';
  }

  /**
   * 放开围坐 NPC 的互动：亮起图标 + 名牌
   *
   * 幂等 —— 切蛋糕的那一刻会调一次，之后每次进会场由 spawnParty 兜一次。
   */
  enablePartyTalk() {
    this.partyTalk = true;
    this.seatedNpcs.forEach((n) => {
      if (n.icon) n.icon.setVisible(true);
      if (n.nameObj) n.nameObj.setVisible(true);
    });
  }

  // ---------------------------------------------------------------------------
  // NPC
  // ---------------------------------------------------------------------------
  spawnNpcsForCurrentScene() {
    // 清掉旧的
    this.clearParty();
    // 一离开会场就恢复默认取景
    this.applyPartyCamera(false);
    this.npcs.forEach((n) => {
      if (n.body) n.body.destroy();
      if (n.icon) n.icon.destroy();
      if (n.nameObj) n.nameObj.destroy();
      if (n.shadow) n.shadow.destroy();
    });
    this.npcs = [];
    this.activeNpc = null;

    // 站姿 NPC 的模型占格跟着「客人到没到」一起重算
    this.refreshNpcBlocks();

    const sceneId = this.scenes.current ? this.scenes.current.id : SCENES[0].id;

    // ★ 庆功宴形态：本场景的 NPC 一个都不站，全部换成围坐
    if (this.party && sceneId === 'venue') {
      this.spawnParty();
      this.applyPartyCamera(true);
      return;
    }

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
      // ★ 2026-10-05 按用户要求撤掉鼠标点 NPC 对话
      //
      //   原来这里是：
      //     body.setInteractive({ useHandCursor: true });
      //     ... 后面 body.on('pointerdown', () => this.startDialog(npc));
      //
      //   问题：鼠标点哪都能开对话，**不检查距离** ——
      //   哥伦比娅站在地图另一头，点一下远处的 NPC 也能聊，
      //   把「走到他身边」这个动作整个绕过去了。
      //   现在只剩「走近 → 头顶冒 E 提示 → 按 E」这一条路。
      //   （已核对：没有任何验收脚本靠点击 NPC，删掉不会破坏 _verify_*。）

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

      const npc = {
        ...def, x, y, body, icon, nameObj: name, info, shadow,
        iconText: def.icon || '💬', talked: false,
        // 模型的世界包围盒（模型占格 = 这个盒子换算出来的格子，见 refreshNpcBlocks）
        rect: this.npcModelRect(def, info),
      };
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
    // ★ 流程（v5）：写信 → 投递，只有两步。
    //   第 1 封在书桌写完的瞬间，那封信就已经"收进信封、揣进怀里"了
    //   （见 StorySystem.writeLetter），所以中途不需要再回书桌"收起来"。
    //     步骤1：还没写满 11 封 → 去书桌
    //     步骤2：11 封都写好了、还没投递 → 去信箱
    //   之前这里判的是 onDeskCount / carriedCount，是"信先堆桌上、再按 E 收"
    //   那版流程的残留：onDesk 现在恒为 0（第 1 步成了死代码，而且引用的
    //   ip-letters 早已不存在），carriedCount 又会在第 1 封就 > 0，会把玩家
    //   在第 1 封之后就引去信箱 —— 和用户反馈的"投递卡死"是同一类误导。

    // 步骤1：还没写完 → 去书桌
    if (!this.story.allWritten) {
      if (here === 'home') {
        return this.pointPos('ip-desk');
      }
      return this.exitPosTo('home');
    }

    // 步骤2：11 封都写好了但没投递 → 去信箱
    if (!this.story.isDelivered) {
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
            return { x: npcDef.tileX * TILE_SIZE + 32, y: npcDef.tileY * TILE_SIZE + 32, crossScene: false, sceneId: npcDef.scene || 'venue' };
          }
          return this.exitPosTo(npcDef.scene || 'venue');
        }
      }

      // 未完成 → 去目标地点
      if (t.type === 'visit') {
        const tScene = t.scene || active.scene || 'venue';
        if (tScene === here) {
          return { x: t.tileX * TILE_SIZE + 32, y: t.tileY * TILE_SIZE + 32, crossScene: false, sceneId: here };
        }
        return this.exitPosTo(tScene);
      }

      // ★ 采集类委托（池塘捉鱼 / 打水 / 采花 / 采蘑菇 / 捡柴）
      //
      //   修理由于：目标地点写在**交互点**上，不在任务里 ——
      //   5 条委托的 `q.scene` 都是 'venue'（那是发布任务的 NPC 所在场景），
      //   真正要去的池塘 / 秘境在 pond / grove。
      //   早先这里没有 collect 分支，于是会掉到最下面「去找委托官」那条，
      //   点「前往」把已经接了任务的玩家又指回会场 —— 用户 2026-10-05 报的
      //   「提示错地图」有一半来自这里。
      if (t.type === 'collect') {
        const ip = INTERACT_POINTS.find((x) => x.questId === active.id);
        if (ip) {
          if (ip.scene === here) {
            return {
              x: ip.tileX * TILE_SIZE + 32,
              y: ip.tileY * TILE_SIZE + 32,
              crossScene: false,
              sceneId: here,
            };
          }
          return this.exitPosTo(ip.scene);
        }
      }

      if (t.type === 'talk' && t.npcId) {
        const npcDef = NPCS.find((n) => n.id === t.npcId);
        if (npcDef) {
          if ((npcDef.scene || 'venue') === here) {
            return { x: npcDef.tileX * TILE_SIZE + 32, y: npcDef.tileY * TILE_SIZE + 32, crossScene: false, sceneId: npcDef.scene || 'venue' };
          }
          return this.exitPosTo(npcDef.scene || 'venue');
        }
      }

      // ★ 交互点类委托（结局「切蛋糕」）
      //
      //   q-party-cake 的 target 是 { type: 'interact', count: 1 }，
      //   目标位置同样写在**交互点**上（ip-party-cake → 会场主位 19,9），不在任务里。
      //
      //   早先这里没有 interact 分支，于是它一个都不匹配，一路掉到最下面
      //   「去找委托官」—— 而那时所有委托都已经完成、没有 available 的了，
      //   getGuideTarget() 直接 return null，任务面板点「前往」只会弹
      //   「没有需要前往的地方」。
      //   用户 2026-10-09 报的「结局切蛋糕点击前往，提示没有要前往的地方」就是这个。
      if (t.type === 'interact') {
        const ip = INTERACT_POINTS.find((x) => x.questId === active.id);
        if (ip) {
          // actionLabel 让 handleGotoQuest 报出「去干什么」，
          // 不然同场景只会说一句「找找发光的地方」，玩家仍然不知道要去哪
          const label = ip.label || active.title || '目标地点';
          if (ip.scene === here) {
            return {
              x: ip.tileX * TILE_SIZE + 32,
              y: ip.tileY * TILE_SIZE + 32,
              crossScene: false,
              sceneId: here,
              actionLabel: label,
            };
          }
          const exit = this.exitPosTo(ip.scene);
          if (exit) exit.actionLabel = label;
          return exit;
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
          return { x: npcDef.tileX * TILE_SIZE + 32, y: npcDef.tileY * TILE_SIZE + 32, crossScene: false, sceneId: npcDef.scene || 'venue' };
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
    return {
      x: def.tileX * TILE_SIZE + 32,
      y: def.tileY * TILE_SIZE + 32,
      crossScene: false,
      sceneId: def.scene,
    };
  }

  /**
   * 从当前场景去 targetSceneId，第一步应该先走哪个相邻场景
   *
   * ★ 为什么需要 BFS（2026-10-05）：
   *   场景从 5 个扩到 10 个、连成一个环之后，两个场景之间**往往不是直连的** ——
   *   比如「静谧池塘 ⇄ 林间空地」中间隔着
   *   青水浅滩 / 星船草甸 / 月面夜路 / 月面彩池 / 冰原遗迹 五个场景。
   *   而 exitPosTo() 原来是 `exits.find(e => e.to === target)`，
   *   找不到就直接返回 null，于是「前往」按钮在池塘里点会变成
   *   「没有需要前往的地方」—— 任务指引等于失效。
   *
   *   现在用一趟 BFS 算出「下一跳」，指引玩家沿环走最短的一段。
   * @returns {string|null} 相邻场景 id；目标就是邻居时返回目标本身；走不到返回 null
   */
  nextHopTo(targetSceneId) {
    const here = this.scenes.current ? this.scenes.current.id : null;
    if (!here || !targetSceneId || here === targetSceneId) return null;

    // 邻接表直接从 SCENES 的 exits 现算，不额外维护一张表（免得和 scenes.js 脱节）
    const adj = {};
    SCENES.forEach((s) => {
      adj[s.id] = (s.exits || []).map((e) => e.to);
    });
    if (!adj[here]) return null;

    const prev = { [here]: null };
    const queue = [here];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === targetSceneId) break;
      for (const nxt of adj[cur] || []) {
        if (prev[nxt] === undefined) {
          prev[nxt] = cur;
          queue.push(nxt);
        }
      }
    }
    if (prev[targetSceneId] === undefined) return null;   // 不连通

    // 从目标往回倒推，一直退到「父节点就是 here」的那一格 —— 那就是第一跳
    let node = targetSceneId;
    while (prev[node] !== here && prev[node] !== null && prev[node] !== undefined) {
      node = prev[node];
    }
    return node;
  }

  /** 找到通往目标场景的出口坐标（自动按 BFS 选最短的那条路的第一步） */
  exitPosTo(targetSceneId) {
    const cfg = this.scenes.current;
    if (!cfg) return null;
    if (targetSceneId === cfg.id) return null;

    const via = this.nextHopTo(targetSceneId);
    if (!via) return null;

    const ex = (cfg.exits || []).find((e) => e.to === via);
    if (!ex) return null;

    return {
      x: (ex.tileX + ex.w / 2) * TILE_SIZE,
      y: (ex.tileY + ex.h / 2) * TILE_SIZE,
      crossScene: true,
      // ★ 带上目标场景 id：任务面板的「前往」要报"目标在哪张地图"，
      //   光有跨场景标记是不够的（用户 2026-10-05 反馈）
      sceneId: targetSceneId,
      // 下一跳（可能是目标本身，也可能是中转场景）
      viaSceneId: via,
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

  /** 求方向对应的行号（见 characters.js 的 DIR_ROW，8 方向） */
  _animRow(suffix) {
    const dir = suffix.split('-')[1];
    return DIR_ROW[dir] ?? DIR_ROW.down;
  }

  // ---------------------------------------------------------------------------
  update() {
    if (this.scenes.switching) {
      this.player.setVelocity(0);
      return;
    }

    // 全屏插画展示中（切蛋糕 / 合影）：冻住一切，等玩家点一下收起
    if (this.overlay) {
      this.player.setVelocity(0);
      this.safePlay(`idle-${this.playerDir}`);
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

  /**
   * 庆祝态下，主角是不是站在「桌子的北面」（主位那一侧）。
   *
   * 只有站在这一侧才该被桌子挡住；绕到桌子南侧（近排外面）时必须画在桌子前面，
   * 否则桌子会反过来盖住她的上半身。
   */
  isBehindPartyTable() {
    if (!this.party || !this.player) return false;
    return this.player.y < PARTY_TABLE.y + PARTY_TABLE.h;
  }

  /** 更新影子位置（跟着主角脚底走） */
  updateShadow() {
    if (this.playerShadow && this.player) {
      this.playerShadow.setPosition(this.player.x, this.player.y - 2);
      // 庆祝态站在桌子北面时，影子也必须压在桌子底下，否则桌面上会糊一个黑椭圆
      this.playerShadow.setDepth(this.isBehindPartyTable() ? PARTY_SHADOW_DEPTH : 499);
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
    // 庆祝态：站在桌子北侧（含主位）时把图层夹在远排(400)与桌子(450)之间，
    // 下半身被桌子挡住、只露上半身；走到桌子南侧就必须换回老规则，
    // 否则桌子会反过来盖住站在它前面的她。
    this.player.setDepth(this.isBehindPartyTable()
      ? PARTY_HERO.depth : 500 + this.player.y * 0.001);

    if (vx || vy) {
      // ★ 8 方向：两个方向键同时按下就走斜向、播斜向动画
      //   （旧版这里是「取主轴」，斜着走也只会播上下左右里最接近的那个）
      const dir = dirNameFrom(vx, vy) || this.playerDir;
      this.playerDir = dir;
      this.safePlay(`walk-${dir}`);
    } else {
      this.safePlay(`idle-${this.playerDir}`);
    }
  }

  /**
   * 玩家到 NPC 模型包围盒的最近距离（人贴在模型边上就是 0）
   *
   * 为什么不用中心点距离：见 handleProximity 里的注释 ——
   * 模型占格封了 3×3，中心点距离会让玩家永远够不着。
   */
  distToNpcRect(px, py, npc) {
    const r = npc.rect;
    if (!r) return Phaser.Math.Distance.Between(px, py, npc.x, npc.y);
    const dx = Math.max(r.left - px, 0, px - r.right);
    const dy = Math.max(r.top - py, 0, py - r.bottom);
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** NPC 和交互点的接近检测 */
  handleProximity() {
    // --- NPC ---
    // ★ 距离按【模型包围盒最近的边】算，不再按落点中心算（2026-10-08）
    //
    //   站姿 NPC 现在踩在可走格上，而且模型所占的 3×3 格全是禁行区。
    //   如果还按中心点算距离，玩家最近也只能站到中心外 1.5 格 = 96px，
    //   已经超过 INTERACT.radius(78)，会导致「永远聊不上天」。
    //   改成量到盒子边缘的距离后，玩家贴着模型站就是 0 距离，语义也更对
    //   （和禁行区规则使用同一份几何）。
    let nearest = null, nd = Infinity;
    // 站姿 NPC +（放开之后）围坐 NPC，一起参与「谁离我最近」
    //
    // ★ 为什么围坐 NPC 要挂在 handleProximity 里而不是另起一套：
    //   两者共用同一条「走近 -> 头顶光圈 -> 按 E」的交互路径，
    //   分开写会出现「两套图标互相不知道对方」的经典 bug。
    const candidates = this.partyTalk
      ? this.npcs.concat(this.seatedNpcs)
      : this.npcs;
    for (const n of candidates) {
      const d = this.distToNpcRect(this.player.x, this.player.y, n);
      if (d < INTERACT.radius && d < nd) { nearest = n; nd = d; }
    }

    if (nearest !== this.activeNpc) {
      this.activeNpc = nearest;
      this.npcs.forEach((n) => n.icon.setScale(1));
      this.seatedNpcs.forEach((n) => {
        if (n.icon) n.icon.setScale(1);
      });
      if (nearest && nearest.icon) nearest.icon.setScale(1.3);
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
      // ★ 这里必须用求值后的 getter，不能用原始字段：
      //   · pointActive.iconText（字符串）—— icon 是 makeIcon() 返回的 Graphics 对象，
      //     拼进模板字符串会变成 "[object Object]"。曾显示成「[object Object] 花丛」。
      //   · pointActive.labelText / hintText —— label / hint 在 quests.js 里可以是
      //     (story) => '...' 的函数，`{...def}` 展开后字段本身还是函数，
      //     直接拼进模板字符串会把函数源码原样打到屏幕上
      //     （用户 2026-10-04 截图里的 `(s) => (s.allWritten ? '桌上的邀请函' : ...)`）。
      this.npcTip
        .setText(`${pointActive.iconText || '◆'} ${pointActive.labelText}\n${pointActive.hintText || '按 E 互动'}`)
        .setVisible(true);
      this.activePoint = pointActive;
    } else {
      this.npcTip.setVisible(false);
      this.activePoint = null;
    }
  }

  handleInteract() {
    // 全屏插画展示中：E 不接（收起只能点鼠标）
    if (this.overlay) return;

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
    // ★ 补计数（修「打水委托永远交不了」的死锁）
    //
    //   和 doCollectItem 是【同一类】问题，当时只修了那边、漏了这个：
    //
    //   背包 localStorage['venue-items-v1'] —— 【没有按天分桶】；
    //   任务状态 localStorage['venue-quests-v2'] —— 【按天分桶，跨天自动重置】。
    //   于是跨天之后：玩家身上还揣着「装满水的桶」，但委托被重置回
    //   active / 计数 0。再到池塘取水处按 E，旧写法第一句
    //       if (p.doneItem && this.hasItem(p.doneItem)) { toast(doneHint); return; }
    //   就提前 return 了 —— 界面提示「桶已经装满了，赶紧送回去吧」，
    //   可 markCollect() 从来没被调用，计数永远是 0，委托永远到不了 ready，
    //   回奈芙尔那里自然还是「还在进行中 / 去打水」。
    //
    //   用户 2026-10-09 报的就是这个：「提示打好了水可以交了，
    //   但是回奈芙尔那里还是让我去打水」。
    //
    //   现在：身上有成品但任务计数还是 0 时，不再重复发东西，但**把计数补上**。
    const qid = p.questId;
    const counted = qid ? this.quests.getCounter(qid) : 1;
    const alreadyHas = !!(p.doneItem && this.hasItem(p.doneItem));

    // 真的已经换好了：提示一句就走
    if (alreadyHas && counted >= 1) {
      this.toast(p.doneHint || '已经做好了');
      return;
    }

    // 需要前置物品但身上没有。
    // ★ 注意要加 !alreadyHas：已经有成品时不该再要空桶 ——
    //   那个空桶在【上一次】换水的时候就已经被消耗掉了，
    //   再加这个条件会把补计数分支也挡在门外，死锁照样存在。
    if (!alreadyHas && p.needItem && !this.hasItem(p.needItem)) {
      this.dialog.open(
        { name: p.labelText || p.label || '提示', portrait: '❓', portraitBg: '#2a2a33' },
        [{ text: p.needHint || '你还没有需要的东西。' }],
        null
      );
      return;
    }

    // 只有真的要换物时才动物品栏；补计数那一路不重复发东西
    if (!alreadyHas) {
      if (p.needItem) this.takeItem(p.needItem);
      if (p.giveItem) this.giveItem(p.giveItem, p.giveName);
    }
    if (p.collectId) this.quests.markCollect(p.collectId, 1);

    if (p.okText) {
      this.dialog.open(
        { name: p.labelText || p.label || '交互', portrait: '💧', portraitBg: '#223a3d' },
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
      if (this.scenes.current.id === p.scene) dot(p.tileX, p.tileY, 0x50e6e6, p.labelText || '');
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
    // ★ 补计数（修"委托永远做不完"的死锁）
    //
    //   老存档 / 边缘情况下，玩家身上已经有这个道具，但任务计数还是 0
    //   （因为当初拿道具时委托还没接，QuestSystem.markCollect 会拒绝计数）。
    //   旧写法直接 `已经拿到了 → return`，于是计数器永远补不上，
    //   委托永远差 1 个 —— 用户 2026-10-05 报的就是这个。
    //   现在：身上有道具但任务计数还是 0 时，不再重复发道具，但**把计数补上**。
    const qid = p.questId;
    const counted = qid ? this.quests.getCounter(qid) : 1;
    const alreadyHas = this.hasItem(p.collectId) && !p.repeatable;

    if (alreadyHas && counted >= 1) {
      this.toast(p.doneHint || '已经拿到了');
      return;
    }

    if (p.collectId) {
      if (!alreadyHas) {
        this.giveItem(p.collectId, p.giveName || p.labelText || p.label);
      }
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

  /**
   * 提示玩家「这个采集点还没解锁，得先去找 XX 接委托」
   *
   * 用户 2026-10-05 要求：没接对应委托时点互动点不给东西，
   * 而是告诉他去找谁。文案里同时报出委托人名字和委托名，
   * 因为玩家不一定记得「池塘捉鱼」是爱诺发的。
   */
  toastNeedQuest(p) {
    const q = QUESTS.find((x) => x.id === p.questId);
    const npc = q ? NPCS.find((n) => n.id === q.giverNpcId) : null;
    const who = npc ? npc.name : '委托人';
    const title = q ? String(q.title || '').replace(/^【[^】]*】/, '') : '';

    if (title) {
      this.toast(`还没接委托 —— 请先找到「${who}」，接取「${title}」`);
    } else {
      this.toast(`还没接委托 —— 请先找到「${who}」接取委托`);
    }
  }

  /** 触发交互点 */
  triggerPoint(point) {
    const r = this.interactPoints.trigger();
    if (!r) return;

    if (r.type === 'desk') {
      // 书桌只有一件事：还没写完就写下一封。
      // （v5 起信在信纸过场收尾时就进了怀里，书桌点在 11/11 之后直接消失，
      //   所以「写完了」这个分支正常走不到，留着只是兜底。）
      if (!this.story.allWritten) {
        this.startLetterWriting();
      } else {
        this.toast('邀请函都写好了，去林间信箱投递吧');
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
        this.toast('邀请函还没写好');
      }
    } else if (r.type === 'cake') {
      this.showCakeCutscene();
    } else if (r.type === 'needQuest') {
      // 没接委托 → 不给东西，告诉他去找谁（见 InteractPointSystem.isQuestAccepted）
      this.toastNeedQuest(r.point);
    } else if (r.point && r.point.action === 'exchangeItem') {
      this.doExchangeItem(r.point);
    } else if (r.point && r.point.action === 'collectItem') {
      this.doCollectItem(r.point);
    } else if (r.point) {
      this.toast(r.point.hintText || r.point.labelText || point.hintText || point.labelText);
    } else {
      this.toast(point.hintText || point.labelText);
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

    // 「写的是第几封」——用【已经写好多少封】来算，不能用收尾动画里的值：
    // 这一封要等过场跑完才记进 StorySystem，这里是在打开信纸之前取的值。
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
          this.time.delayedCall(700, () => this.toast('11 封邀请函都收进信封了，去林间信箱寄出去吧'));
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
    // ★ 围坐形态走另一套话（用户 m09394）
    //
    //   站姿 NPC 在会场里说的是「委托接没接、交没交」，
    //   围坐 NPC 说的是「今晚的感受 + 想对哥伦比娅说的话」，
    //   再接上两个功能入口：查看合影 / 小游戏·单品（占位）。
    //   两套话共用同一个对话框和同一条「走近 -> 按 E」路径。
    if (npc.seated) return this.buildSeatedDialogLines(npc);

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

    // ---- 合影留念（任务4）----
    //
    // 需求：「接委托时，所有NPC增加合影选项。」
    // 合影 = 哥伦比娅 Q 版立绘 + 这位 NPC 的 Q 版立绘 + 他所在场景的背景，
    // 由 tools/gen-photo.py 离线拼好（拍立得样式），运行时光铺一张全屏图。
    //
    // 为什么放在最后一行：
    //   接取/交付委托的按钮在中间几行，玩家一路点下去最后才看到合影，
    //   不会打断做任务的动线。
    //
    // 为什么只给 guest：
    //   空（npc-aether）是旅行者的同伴，不是受邀客人，没有合影素材。
    if (npc.guest) {
      lines.push({
        text: '难得大家都在，要不要一起拍张合影？',
        link: { label: '📸 合影留念', photo: true },
      });
    }

    return lines;
  }

  /**
   * 围坐 NPC 的对话（大合影拍完之后才走得到这里）
   *
   * 用户 m09394 定的结构：
   *   1) 打招呼的闲聊 —— 关于本次生日会的感受 / 想对哥伦比娅说的话
   *   2) 查看合影
   *   3) 介绍小游戏 / 单品项目（★ 占位，后期接入）
   *
   * 修订（用户 m09842）：这里的「查看合影」要的是**这位 NPC 和哥伦比娅的单独合影**，
   * 不是全体大合影。大合影只在切蛋糕那一下出现。
   */
  buildSeatedDialogLines(npc) {
    const lines = partyTalkOf(npc.id).map((t) => ({ text: t }));

    lines.push({
      text: PHOTO_PROMPT,
      link: { label: '📸 查看合影', photo: true },
    });

    lines.push({
      text: OFFER_PROMPT,
      link: { label: '🎮 小游戏 · 单品', soon: true },
    });

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
    // 交互点类（结局切蛋糕）：提示语直接取交互点的 label，
    // 免得任务列表里这一条的目标栏是空的
    if (t.type === 'interact') {
      const ip = INTERACT_POINTS.find((x) => x.questId === q.id);
      return ip ? `去主会场主位「${ip.label || '互动'}」` : '去主会场主位切蛋糕';
    }
    return '';
  }

  handleGotoQuest(questId) {
    const q = QUESTS.find((x) => x.id === questId);
    if (!q) return;

    // 金色引导箭头已经在 2026-09-28 按用户要求撤掉了（见 buildGuideArrow）。
    // 所以「前往」不能再叫玩家"跟着金色箭头走" —— 直接报出目标在哪张地图。
    //
    // ★ 2026-10-05 修：以前跨场景时用 `q.target.scene || q.scene` 猜地图名，
    //   但 5 条采集委托的 `q.scene` 都是 'venue'（发布任务的 NPC 所在地），
    //   真正的采集点在 pond / grove —— 于是「前往」会把玩家指去会场。
    //   现在一律用 getGuideTarget() 算出来的 sceneId（它走的是交互点/出口的真实位置），
    //   并且**无论同场景还是跨场景都报出地图名**。
    const target = this.getGuideTarget();
    if (!target) {
      this.toast('没有需要前往的地方');
      return;
    }

    // 兜底：万一某个分支没带 sceneId，再退回 q.target.scene / q.scene
    const sceneId =
      target.sceneId || (q.target && q.target.scene) || q.scene || 'home';
    const s = SCENES.find((x) => x.id === sceneId);
    const mapName = s ? s.name : sceneId;

    // ★ actionLabel：交互点类目标（结局切蛋糕）在 getGuideTarget 里带上了
    //   「去干什么」。不带的话同场景只会说「找找发光的地方」，
    //   玩家仍然不知道该去哪 —— 用户 2026-10-09 要的「正确指引主会场」。
    const act = target.actionLabel ? `「${target.actionLabel}」` : '';

    if (target.crossScene) {
      // 中转场景：10 个场景连成一环，目标常常不挨着 ——
      // 光说「目标在 X」玩家还是不知道该往哪走，所以把「第一步先去哪」也报出来。
      const viaId = target.viaSceneId;
      const via = viaId && viaId !== sceneId
        ? SCENES.find((x) => x.id === viaId)
        : null;
      if (via) {
        this.toast(act
          ? `要去「${mapName}」的${act} —— 先走传送光圈去「${via.name}」`
          : `目标在「${mapName}」—— 先走传送光圈去「${via.name}」`);
      } else {
        this.toast(act
          ? `要去「${mapName}」的${act} —— 从这张地图的传送光圈过去`
          : `目标在「${mapName}」—— 从这张地图的传送光圈过去`);
      }
    } else if (act) {
      this.toast(`${act}就在这张地图上（「${mapName}」）—— 走到发光的地方按 E`);
    } else {
      this.toast(`目标在「${mapName}」—— 就在眼前这张地图上，找找发光的地方`);
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
