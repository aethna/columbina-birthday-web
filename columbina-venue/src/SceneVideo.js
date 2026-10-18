/**
 * 动态场景背景（视频层）—— 把静态背景图换成会动的视频背景
 *
 * 设计说明：
 *   素材是方舟 Seedance 图生视频出来的「正放 + 倒放」拼片，
 *   已经烘焙成一条 10.08s 的无缝循环 mp4，所以这里只要 loop=true 就行，
 *   不需要在 Phaser 里做 setPlaybackRate(-1) 的边界判断。
 *
 *   视频规格（tools/build-bg-video.py 产出）：
 *     2560x1536 = 5:3，和场景背景图 / SCENE_W:SCENE_H 完全同尺寸，
 *     所以 fit() 里算出来就是 scale=1，不裁内容、不放大、也不会糊，
 *     也不用在 Phaser 侧垫任何边。
 *     （源头的 AI 视频是 1920x1080 的 16:9，是构建脚本把它等比铺满到 5:3
 *       再烘焙成 2560x1536 的，左右多出来的那两条用同帧模糊延展，
 *       不是把边缘像素复制出来的——那会在所有场景底部留下一条彩色条纹带。）
 *
 *   ★ 为什么必须用 Phaser 自己的 loadURL()，不能自己造 <video> 塞给 add.video()：
 *     Video game object 的构造函数收到 key 就走 load(key)，
 *     它只会从【视频 cache】里查（scene.sys.cache.video.get(key)）。
 *     传一个 HTMLVideoElement 进去，cache 查不到 -> 只打一句 warn 就什么都不做，
 *     不会给你自己的 <video> 用。于是纹理要等 requestVideoFrameCallback
 *     回调里才创建（Video.js:838-874），自己接管 <video> 就等于绕过这一套，
 *     纹理、尺寸、pause/resume 都要重写一遍，还容易跟 Phaser 内部状态打架。
 *     loadURL(url, noAudio=true) 会让 Phaser 自己建 <video>、
 *     设 muted+autoplay，然后 play() 负责起播与纹理创建。
 *
 *   为什么叠在静态图【上面】而不是替换掉：
 *     视频是异步加载的，而且种子模型会重画纹理，跟原图不是逐像素一致。
 *     直接替换的话，切换场景的头一两帧会是空白。叠在静态图上面，
 *     加载失败 / 还没加载好时就自然退回静态图，不会穿帮。
 *
 *   视频不做 preload（Phaser 官方说明视频「不需要预加载」），
 *   而是第一次进场景才 loadURL，之后把 Video 对象缓存起来复用，
 *   来回切场景不会重复解码。
 */

import { SCENE_W, SCENE_H } from './scenes.js';

/**
 * 有动态背景视频的场景。缺文件会自动退回静态图，不会报错。
 */
export const VIDEO_SCENES = new Set([
  'venue', 'home', 'icefield', 'grove', 'mailbox', 'pools',
  'moonpath', 'starship', 'shallows', 'pond',
]);

/** 静态图 depth=0，传送光圈标记 depth=2 —— 视频夹在 0 和 2 之间。 */
const VIDEO_DEPTH = 1;

/** 关闭开关：?bgv=off 时全部退回静态图，方便对比和排查性能问题。 */
function enabled() {
  try {
    return new URLSearchParams(location.search).get('bgv') !== 'off';
  } catch {
    return true;
  }
}

function urlOf(sceneId) {
  return `assets/scenes-video/${sceneId}.mp4`;
}

/**
 * 元数据已经就绪时立刻调一次 fit。
 *
 * 为什么需要：VIDEO_PLAY 只在「新建纹理」那一帧发一次。如果元素来自浏览器
 * 缓存、挂上时已经 frameReady，那一帧在我们 before VIDEO_PLAY 之前/之外，
 * 事件就漏掉了，尺寸就永远停在 256x256 的 scale=10。
 */
