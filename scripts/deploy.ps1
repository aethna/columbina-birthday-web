<#
.SYNOPSIS
  新月再梦听羽生 · 一键构建并部署到阿里云服务器（站点 + 可选后端）。

.DESCRIPTION
  流程：预检 SSH → 构建 → 打包 dist → 上传 → 线上备份 → staging 解包校验
        → 原子切换（保留宝塔的 .user.ini/.htaccess）→ HTTP 验证 → 失败自动回滚。

  相比早期「先 rm -rf assets game audio 再解包」的老流程，这里不会在解包失败时
  留下残缺站点：新内容先在 staging 校验通过，再整目录切换，出问题一步切回。

.PARAMETER Api
  同时同步后端 server/ 到 /www/wwwroot/columbina-birthday-api 并重启服务。
  上传包 **严格排除 server/data/**（线上那里是真实投稿附件与密钥），切换时保留线上 data/ 与 node_modules/。

.PARAMETER SkipBuild
  跳过 npm run build，直接用现有 dist/ 部署。

.PARAMETER DryRun
  只构建、打包、上传，不切换、不重启。

.EXAMPLE
  pwsh scripts/deploy.ps1
  pwsh scripts/deploy.ps1 -Api
  pwsh scripts/deploy.ps1 -SkipBuild

.NOTES
  约定与线上档案见仓库根目录 AGENTS.md。
#>
[CmdletBinding()]
param(
  [string]$SshHost   = 'aliyun',
  [string]$SiteRoot  = '/www/wwwroot/47.102.116.172',
  [string]$ApiRoot   = '/www/wwwroot/columbina-birthday-api',
  [string]$Service   = 'columbina-birthday-api',
  [string]$PublicUrl = 'http://47.102.116.172',
  [switch]$Api,
  [switch]$SkipBuild,
  [switch]$DryRun,
  [switch]$NoBackup
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

$Root    = Split-Path -Parent $PSScriptRoot
$DistDir = Join-Path $Root 'dist'
$ServerDir = Join-Path $Root 'server'
$Ts      = Get-Date -Format 'yyyyMMdd-HHmmss'
$SiteTgzName = "site-dist-$Ts.tgz"
$ApiTgzName  = "api-src-$Ts.tgz"

function Say  ([string]$m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok   ([string]$m) { Write-Host "    OK  $m" -ForegroundColor Green }
function Warn ([string]$m) { Write-Host "    !   $m" -ForegroundColor Yellow }
function Die  ([string]$m) { Write-Host "    X   $m" -ForegroundColor Red; throw $m }

function Invoke-Remote {
  param([Parameter(Mandatory)][string]$Script, [switch]$AllowFail)
  $clean = ($Script -replace "`r", "")
  $out = $clean | ssh -o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=30 $SshHost 'bash -s' 2>&1
  $code = $LASTEXITCODE
  if ($code -ne 0 -and -not $AllowFail) {
    throw "远程脚本失败 (exit=$code)`n--- 远程输出 ---`n$($out -join "`n")"
  }
  [pscustomobject]@{ Code = $code; Output = @($out) }
}

function Test-Http {
  param([string]$Url, [int]$Expect = 200)
  $raw = (curl.exe -s -o NUL -w '%{http_code}' --max-time 20 $Url 2>$null)
  $n = 0; [void][int]::TryParse(($raw -join '').Trim(), [ref]$n)
  return ($n -eq $Expect)
}

# ============================================================ 1. 预检
Say "预检：SSH 连通性（$SshHost）"
$ping = Invoke-Remote -AllowFail -Script "whoami; hostname"
if ($ping.Code -ne 0) { Die "无法连接服务器：`n$($ping.Output -join "`n")" }
Ok "已连接：$(($ping.Output -join ' ').Trim())"

# ============================================================ 2. 构建
if ($SkipBuild) {
  Warn "跳过构建（-SkipBuild）"
} else {
  Say "构建：npm run build（含小游戏构建 + 同步 public/game）"
  Push-Location $Root
  try {
    & npm run build
    if ($LASTEXITCODE -ne 0) { Die "构建失败（exit=$LASTEXITCODE），已中止部署" }
  } finally { Pop-Location }
  Ok "构建完成"
}
if (-not (Test-Path (Join-Path $DistDir 'index.html'))) { Die "dist/index.html 不存在，构建产物缺失" }

# ============================================================ 3. 打包 + 上传
Say "打包站点产物"
$SiteTgzPath = Join-Path $Root $SiteTgzName
& tar -czf $SiteTgzPath -C $DistDir .
if ($LASTEXITCODE -ne 0) { Die "tar 打包失败" }
$mb = [math]::Round((Get-Item $SiteTgzPath).Length / 1MB, 1)
Ok "$SiteTgzName（$mb MB）"

Say "上传到服务器 /root/"
& scp -o BatchMode=yes -q $SiteTgzPath "${SshHost}:/root/"
if ($LASTEXITCODE -ne 0) { Die "scp 上传失败" }
Ok "上传完成"

if ($Api) {
  Say "打包后端源码（排除 data/ 与 node_modules/）"
  $ApiTgzPath = Join-Path $Root $ApiTgzName
  & tar -czf $ApiTgzPath --exclude=data --exclude=node_modules -C $Root server
  if ($LASTEXITCODE -ne 0) { Die "后端 tar 打包失败" }
  Ok "$ApiTgzName（$([math]::Round((Get-Item $ApiTgzPath).Length/1KB,0)) KB）"
  Say "上传后端包"
  & scp -o BatchMode=yes -q $ApiTgzPath "${SshHost}:/root/"
  if ($LASTEXITCODE -ne 0) { Die "后端 scp 上传失败" }
  Ok "后端包上传完成"
}

# ============================================================ 4. 站点切换
$siteOld = ''
if ($DryRun) {
  Warn "DryRun：跳过切换与验证（包已上传到 /root/$SiteTgzName）"
} else {
  Say "线上：备份 → staging 解包校验 → 原子切换"
  $tpl = @'
set -euo pipefail
TS='__TS__'
SITE='__SITE__'
TGZ='/root/__TGZ__'
BACKUP='__BACKUP__'
STAGE="/www/wwwroot/.site-stage-$TS"
OLD="/www/wwwroot/.site-old-$TS"

echo "[remote] staging 解包 -> $STAGE"
rm -rf "$STAGE"; mkdir -p "$STAGE"
tar -xzf "$TGZ" -C "$STAGE"

[ -f "$STAGE/index.html" ] || { echo "[remote] 校验失败: 缺 index.html"; exit 11; }
[ -d "$STAGE/assets" ]     || { echo "[remote] 校验失败: 缺 assets/";    exit 12; }
[ -d "$STAGE/game" ]       || { echo "[remote] 校验失败: 缺 game/";      exit 13; }

if [ "$BACKUP" = "1" ]; then
  echo "[remote] 备份当前站点"
  tar -czf "/root/site-backup-$TS.tgz" -C "$SITE" . && echo "[remote] 备份完成: /root/site-backup-$TS.tgz" || echo "[remote] 备份失败(继续)"
fi

for f in .user.ini .htaccess; do
  if [ -e "$SITE/$f" ]; then cp -a "$SITE/$f" "$STAGE/$f"; fi
done

echo "[remote] 原子切换"
mv "$SITE" "$OLD"
mv "$STAGE" "$SITE"
chown -R www:www "$SITE"
echo "[remote] SITE_DONE old=$OLD"
'@
  $remote = $tpl.Replace('__TS__', $Ts).Replace('__SITE__', $SiteRoot).Replace('__TGZ__', $SiteTgzName).Replace('__BACKUP__', $(if ($NoBackup) { '0' } else { '1' }))
  $r = Invoke-Remote -Script $remote
  $r.Output | ForEach-Object { if ($_ -match '^\[remote\]') { Ok ($_ -replace '^\[remote\]\s*','') } }
  $siteOld = "/www/wwwroot/.site-old-$Ts"

  # ---- 验证 ----
  Say "验证线上站点"
  $checks = @(
    @{ Name = '首页';          Url = "$PublicUrl/" },
    @{ Name = '游戏页';        Url = "$PublicUrl/game/index.html" },
    @{ Name = '后端 /health';  Url = "$PublicUrl/api/health" }
  )
  $allOk = $true
  foreach ($c in $checks) {
    if (Test-Http -Url $c.Url) { Ok "$($c.Name) 200" } else { $allOk = $false; Warn "$($c.Name) 未通过" }
  }

  if ($allOk) {
    Ok "站点部署成功"
    $rb = @'
set -e
OLD='__OLD__'
if [ -d "$OLD" ]; then rm -rf "$OLD"; echo "[remote] 清理旧目录 $OLD"; fi
'@
    [void](Invoke-Remote -AllowFail -Script $rb.Replace('__OLD__', $siteOld))
  } else {
    Warn "验证未通过 → 自动回滚"
    $rbt = @'
set -e
SITE='__SITE__'
OLD='__OLD__'
if [ ! -d "$OLD" ]; then echo "[remote] 找不到回滚目录 $OLD"; exit 1; fi
rm -rf "$SITE"
mv "$OLD" "$SITE"
chown -R www:www "$SITE"
echo "[remote] ROLLBACK_OK"
'@
    $rr = Invoke-Remote -AllowFail -Script $rbt.Replace('__SITE__', $SiteRoot).Replace('__OLD__', $siteOld)
    $rr.Output | ForEach-Object { Warn ($_ -replace '^\[remote\]\s*','') }
    Die "站点验证失败，已回滚到部署前状态"
  }
}

# ============================================================ 5. 后端
if ($Api -and -not $DryRun) {
  Say "线上：同步后端 server/"
  $tpl = @'
set -euo pipefail
export PATH="/usr/local/nodejs/bin:$PATH"
TS='__TS__'
API='__API__'
SVC='__SVC__'
TGZ='/root/__TGZ__'
STAGE="/www/wwwroot/.api-stage-$TS"
OLD="/www/wwwroot/.api-old-$TS"

echo "[remote] staging 解包"
rm -rf "$STAGE"; mkdir -p "$STAGE"
tar -xzf "$TGZ" -C "$STAGE"
SRC="$STAGE/server"
[ -f "$SRC/index.js" ] || { echo "[remote] 校验失败: 缺 server/index.js"; exit 21; }
[ -d "$SRC/lib" ]      || { echo "[remote] 校验失败: 缺 server/lib";      exit 22; }

echo "[remote] 备份后端(不含 node_modules)"
tar -czf "/root/api-backup-$TS.tgz" --exclude=./node_modules -C "$API" . \
  && echo "[remote] 备份完成: /root/api-backup-$TS.tgz" || echo "[remote] 备份失败(继续)"

echo "[remote] 切换后端目录（保留线上 data/ 与 node_modules/）"
mv "$API" "$OLD"
mv "$SRC" "$API"
cp -a "$OLD/data" "$API/data"
cp -a "$OLD/node_modules" "$API/node_modules"
chown -R www:www "$API"

echo "[remote] 安装依赖 (--omit=dev)"
cd "$API" && (npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || echo "[remote] npm install 警告")
chown -R www:www "$API"

echo "[remote] 重启 $SVC"
systemctl restart "$SVC"
sleep 2
systemctl is-active "$SVC"
rm -rf "$OLD"
echo "[remote] API_DONE"
'@
  $remote = $tpl.Replace('__TS__', $Ts).Replace('__API__', $ApiRoot).Replace('__SVC__', $Service).Replace('__TGZ__', $ApiTgzName)
  $r = Invoke-Remote -Script $remote
  $r.Output | ForEach-Object { if ($_ -match '^\[remote\]') { Ok ($_ -replace '^\[remote\]\s*','') } }

  if (Test-Http -Url "$PublicUrl/api/health") { Ok "后端 /api/health 200" } else { Warn "后端健康检查未通过，请查看 systemctl status $Service" }
}

# ============================================================ 6. 小结
Write-Host ""
Say "完成（时间戳 $Ts）"
Write-Host "    站点包     : /root/$SiteTgzName"
if (-not $DryRun -and -not $NoBackup) { Write-Host "    站点备份   : /root/site-backup-$Ts.tgz" }
if ($Api -and -not $DryRun)          { Write-Host "    后端备份   : /root/api-backup-$Ts.tgz（若备份成功）" }
Write-Host "    线上地址   : $PublicUrl/"
