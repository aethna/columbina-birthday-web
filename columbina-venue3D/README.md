# columbina-venue3D —— 哥伦比娅生日会 3D 会场（源码）

与 `columbina-venue/`（2D Phaser 会场）并列的第二套会场：**React 19 + three.js（WebGPU 路线）+ Vite 7**。
默认入口 `index.html`，构建产物 `dist/`。

> 本项目基于开源模板 **False Earth**（MomentChan）二次开发，模板原始说明见
> [`README-upstream-falseearth.md`](./README-upstream-falseearth.md)，许可证为 MIT（见 [`LICENSE`](./LICENSE)）。

---

## 1. 仓库里有什么 / 没有什么

| | 状态 | 体积 |
|---|---|---|
| 代码（`src/`、`packages/`、配置、`docs/`） | ✅ 已入库 | 约 **1.8 MB / 183 文件** |
| 运行时素材（`public/` 下 models / venue / forest / columbina / textures …） | ❌ **未入库** | 约 **364.8 MB** |
| 模型与贴图（`src/assets/`：`wingship_api/Ship01.glb` 26.97 MB、`moonship/*.obj+png` 1.5 MB） | ❌ **未入库** | 约 **28.4 MB** |
| `node_modules/`、`dist/`、`_logs/` | ❌ 不入库（`.gitignore` 已忽略前两项） | — |

**素材合计约 393 MB，单独打包为 zip 交付**，不进 git 历史（原因见第 5 节）。

拿到素材后，解包到下面两个位置即可让仓库恢复成可构建状态：

```
columbina-venue3D/public/        ← zip 内 public/
columbina-venue3D/src/assets/    ← zip 内 src/assets/
```

---

## 2. 目录结构

```
columbina-venue3D/
├── index.html                 入口（当前：单页，挂载 src/index.jsx）
├── package.json               name: columbina-birthday-3d
├── pnpm-lock.yaml / pnpm-workspace.yaml
├── tsconfig.json              （仅类型提示，构建不跑 tsc）
├── vite.config.js             base "/"、https、port 5181、outDir dist
├── src/
│   ├── app/  components/  core/  ui/  debug/
│   ├── assets/                ← 需要从素材包解包
│   └── index.jsx / style.css
├── packages/three-core/       本地工作区包（WebGPUCanvas、PostFX、音频、输入…）
├── docs/                      场景架构说明
└── public/                     ← 需要从素材包解包
    ├── models/    154.1 MB   PMX / PMD 角色模型
    ├── venue/      82.3 MB   会场建筑与道具 + manifest.json
    ├── forest/     52.6 MB   森林/植被
    ├── columbina/  40.7 MB   角色本体 + 23 个 VMD 动作
    ├── textures/   30.9 MB
    ├── audio/       1.8 MB
    ├── sky/         1.2 MB
    ├── mmd/         0.7 MB   MMD 物理 wasm
    ├── motion/      0.2 MB
    └── fonts/       0.3 MB
```

---

## 3. 构建与本地预览

```bash
# Node 20+；项目用 pnpm，npm 也可以
pnpm install          # 或 npm install
pnpm dev              # https://localhost:5181  （vite.config.js 开了 https）
pnpm build            # → dist/
pnpm preview
```

⚠️ **源码里的资源路径是 `/` 开头的绝对路径**（共 151 处，分布在 29 个文件），再加上
`vite.config.js` 的 `base: "/"`，所以构建产物**只能挂在域名根**。这是决定「放哪」的关键，见第 4 节。

---

## 4. 两种上线方式（请库主拍板）

### 方案 A（推荐）：站点根之外 + nginx alias

```
/www/venue3d/
├── releases/20261019-0700/     每次发布一个新目录
└── current -> releases/20261019-0700/
```

```nginx
location /venue3D/ {
    alias /www/venue3d/current/;
}
```

