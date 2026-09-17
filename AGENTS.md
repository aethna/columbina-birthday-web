# AGENTS.md — 本项目的常驻工作约定

> 给在本仓库 / 本工作区（`D:\program\columbina-birthday`）里工作的 AI 编码代理，以及未来的自己看。
> 授权确认：**2026-09-17，由用户（aethna / 方培源）明确下达**。

---

## 1. 常驻授权：改完直接 PR 合并 + 直接上线（无需逐次确认）

对本工作区的任何代码修改，代理可以**直接执行下面这条完整链路，不必每步询问用户**：

1. 本地改代码 → `npm run build`（构建不过就不许往下走）
2. `git commit` → 推到新分支 → **开 PR → 直接合并到 `main`**（squash + 删分支）
3. **直接把改动部署到线上服务器**：`pwsh scripts/deploy.ps1`（涉及 `server/` 时加 `-Api`）
4. 回报结果：commit hash、PR 号、部署时间、验证结论、备份文件路径

| | |
| --- | --- |
| GitHub 仓库 | `aethna/columbina-birthday-web`（**public**，默认分支 `main`，`main` 无分支保护） |
| 线上站点 | http://47.102.116.172/ ，后台 http://47.102.116.172/#/admin |
| 提交信息风格 | conventional commits + 中文描述，例：`feat(signup): 右上角「我要修改」…` |

---

## 2. 例外：这些仍然要先问用户

常驻授权**不覆盖**下列操作，必须先报告、拿到明确同意再动：

- **删除或覆盖线上数据**：`/www/wwwroot/columbina-birthday-api/data/`（真实投稿附件、库口令、admin 密钥、`secret.key`）、MySQL 中任何 `DROP` / `TRUNCATE` / 批量 `DELETE`
- 删除站点根目录本身，或 `rm -rf` 线上任何非构建产物目录
- 改动宝塔面板、nginx **主配置**、防火墙 / iptables / Tailscale / 系统级服务
- 把任何**密钥 / 口令 / 私钥**写进仓库（仓库是 public，一次误提交等于公开）
- 强推（`--force*`）、历史重写、删除他人分支
- 触碰同机其它业务：`random-pic`(8787)、AstrBot、NapCat、MySQL 里不属于本站的库

> 原则：**可逆的操作放手做，不可逆的操作先喊人**。构建失败、验证失败、回滚失败都算事故，必须如实报告。

---

## 3. 线上环境档案

| 项 | 值 |
| --- | --- |
| 服务器 | `47.102.116.172`，SSH 别名 **`ssh aliyun`**（`root`，密钥 `C:\Users\fang\.ssh\openclaw_aliyun`，`IdentitiesOnly yes`） |
| 主机指纹 | `SHA256:0WCQQGewcRX9S/jXeaJey84tGVQviCei7X2F+K7YcCk`（ED25519）——**连接前先核对** |
| 站点根 | `/www/wwwroot/47.102.116.172`（属主 `www:www`） |
| 后端 | `/www/wwwroot/columbina-birthday-api`，systemd 服务 `columbina-birthday-api`（`www` 用户，监听 `127.0.0.1:8788`） |
| nginx 扩展配置 | `/www/server/panel/vhost/nginx/extension/47.102.116.172/api.conf`（`/api/` 反代 8788） |
| 系统 | Alibaba Cloud Linux 3 (OpenAnolis) / nginx 1.28.3 / MySQL 5.7.40 / 宝塔面板 `:8888` |
| 备份惯例 | `/root/site-backup-<时间戳>.tgz`、`/root/site-dist-<时间戳>.tgz` |

---

## 4. 部署

```powershell
pwsh scripts/deploy.ps1                 # 构建 + 部署站点
pwsh scripts/deploy.ps1 -Api            # 同时同步后端 server/（自动排除 data/）
pwsh scripts/deploy.ps1 -SkipBuild      # 用现有 dist/ 直接部署
pwsh scripts/deploy.ps1 -DryRun         # 只构建/打包/上传/备份，不切换、不重启
```

脚本行为：构建 → 打包 → `scp` → 线上备份 → 解包到 staging → 校验 → **原子切换**（失败自动回滚）→ HTTP 验证。
比早期"先 `rm -rf assets game audio` 再解包"的老流程安全：老流程在解包失败时会留下残缺站点。

---

## 5. 本项目已知的坑（踩过的，别再踩）

### 站点与构建