function el_ready(v, fit) {
  const el = v.video;
  if (!el) { return; }
  if (el.readyState >= 1) fit();
  else el.addEventListener('loadedmetadata', fit, { once: true });
}

export default class SceneVideo {
  /**
   * @param {Phaser.Scene} scene 宿主场景（VenueScene）
   */
  constructor(scene) {
    this.scene = scene;
    this.cache = new Map();   // sceneId -> Video | null
    this.current = null;      // 当前场景的 Video
    this.blocked = false;     // 自动播放被浏览器拒了，等用户交互过再补播

    if (enabled()) {
      // 标签页被切到后台时浏览器会掐掉视频解码，切回来再续上，省 CPU。
      const doc = document;
      this.onVisibility = () => (doc.hidden ? this.pause() : this.resume());
      doc.addEventListener('visibilitychange', this.onVisibility);

      // 有些浏览器要等一次真实交互（keydown/pointerdown）才肯播，先挂个补播钩子。
      this.onGesture = () => { if (this.blocked) this.resume(); };
      window.addEventListener('pointerdown', this.onGesture);
      window.addEventListener('keydown', this.onGesture);
    }
  }

  /** 当前场景有没有视频；没有就什么都不做（静态图继续当背景）。 */
  has(sceneId) {
    return enabled() && VIDEO_SCENES.has(sceneId);
  }

  /**
   * 挂上当前场景的视频层。
   * @param {string} sceneId
   */
  mount(sceneId) {
    if (!this.has(sceneId)) return;
    const rec = this.acquire(sceneId);
    if (!rec) return;

    this.current = rec;
    rec.setVisible(true).setActive(true);
    this.start(rec);
  }

  /**
   * 切场景时调用：把上一个视频收起来（Video 对象留着缓存，不销毁）。
   */
  unmount() {
    if (!this.current) return;
    this.current.pause();
    this.current.setVisible(false).setActive(false);
    this.current = null;
  }

  /** 拿（并缓存）某个场景的视频对象。创建失败返回 null，调用方退回静态图。 */
  acquire(sceneId) {
    if (this.cache.has(sceneId)) return this.cache.get(sceneId);

    let rec = null;
    try {
      const url = urlOf(sceneId);
      // noAudio=true：没有音轨的视频才可以免交互自动播放。
      // 我们本来也不要背景音（10s 循环的环境音反复播反而吵）。
      const v = this.scene.add.video(0, 0)
        .setOrigin(0, 0)
        .setDepth(VIDEO_DEPTH)
        .setVisible(false)
        .setActive(false)
        .loadURL(url, true);

      // ★ 尺寸必须挂在 VIDEO_PLAY 上，而且必须用 videoWidth/videoWidth 算 scale，
      //   不能用 setDisplaySize()，也不能挂 VIDEO_TEXTURE。三个坑：
      //
      //   1) 构造时 Video 先 setSize(256,256)（Video.js:529），这时纹理还不存在。
      //      若此时调 setDisplaySize(2560,1536)，Phaser 算出的 scale 是
      //      2560/256 = 10。
      //   2) VIDEO_TEXTURE 事件在 Video.js:873 发出，而 setSizeToFrame()
      //      在 886 行才执行 —— 事件里对象尺寸还是 256x256，setDisplaySize
      //      会拿这个假尺寸算 scale。
      //   3) 第一个视频帧回调跑完后，对象尺寸变成真实的 2560x1536，
      //      上面那个 scale=10 留了下来，于是实际渲染成 25600x15360（10 倍大）。
      //      —— 实测就是这个值，验收脚本抓到的。
      //
      //   VIDEO_PLAY（Video.js:910）在 886 之后发，对象尺寸已就绪；
      //   再直接用 videoWidth 兜底，就不依赖任何内部顺序了。
      const fit = () => {
        const el = v.video;
        if (!el || !el.videoWidth) return;
        v.setScale(SCENE_W / el.videoWidth, SCENE_H / el.videoHeight);
      };
      v.once(Phaser.GameObjects.Events.VIDEO_PLAY, fit);
      el_ready(v, fit);

      // 解码失败 / 文件缺失：这一路标记不可用，静默退回静态图。
      v.video && v.video.addEventListener('error', () => {
        this.degrade(v, sceneId);
      });

      rec = v;
    } catch (e) {
      console.warn(`[动态背景] 创建失败，退回静态图: ${sceneId}`, e);
      rec = null;
    }

    this.cache.set(sceneId, rec);
    return rec;
  }

