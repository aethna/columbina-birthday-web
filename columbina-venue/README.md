# columbina-venue · 生日会主会场（Phaser 3 游戏工程）

> 「哥伦比娅生日会」线上会场的**可探索小镇游戏**部分。
> 主站（`columbina520.com`）通过「前往会场」进入此工程，挂载在 **`/venue/`**。
>
> 这份 README 面向**接手这个工程的开发者**。仓库根目录的 `README.md` 讲的是整个
> monorepo（主站 / 小游戏 / 后端 / 部署），会场本身的技术细节看这一份。

---

## 1. 这是什么

2D 俯视小镇式的网页游戏，纯前端（Phaser 3 + Vite），**无后端**。

5 个场景环形连通：

```
home ⇄ mailbox ⇄ venue ⇄ pond ⇄ grove ⇄ home
```

玩法主线：

```
桌上收起 5 封邀请函 → 投递到林间信箱 → 5 位 NPC 到场 → 5 条支线委托（各给 1 个道具）
```

- 场景 40×24 格 × 64px = **2560×1536**
- 存档 4 个键：`venue-quests-v2` / `venue-story-v1` / `venue-props-v1` / `venue-items-v1`（均在 localStorage）
- 左下角「初始化」按钮可一键清档重来

## 2. 跑起来

```bash
cd columbina-venue
npm install          # 首次
npx vite --port 5173 --strictPort
```

打开 **http://localhost:5173/venue.html**

> ⚠️ **不要双击 html 文件打开**（`file://` 下 ES module 会被 CORS 拦，直接黑屏），必须走 HTTP。
> Windows 上也可以双击 `启动会场.bat`。

### 操作

| 键 | 作用 |
| --- | --- |
| `W A S D` / 方向键 | 移动 |
| `E` | 交互 / 对话 |
| `Q` | 任务列表（可收起） |
| `M` | 地图 |
| `F1` / `F2` | 可走区 / 全图核对（调试视图，正常游戏不用） |

## 3. 源码结构（`src/`，12 个文件）

| 文件 | 职责 |
| --- | --- |
| `main.js` | 入口，Phaser 实例化 |
| `VenueScene.js` | **核心**，场景主循环 / 玩家移动 / 动画帧率 / 交互触发 / UI 装配（约 1600 行，改之前先读懂） |
| `scenes.js` | `MAP_ROWS` 场景可走区定义 + `SCENES` 场景表 |
| `quests.js` | `QUESTS` 任务定义 + `INTERACT_POINTS` 交互点 |
| `config.js` | `NPCS` / `PLAYER` / `INTERACT` / `GUIDE` 数值配置 |
| `QuestSystem.js` | 任务状态机（进度 / 完成 / 同步存档） |
| `StorySystem.js` | 主线剧情状态（邀请函数量 / 桌上 / 已投递） |
| `DialogSystem.js` | 对话框 |
| `InteractPoints.js` | 交互点渲染与图标文字 |
| `SceneManager.js` | 场景切换 / 出口判定 |
| `Minimap.js` | 小地图 |
| `characters.js` | 角色精灵注册与走路动画构建 |

## 4. 验收（**改完必跑**）

工程根目录（`columbina-venue/`）下有一组无头浏览器验收脚本，启动 vite 后执行：

```bash
node _verify_all.mjs          # 8 项功能验收 ★ 主要门槛
node _verify_fixes.mjs        # 4 项：交互点文字 / 道具点位 / 主线进度 / 版本提示条
node _verify_flow_reset.mjs   # 3 项：主线流程 + 初始化按钮
```

截图脚本（做视觉验收用）：

```bash
node _shoot-walkseq.mjs       # 四方向逐帧走路序列
node _shoot-portraits.mjs     # 5 个 NPC 对话框头像
node _shoot-feet.mjs          # 四方向脚部特写
```

> 这些脚本用 `puppeteer`（已在 `devDependencies` 里），**必须在 `columbina-venue/` 目录下跑**。
> 它们依赖 vite 已在 5173 端口就绪。

## 5. 几个容易踩的坑

### 5.1 主角雪碧图是 **8 帧/方向**，不是 4

雪碧图 `public/assets/chars-scene/hero-sheet.png` 是 **1536×768**（4 行 × **8 列**）。

