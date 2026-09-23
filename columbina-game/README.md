# 哥伦比娅的梦境游廊

基于 Vue 3、Vite 6 和原生 CSS 的前端项目。

## 当前游戏

- `云隙轻歌`：点击控制角色飞行，穿过上下障碍物之间的空隙。
- `无尽巡游`：横版无限跑酷，支持一段、二段和三段跳，包含分阶段生成的裂缝、限高通道与空中障碍。
- `月亮棋`：只保留最近五枚有效棋子的特殊棋类对局。
- `星月五子棋`：15 × 15 棋盘上的玩家对哥伦比娅 AI 对局。
- `提瓦特战力党`（Teyvat Power Dice）：十二位提瓦特角色，投骰、选骰、重投，在攻防之间决出胜负；含 10 关剧情模式、自由对战（自选角色与难度）与三种 AI 难度。
  - 实现上与其他四个不同：它是**零依赖的单文件 HTML**（源码在 `public/teyvat-dice/`，自带素材目录），由 `TeyvatDiceGame.vue` 用 iframe 承载（16:9 横屏舞台 + 竖屏挡层），不进 Vue 打包流程。

## 环境要求

- Node.js 20 或更高版本
- npm 10 或更高版本

## 本地开发

Windows 用户可以直接双击项目根目录中的 `启动本地预览.bat`，脚本会自动安装缺少的依赖并打开浏览器。

也可以在终端中执行：

```bash
npm install
npm run dev
```

启动后，终端会显示本地访问地址。

> 不要直接双击 `index.html`。浏览器会阻止 Vite 项目通过 `file://` 协议加载模块。

## 生产构建

```bash
npm ci
npm run build
```

构建结果生成在 `dist` 目录，可交给静态网站服务器或托管平台部署。

## 源码交付

交付给上线负责人时，应包含以下内容：

- `src`、`public` 源码和静态资源目录
- `index.html`
- `package.json` 和 `package-lock.json`
- `vite.config.js`

`node_modules` 和 `dist` 无需打包，对方执行 `npm ci` 和 `npm run build` 即可重新生成。

## 常用命令

- `npm run dev`：启动开发服务器
- `npm run build`：生成生产版本
- `npm run preview`：本地预览生产版本
