# 🌙 新月再梦听羽生 · 哥伦比娅生日企划宣传站

给原神角色哥伦比娅做的生日企划宣传落地页。

> 企划性质：玩家自发组织的粉丝企划，与原神官方无关，不用于商业用途。
> 角色版权归米哈游所有。

---

## 技术栈

- **Vue 3**（组合式 API + `<script setup>`）
- **Vite 6**（开发服务器 + 生产构建）
- 站点本体是纯静态产物（无 UI 框架，样式为手写 CSS）
- **报名投稿**为前后端分离：`server/`（Node + MySQL API）+ `src/api/client.js` 调用，见下文「报名投稿」

---

## 快速开始

前置要求：**Node.js 18+**（推荐 20 / 22 / 24）

```bash
npm install      # 安装依赖（首次运行）
npm run dev      # 启动开发服务器 → http://localhost:5173
npm run build    # 生产构建 → 输出到 dist/
npm run preview  # 本地预览构建产物 → http://localhost:4173
```

> 日常开发用 `npm run dev`（热更新），正式发布用 `npm run build` 产物（`dist/`）。

---

## 目录结构

```
columbina-birthday/
├── index.html              # Vite 入口（含字体 CDN 引用，页面由 Vue 挂载）
├── package.json            # 依赖与脚本
├── vite.config.js          # 构建配置（base:'./'，可部署任意子路径；dev/preview 把 /api 代理到本机后端）
├── server/                 # 报名投稿后端（Node + MySQL，独立于站点构建，详情见 server/README.md）
├── deploy/                 # 部署用的 nginx / systemd 模板
├── public/
│   ├── audio/              # 背景音乐（nod-krai.bin，右上角喇叭开关控制）
│   └── game/               # 「梦境游廊」小游戏构建产物（原样发布到 dist/game/）
└── src/
    ├── main.js             # 应用入口（挂载 #app）
    ├── App.vue             # 页面骨架：区块组合 + 滚动显现观察
    ├── styles/
    │   └── base.css        # 全局样式：:root 变量、背景层、通用工具类
    ├── composables/
    │   └── useCountdown.js # 倒计时逻辑（目标日期在这里改）
    ├── api/
    │   └── client.js       # 后端接口封装（上传分片 / 提交投稿 / 查回执）
    ├── assets/
    │   └── hero_4k.png     # Hero 背景图（4096×2304，官方壁纸「月夜的叙事诗」）
    └── components/
        ├── SkyCanvas.vue   # canvas 飘霜 + 光羽 + 星星（全屏背景动效）
        ├── AudioToggle.vue # 右上角背景音乐开关（播放=喇叭，暂停=喇叭加斜线）
        ├── HeroSection.vue # 首屏：标题定位 + 倒计时 + 滚动提示
        ├── IntroSection.vue# 企划介绍 + 角色档案卡
        ├── WorksSection.vue# 产出预告卡片
        ├── GameSection.vue # 「与哥伦比娅一起玩游戏」入口模块
        ├── TimelineSection.vue # 企划时间线
        ├── CtaSection.vue  # 参与引导区（「我要报名」+「添加q群」两个按钮）
        ├── SiteFooter.vue  # 页脚声明
        ├── SubmitPage.vue  # 报名投稿页（页内切换，不跳新标签页）
        ├── FileUploader.vue# 作品文件上传（分片 + 断点续传）
        └── JoinModal.vue   # 参与弹窗（QQ 群号在这里改）
```

---

## 修改指南