- **不影响 2D**：`scripts/deploy.ps1` 是整目录原子切换站点根，这个目录在站点根之外，永远碰不到。
- **回滚**：`ln -sfn` 指回上一个 release，秒级。
- **目录本身不需要改代码**——但 URL 前缀是 `/venue3D/`，`base` 仍是 `/` 会 404，需要：

  ```js
  // vite.config.js
  base: "/venue3D/",
  ```

  以及 151 处 `/models/...`、`/venue/...` 等绝对路径改成 `/venue3D/models/...`（这部分我们可以代改并本地验证）。

### 方案 B：放进主站仓库的 `public/venue3D/`

- 优点：跟 2D 一样由 `deploy.ps1` 自动带上，无需 nginx 改动。
- 缺点：**仓库 +393 MB**；每次构建 `dist` 都会把它打进 tgz，部署包与线上备份各翻一倍。
- 同样要改 `base: "/venue3D/"` 与 151 处路径。

### 方案 C：挂二级域名 `3d.columbina520.com`（零代码改动）

- 不改 `base`、不改 151 处路径，直接把 `dist/` 作为该站点根。
- 需要：一个 DNS 记录 + 一个 nginx server 块 + 一张证书（acme.sh 已在本机跑，加一个域名即可）。

---

## 5. 为什么素材不直接进 git

- `public/` 364.8 MB + `src/assets/` 28.4 MB。git 会把每个版本的二进制完整存一份，改一次素材历史就翻一倍；
- clone 一次要拉 400 MB，之后每次 `pull` 都变慢；
- 仓库是 public，素材进了就等于公开可下载。

推荐做法（三选一）：

1. **服务器独立目录**（方案 A）——素材只上传一次，代码更新只传几 MB；
2. **GitHub Release 附件**——打一个 `assets-v1.zip`，clone 后下载解包，有版本号、不进 git 历史；
3. **线下传输**——网盘/微信直接发。

> **实际已采用：方案 2（GitHub Release 附件）**（2026-10-19 落地）
>
> - 下载：<https://github.com/aethna/columbina-birthday-web/releases/tag/venue3d-assets-v1>
> - 文件：`columbina-venue3D-assets-v1.zip`（306,110,433 字节 / 291.9 MB，zip 内 421 个条目）
> - SHA256：`C5CE9F16E2AD57425556AF4260323213D313AB09822D1FB41BAC24181857AC06`
> - 解压位置：解到 `columbina-venue3D/` 下即可（zip 内就是 `public/` 与 `src/assets/`）
> - 校验：`sha256sum columbina-venue3D-assets-v1.zip` 应与上面一致
>
> 线上站点 <https://3d.columbina520.com/> 的运行时素材即来源于这个包。

若选 1 或 2，建议仓库里保留一份 `assets-manifest.json`（文件名 + 大小 + sha256，几 KB 文本），
用来校验「代码版本 ↔ 素材版本」是否错配。需要的话我们可以生成。

---

## 6. 已知注意事项

- `vite.config.js` 里 `server.https: true`、`port: 5181`、`strictPort: true`，本地必须走 https。
- `dist/` 里有 `_headers`（Cloudflare Pages/Netlify 语法）——**宝塔 nginx 不认**，CSP 等响应头要在 nginx 里 `add_header`。
- 本项目**没有任何 CI**；线上更新仍然要有人跑构建/上传。
- 代码注释里保留了开发期的中文记录（含本机路径、迭代笔记），不影响运行；如果希望对外干净，我们可以另做一次注释清理。

---

## 7. 下一步

请库主在 **A / B / C** 里选一个，我们据此：

1. 改 `base` 与 151 处资源路径（C 除外）；
2. 生成 `assets-manifest.json`；
3. 把 393 MB 素材包按选定方式交付（服务器目录 / Release 附件 / 网盘）；
4. 本地构建 + 验证 `https://…/venue3D/` 能跑通后再交付产物。