  /**
   * 起播 / 续播。用 setPaused(false) 而不是 play(true)，这一点很关键：
   *
   *   Phaser 的 play(loop)（Video.js:987）只在【第一次】真正启动播放：
   *     - `isPlaying()` 为真就直接 return（:994）；
   *     - `_playCalled` 为真时不会再去 createPlayPromise()（:1016-1024）。
   *   而我们每个场景的 Video 是【反复复用的】（来回切场景不重新解码），
   *   切走时调过 pause() -> setPaused(true)（:1963 置 _codePaused=true）。
   *   这时再调 play(true) 是空操作，播放永远不会恢复。
   *   实测症状：t 卡在 1.796s 不动、el.paused=true、_codePaused=true，
   *   手动 v.play(true) 无效，手动 el.play() 立刻恢复 —— 定位到这条。
   *
   *   setPaused(false)（Video.js:1957）在 video.paused && !_systemPaused 时
   *   会 createPlayPromise() 重新起播，playSuccess 再把 _codePaused 置回 false，
   *   已经是播放态时也不做多余的事，可以放心重复调。
   *
   * ★ 不要再自己调 el.play() 兜底：Phaser 内部已经调过一次并接管了
   *   resolve/reject，我们再调就是第二个 Promise，它的 reject 会把
   *   「切场景时被 pause() 打断」这种正常情况（AbortError）也算进来。
   *   浏览器真正拒播时抛 NotAllowedError，Phaser 在 playError 里
   * （Video.js:1461-1468）置 touchLocked 并发 VIDEO_LOCKED —— 用它，别自己判。
   *
   * @param {Phaser.GameObjects.Video} v
   */
  start(v) {
    if (!v || !v.setPaused) return;
    if (!v.__bgvLockedHooked) {
      v.__bgvLockedHooked = true;
      v.on(Phaser.GameObjects.Events.VIDEO_LOCKED, () => {
        // 浏览器不让播：先藏这一层，底下静态图顶上，等用户交互过再补
        this.blocked = true;
        if (this.current === v) v.setVisible(false).setActive(false);
      });
    }
    v.setPaused(false);
    if (v.video) v.video.loop = true;   // play() 每次都会重设 loop，这里保证复用后仍是循环
  }

  /** 解码/播放彻底不可用：隐藏这一层，底下静态图接管。 */
  degrade(v, sceneId) {
    v.setVisible(false).setActive(false);
    if (this.current === v) this.current = null;
    console.warn(`[动态背景] 视频不可用，退回静态图: ${sceneId}`);
  }

  /** 标签页隐藏时暂停。 */
  pause() {
    if (this.current) this.current.pause();
  }

  /** 标签页回来（或用户交互过）时续播。 */
  resume() {
    if (!this.current) return;
    const v = this.current;
    v.setVisible(true).setActive(true);
    // 无条件调：setPaused(false) 内部会看 video.paused 和 _systemPaused，
    // 已经在播就什么都不做；Phaser 自己监听到标签页隐藏时会置 _systemPaused，
    // 那种情况下我们也不去跟它抢。
    this.start(v);
  }

  /** 场景结束时彻底清理。 */
  destroy() {
    this.unmount();
    window.removeEventListener('pointerdown', this.onGesture);
    window.removeEventListener('keydown', this.onGesture);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.cache.forEach((v) => { if (v) v.destroy(); });
    this.cache.clear();
  }
}
