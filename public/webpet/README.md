# 哥伦比娅 · 网页桌宠

一行 `<script>` 把一只会动的哥伦比娅挂到任意网页上。她按权重随机切换动画、可以拖走、点一下会回应。

**纯静态，无后端，无依赖，不联网。** 把文件夹丢到网站上就能用。

```
web-pet/
├── index.html                演示页
├── favicon.png
├── assets/anim/              19 个 VP9-alpha webm（14.5 MB）
├── src/columbina-webpet.js   全部逻辑，单文件
└── _test_*.mjs               无头浏览器验收脚本（不必上传）
```

---

## 一、用法

宿主页面加一行，放在 `</body>` 前：

```html
<script src="https://columbina520.com/webpet/src/columbina-webpet.js" defer></script>
```

她自动出现在右下角。资源路径会从脚本自身的 `src` 反推，所以放子目录、放 CDN 都不用改配置。

想改默认外观，在引入脚本**之前**写：

```html
<script>
window.COLUMBINA_WEBPET = {
  size: 300,              // 画布宽度 px，高度按 640:360 换算
  corner: 'bottom-left',  // bottom-right / bottom-left / top-right / top-left
  marginX: 24,
  marginY: 24,
  fixed: false,           // true = 只原地待机，不横走
  moveEnabled: true,
  idleIntervalMs: [4200, 9000],
  weights: { idle: 45, turn: 0, move: 15 }  // 余下 40% 归随机动作
};
</script>
<script src="…/columbina-webpet.js" defer></script>
```

不想自动挂载（自己 new 一个），设 `window.COLUMBINA_WEBPET_NO_AUTO = true`，然后：

```js
const pet = new ColumbinaWebPet({ config: {...} });
pet.start();
```

---

## 二、生命周期

桌宠活在**页面自己的浏览上下文**里：

| 情况 | 结果 |
|---|---|
| 标签页开着 | 她就在 |
| 页面内跳路由 | 她还在（位置记在 `sessionStorage`） |
| 跳到别的页面，且目标页也引了脚本 | 重新挂载，位置不变 |
| 跳到**别的域名** | 重新挂载，`sessionStorage` 跨域不带，回默认位置 |
| 关掉标签页 | **她消失**。没有常驻进程，不需要清理代码 |

因为整个过程没有任何后台实体，所以"关掉网站就消失"是天然成立的，不是靠代码去清理。

> 想要"连一帧都不闪"的换页体验，得把站点做成前端路由的单页应用 —— 那样宠物 DOM 永不被销毁。
> 整页跳转在浏览器层面必然重建文档，这一点绕不过。

---

## 三、交互

| 操作 | 反应 |
|---|---|
| 拖动 | 切成「被拎起悬空」姿势跟着走，松手回待机，位置写进 `sessionStorage` |
| 单击（不移动） | 从 clicks 池随机播一条互动动画 |
| 什么都不做 | 4.2~9 秒后按权重掷骰：待机 / 转向 / 横走 / 随机动作 |

**命中盒**只覆盖画布中央 `x[200..440] y[50..335]` 那一块，其余透明区域的 `pointer-events` 是 `none`，不会挡住宿主页面上的链接。

---

## 四、和 Electron 版对齐的口径

| 项 | 值 | 为什么 |
|---|---|---|
| 画布 | 640×360，人物站 `FEET_Y=330`，人物高 265 | 与桌宠素材契约一致 |
| 动画切换 | **硬切**，无 opacity 过渡 | 双层互淡会整体掉亮度；单层淡入会把下层旧姿势透出来（用户报过的"重叠"） |
| 掷骰权重 | idle 45 / turn 0 / move 15，余下 40% 归动作 | 与 `src/shared/pickers.ts` 的 `rollKind` 同口径 |
| 样式隔离 | Shadow DOM + 内联 CSS | 宿主的 `video{max-width:100%}`、全局 transition、z-index 会把桌宠挤变形 |

---

## 五、验收读数

`_test_columbina_webpet.mjs`（功能 10 项）：

```
挂载        Shadow Root + 240×135 stage，video 640×360 readyState=4
播放        2.53 → 3.73 s，确实在推进
拖动        translate(1016,641) → (756,491)，拖动期间姿势=被拎起悬空 ✅
点击        点头 → 开心跳跃（命中 clicks 池）✅
位置记忆    sessionStorage = {"x":756,"y":491}
刷新后      translate(756,491) 完全不变 ✅
销毁        destroy() 后 host 从 DOM 移除 ✅
页面错误    0
```

`_test_hardcut.mjs`（重叠专项，这是最关键的一条）：

```
710 帧逐帧采样 / 8 次真实切换
任何一帧可见层数最大值 = 1     ← 不会出现两层同时可见
front 层 opacity < 0.999 的帧数 = 0   ← 从不半透明
实际切换到的动画：晃脚待机 / 开心跳跃 / 旋转展示 / 害羞低头 /
                  被吓一跳 / 抖一抖 / 前倾好奇 / 原地蹲下 / 伸个懒腰
```

---

## 六、坑

1. **每加一个动画就多一个 `<video>` DOM**，切过的动画会一直留在 DOM 里（`opacity:0` 但仍在）。
   19 个全切一遍就是 19 个 video 元素。目前不回收 —— 因为重解码比留着更慢，且 19 个 alpha 通道内存占用可接受。
   如果将来动画池涨到 50+，要加 LRU 回收。
2. **Safari 不认 webm 的 alpha**，会渲染成黑底。要兼容得换 HEVC-with-alpha 的 `.mov` 并改 `_layer()` 里的扩展名。
3. **`sessionStorage` 跨域不共享**。`columbina520.com` 和 `pet.columbina520.com` 是不同源，位置不会带过去
   （要跨子域得用 `document.domain` 或 Cookie，但那就又要把配置塞 Cookie 了 —— 本版刻意不做）。
4. **`autoplay` 需要 muted**。已经设了 `muted` + `playsinline`。万一浏览器仍拒绝，
   代码会挂一个一次性的 `pointerdown` 监听，等用户第一次点击时补播。
5. **测试里不要直接改 `pet.pos`**，持久化挂在 `pointerup` 上。脚本化验收要用真实
   `mouse.down/move/up`，否则会误判成"位置没记住"。
6. **Playwright 浏览器二进制不随包下载**。本机直接用系统 Edge：
   `chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' })`。
   Playwright 是 CJS，ESM 里要 `import pw from 'file:///...index.js'; const {chromium}=pw;`。

---

## 七、本地验收

```powershell
$py='D:\Program Files (x86)\DSH_Data\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
cd D:\DSH工作区\桌宠调研\web-pet
Start-Process -FilePath $py -ArgumentList '-m','http.server','8791','--bind','127.0.0.1' -WindowStyle Hidden

$node='D:\Program Files (x86)\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
& $node _test_columbina_webpet.mjs 'http://127.0.0.1:8791/'
& $node _test_hardcut.mjs 'http://127.0.0.1:8791/'
```

---

## 八、本版刻意没有的东西

设置页、AI 对话、碎碎念台词、人设、跨子域 Cookie —— **全部去掉了**。

原因：这是挂在公开站点上的展示型宠物，不需要用户配置。
少一个设置页就少一条"用户往里填 API key 然后被服务端看见"的路径。