代码侧帧数由 `config.js` 的 `PLAYER.framesPerDir` 决定：

```js
frameWidth: 192, frameHeight: 192,
framesPerDir: { down: 8, left: 8, right: 8, up: 8 },
```

- `characters.js` 的 `colsOf()` **不能写死 4**，否则 8 列雪碧图会被按 4 列切片，人物碎成色块
- 帧率不是固定值：`VenueScene.safePlay()` 按 `WALK_CYCLE_FACTOR` 动态算
  （`rate = PLAYER.speed / cycleDistance × frames`），改 `characters.js` 里的数字**没有效果**
- 8 帧不是 4 帧的替代，而是把**同一个循环切得更细** → 同一循环走同样距离，帧率翻倍是必然的。
  想「调慢」要改**循环距离**（`WALK_CYCLE_FACTOR`），不是改帧率数字

### 5.2 场景素材文件名与编码

场景图放在 `public/assets/scenes/`，**中文文件名会被构建/部署环节搞坏**（历史上出过
「NBSP 文件名让部署打包崩溃」、非 ASCII 文件名编码损坏两次事故）。新增素材统一用 ASCII 名字。

### 5.3 进度条靠的是 `StorySystem`，不是 `QuestSystem`

主线「整理邀请函」的进度来自 `StorySystem.getCounts()`。`QuestSystem` 自己算不出来
（它不知道 `StorySystem` 存在），必须由 `VenueScene` 在 story 变化时调 `syncStoryQuests()`。

> ★ 顺序要紧：**先 `syncStoryQuests()` 再 `refreshQuestUI()`**，反过来 UI 会拿到旧状态。

### 5.4 竖长素材别塞进正方形框

NPC 对话头像原图是约 2:1 的竖长立绘，早期用 128×128 + `object-fit: cover` 会把头裁掉。
现在是 **128×192 + `object-fit: contain` + `object-position: center bottom`**。

## 6. 提交与协作

**本工程不能直推 `main`** —— 用 fork + PR：

```bash
# 1) 先检查本地相对 upstream 的状态（一致/领先/落后/冲突）
node ../tools/gh-sync.mjs

# 2) 再推 PR（自动跳过无改动文件）
node ../tools/gh-push.mjs --title "feat(venue): ..." --branch "feat/venue-xxx" \
     --files venue/src/quests.js
```

> ⚠️ **推之前务必先 `gh-sync`**：本工程曾是离线开发的，本地文件可能落后于 upstream，
> 直接推会把别人刚加的功能删掉。详见仓库根 `readme.md` §11.5（有真实翻车实例）。

提交信息风格：conventional commits + 中文描述，例
`feat(venue): 主站新增「前往会场」入口 ... (#44)`

## 7. 素材生产管线（另外的活，一般不用碰）

主角行走图**不是手绘的**，是「图片模型出站立锚图 → 图生视频出走路 → 抽帧拼雪碧图」：

```
regen-hero-ark.mjs        生成 16 帧站立锚图（约 25 分钟，每天配额 20 张）
gen-walk-video.mjs        图生视频，产出 walk-video/{dir}.mp4
extract-walk-cycle.py     从 61 帧里挑出 8 帧真实迈步循环 + 抠白底
build-hero-sheet2.py      拼成 1536×768 雪碧图 + 写 hero-sheet.json + 同步 config.js
```

脚本在仓库根的 `../tools/`，**依赖火山方舟 ARK 的 API key**（不在仓库里）。
完整说明与踩坑见根 `readme.md` §五、§六。

> 已知遗留：脚踝的白花边被视频模型渲染成了白色厚底凉鞋，提示词改不掉
> （试过 4 个版本，其中 3 个被版权审核拦下），当前接受现状。

## 8. 已知问题

- `启动会场.bat` 里的 `npm install` 在**受限沙箱**下可能报 `spawn EPERM`（沙箱禁止管道创建），
  正常桌面环境下没这个问题
- 主角 up（背面）方向步子幅度偏小（长发遮腿 + 缩放到 192px 的损失），想明显需要重做 up 锚图

---

**最后一个提示**：这个工程的核心文件 `src/VenueScene.js` 有 1600 行，改动前建议先用
`grep -n` 定位到具体函数再动手，不要整文件通读。