| 要改的内容                | 去哪里改                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| 大标题「新月再梦听羽生」、副标题、装饰语 | `HeroSection.vue`                                                                                       |
| 企划介绍、角色档案卡           | `IntroSection.vue`                                                                                      |
| 产出预告卡片               | `WorksSection.vue`                                                                                      |
| 「一起玩游戏」入口模块          | `GameSection.vue`（按钮指向 `./game/index.html`，游戏文件在 `public/game/`）                                        |
| 时间线                  | `TimelineSection.vue`                                                                                   |
| 参与区文案、按钮             | `CtaSection.vue`                                                                                        |
| 页脚声明                 | `SiteFooter.vue`                                                                                        |
| **弹窗 QQ 群号**         | `JoinModal.vue` 里的 `qq` ref（当前 `'1087063966'`），「复制 QQ 号」按钮自动跟随新号码                                       |
| 倒计时目标日期              | `src/composables/useCountdown.js` 里的 `TARGET`（当前 2027-01-14 零点）                                         |
| 背景音乐文件               | 覆盖 `public/audio/nod-krai.bin` 即可（内容用 MP3/AAC，**别用 Ogg——Safari 不支持**；后缀保持 `.bin` 不要改，否则会被国产浏览器当作音频资源嗅探） |
| 背景音乐音量               | `src/components/AudioToggle.vue` 里的 `VOLUME`（当前 0.5）                                                    |
| 背景音乐何时开始播放           | `AudioToggle.vue`：进站不主动播放；页面**下滑**（超过 6px）或首次点击/按键后才开始，一直不动则保持安静                                        |
| 标题贴人物位置              | `HeroSection.vue` 里的 `NECK`（基于 4096×2304 原图的归一化坐标，当前 x: 0.5151, y: 0.44）                                |
| 换背景图                 | 覆盖 `src/assets/hero_4k.png` 即可；**换了尺寸记得同步改 `HeroSection.vue` 的 `ORIG_W / ORIG_H`**                      |
| 配色 / 字体              | `src/styles/base.css` 的 `:root` 变量（--bg / --blue / --gold / --serif 等）                                  |
| **报名按钮 / 表单字段**      | `src/components/SubmitPage.vue`（字段、下拉选项、必填规则都在这个文件里）                                                    |
| **投稿须知文案**           | `SubmitPage.vue` 里的 `NOTICE_TEXT`（改文案不用动后端）                                                             |
| 上传限制（大小 / 分片）        | `server/config.json` 的 `maxFileMB` / `defaultChunkMB`；前端提示文案在 `FileUploader.vue` 的 props                |
| 提交频率限制               | `server/config.json` 的 `submitPerHour`（按 IP 每小时）                                                        |
| 粒子数量 / 星星数量          | `SkyCanvas.vue`（霜粒 46 个、星星 80 个）                                                                        |
| 区块增删                 | 在 `App.vue` 增删组件引用；新区块记得加 `class="reveal"` 才能有滚动浮现动画                                                    |

---

## 报名投稿（前后端分离）

首页 CTA 区有两个按钮：**「我要报名」**（在上面）和 **「添加q群」**（原「参与企划」）。
点「我要报名」不会开新标签页，而是在**同一个页面内切换**到投稿页（URL 变成 `#/signup`，刷新/后退也能回到该页）。

### 前端

- 投稿页：`src/components/SubmitPage.vue`（字段规则、条件显示、加减行、投稿须知门禁、右上角「我要修改」）
- 修改已有投稿：右上角「我要修改」→ 输入投稿编号 → 读回原内容（不用重填）→ 保存即覆盖，**编号不变**；附件可保留或删掉
- 上传：`src/components/FileUploader.vue`（分片上传 + 断点续传，支持拖拽 / 选文件；修改已有投稿时回显原有附件）
- 接口封装：`src/api/client.js`（默认请求 `/api`，可用 `VITE_API_BASE` 覆盖）

### 后端

`server/` 是一个独立的 Node 服务（只提供 JSON API，静态页面仍由 nginx 托管），数据库为 **MySQL**。
详见 [`server/README.md`](server/README.md)。

```bash
cd server
npm install
node index.js          # 默认监听 127.0.0.1:8788
```

本地开发时 `npm run dev` 已把 `/api` 代理到 `127.0.0.1:8788`（见 `vite.config.js`），不需要额外配置。

### 部署到自己的服务器

前端是纯静态产物，后端是独立的 Node 服务（默认只监听本机 8788，由 nginx 反代 `/api/`）。
整个过程就三步：

```bash
# 1. 本地打包
npm run build                 # 游戏没改时用 npx vite build 更快
tar -czf site-dist.tgz -C dist .

# 2. 上传（<用户>@<服务器> 换成你自己的）
scp site-dist.tgz <用户>@<服务器>:~/

# 3. 服务器上解包到站点根目录
tar -xzf ~/site-dist.tgz -C <站点根目录>
```

后端有改动时，把 `server/` 一并打包上传，解包后 `npm install --omit=dev`，再重启后端服务。
nginx 反代与 systemd 常驻的配置样例见 [`deploy/`](deploy/)；数据库、端口、密钥文件路径都在 `server/config.json` 里按实际环境填写。