1. **`public/game/` 签入了构建产物**，CRLF 差异会让每次构建产生新哈希 → 构建后要清理没被 `public/game/index.html` 引用的旧文件；最稳是删掉整个 `public/game` 后重跑 `node scripts/sync-game-dist.mjs`。
2. `npm run build` 会先构建小游戏再建站；只改主站想快可以用 `npx vite build`。
3. **站点根里有宝塔生成、但不属于构建产物的文件，切换时必须全部保留**：
   - `.user.ini` —— 被加了 **immutable 属性**（`chattr +i`），`cp -a` **不保留**该属性；删旧目录前也必须先 `chattr -i`，否则 root 也删不掉（`Operation not permitted`）；
   - **`404.html`** —— nginx 配置里 `error_page 404 /404.html` 依赖它，弄丢会导致 404 处理异常；
   - `.htaccess`、`README.md`。
   `scripts/deploy.ps1` 已改为「保留旧目录里所有不在新包顶层的条目」，并在切换后补回 immutable。
4. **部署后端必须排除 `server/data/`**——线上那里有真实投稿附件与密钥，覆盖 = 数据丢失 + 服务连不上数据库。
5. 服务器上 `curl` 测站点路径**必须带** `-H 'Host: 47.102.116.172'`，否则落到默认站点返回 404。

### 本机环境（Windows + 受限沙箱）

6. **PowerShell 通过管道给原生程序喂 stdin 时会自动补 CRLF** → `xxx | ssh host bash -s` 会让远程 bash 报 `$'hostname\r': command not found`。改用 **base64 单行传输**：`echo <b64> | base64 -d > /tmp/x.sh && bash /tmp/x.sh`（`Invoke-Remote` 已封装）。
7. PowerShell 里 `ssh aliyun "含引号 / && 的命令"` 会被本地解析坏 → 一律交给 `Invoke-Remote`。
8. **`.ps1` 必须是 UTF-8 带 BOM**：否则 Windows PowerShell 5.1 按 GBK 解码，中文变乱码、脚本直接语法报错。注意编辑工具保存时会**吃掉 BOM**，改完要补：
   ```powershell
   $p='scripts/deploy.ps1'; $t=[Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($p)).TrimStart([char]0xFEFF)
   [IO.File]::WriteAllText($p,$t,(New-Object Text.UTF8Encoding($true)))
   ```
9. 本机 `pwsh`（PowerShell 7）在受限 shell 里**不可用** → 用 `& ./scripts/deploy.ps1` 在会话内调用。
10. **`npm run build` 需要 esbuild 以管道 spawn 子进程**，受限沙箱下报 `Error: spawn EPERM`（与坑 6 同源：沙箱禁止创建管道）→ 构建需在放宽权限下执行。
11. 本机 git 默认 `http.sslBackend=schannel` 会握手失败（`SEC_E_NO_CREDENTIALS`）→ 加 `-c http.sslBackend=openssl`。

### GitHub 写入（本机网络受限）

12. `git push` 经常失败：`github.com:443` 21 秒超时或 `Connection was reset`（**GET 能过、POST 被重置**）；而 git 的凭据助手（GCM）要靠 `sh.exe` 启动，在沙箱下同样 `couldn't create signal pipe`。
    **替代路径：走 GitHub REST API**（`api.github.com` 稳定可用）——
    `POST /git/blobs` → `POST /git/trees` → `POST /git/commits` → `POST /git/refs` → `POST /pulls` → `PUT /pulls/{n}/merge`；
    用 `gh api --input <json文件>` 传参（避免 PowerShell 把含空格/引号的参数拆坏）。
13. 合并 PR 之后**先确认合并成功、再删 head 分支**：曾因合并命令参数被拆坏而失败、却紧接着删了分支，导致 PR 被 GitHub 自动关闭，只能重建分支重开 PR。
14. **网络命令失败后绝不要继续执行破坏性 git 操作**：曾因 `git fetch` 超时未检查 exit code，紧接着 `git reset --hard origin/main`（用的还是旧的 origin/main）把刚合并的内容从本地工作区 reset 掉——远端安然无恙，本地白忙一场。凡 fetch/push 之后要 reset/checkout，先确认 `$LASTEXITCODE`。

---

## 6. 常用命令

| 用途 | 命令 |
| --- | --- |
| 开发 | `npm run dev` → http://localhost:5173（`/api` 已代理到 8788） |
| 构建 | `npm run build` |
| 预览产物 | `npm run preview` |
| 本地跑后端 | `cd server && node index.js`（需本机 MySQL） |
| 游戏本地预览 | 双击 `columbina-game\启动本地预览.bat` |
| 线上健康检查 | `curl -s http://47.102.116.172/api/health` |
| 线上站点自检 | `curl -s -o /dev/null -w '%{http_code}' -H 'Host: 47.102.116.172' http://127.0.0.1/`（服务器上执行） |