---

## 小游戏接入（「哥伦比娅的梦境游廊」）

站点内置了小游戏（源码在 `columbina-game/`），入口是 Works 与时间线之间的「与哥伦比娅一起玩游戏」模块，点击后**在新标签页**打开。

当前包含五款：

| 游戏     | 简介                          |
| ------ | --------------------------- |
| 云隙轻歌   | 点击控制角色飞行，穿过上下障碍物之间的空隙       |
| 无尽巡游   | 横版无限跑酷，一段 / 二段 / 三段跳        |
| 月亮棋    | 只保留最近五枚有效棋子的特殊棋类对局          |
| 星月五子棋  | 15 × 15 棋盘，对哥伦比娅 AI         |
| 提瓦特战力党 | 十二位提瓦特角色，投骰、选骰、重投，在攻防之间决出胜负 |

- 游戏源码：`columbina-game/`（独立的 Vue 3 + Vite 项目，不参与本站构建流程）
- 发布产物：`public/game/`（`npm run build` 时由 Vite 原样复制到 `dist/game/`）
- 游戏更新后，重新构建并同步产物：

```powershell
cd columbina-game
npm run build
Remove-Item ..\public\game -Recurse -Force
New-Item -ItemType Directory -Path ..\public\game | Out-Null
Copy-Item .\dist\* ..\public\game -Recurse
```

> 游戏为纯静态产物且已设 `base:'./'`，放子路径即可正常加载，无需额外服务器配置。

---

## 部署上线（免费）

1. `npm run build` 生成 `dist/` 目录
2. 把 `dist/` 里的内容传到 GitHub 仓库
3. 仓库 Settings → Pages → Source 选对应分支 / 目录
4. 等约 1 分钟，得到 `https://<你的用户名>.github.io/<仓库名>/` 即上线
5. 想绑定自定义域名：在 Pages 设置里填域名 + 到域名商加一条 CNAME 记录

> `vite.config.js` 已设 `base: './'`，部署到子路径（如 GitHub Pages 的 `用户名.github.io/仓库名/`）也不会丢资源。

更新内容：改完代码后重新 `npm run build`，把新 `dist/` 推上去即可。

---

## 素材与版权

- 背景图来源：米游社官方壁纸合集《挪德卡莱新角色「月夜的叙事诗」》（4096×2304 PNG，官方发布）
- 角色设定：原神角色，哥伦比娅·希珀塞莱尼娅
- 背景音乐：《挪德卡莱 Nod-Krai》（HOYO-MiX & AURORA），《如生之不竭 Life Is Inexhaustible》，《黄金城的祷颂 Kathisma Chrysopoleos》，《黑雪鹄的夜梦 Dream of the Black Snow Swan》，《新月的摇篮曲（其一）：伴月同眠 Lullaby of the New Moon (I): Somnias a Luna》，《暮月雨时 Of Longing Rain and Moon》 （HOYO-MiX），站点使用转码后的 128 kbps MP3 版本；版权归米哈游所有
- 本企划为粉丝自发组织，非官方，不得用于商业用途；原神及角色版权归米哈游所有

---

## 常见问题

| 问题                | 解决                                                                   |
| ----------------- | -------------------------------------------------------------------- |
| 页面打开是空白/黑屏        | 确认已执行 `npm install`；开发用 `npm run dev` 访问 5173，生产用 `npm run build` 产物 |
| npm install 报错    | 确认 Node ≥ 18；可删除 `node_modules` 和 `package-lock.json` 后重装            |
| 端口被占用             | `npm run dev -- --port 5174`，或 `npm run preview -- --port 4174`      |
| 打开后背景是黑的          | 确认 `src/assets/hero_4k.png` 存在                                       |
| 标题不在人物上           | 确认背景图未换；换过的话检查 `ORIG_W / ORIG_H` 是否等于新图尺寸                            |
| 字体样式变了            | 离线导致的字体 CDN 降级，联网刷新即可恢复                                              |
| 倒计时不准             | 检查系统时区是否为 GMT+8；`TARGET` 为东八区时间                                      |
| 点了「一起玩游戏」白屏 / 404 | 确认 `public/game/` 存在并已重新 `npm run build`（产物应在 `dist/game/`）          |

---

