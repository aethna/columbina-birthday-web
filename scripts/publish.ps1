<#
.SYNOPSIS
  把本地改动通过 GitHub REST API 提交并合并：blob → tree → commit → 分支 → PR → squash 合并 → 同步本地。

.DESCRIPTION
  为什么不用 `git push`：
    本机网络下 github.com:443 的 POST 经常被重置（GET 能过，但推送 21 秒超时或 Connection was reset），
    而 git 的凭据助手（GCM）要靠 sh.exe 启动、在受限沙箱里无法创建命名管道。
  api.github.com 则稳定可用，所以整条提交链路改走 REST API。
  原理与坑详见仓库根目录 AGENTS.md 第 5 节「GitHub 写入」。

.PARAMETER Message
  提交信息，支持多行；PR 标题默认取第一行。

.PARAMETER Body
  PR 描述正文（markdown）。

.PARAMETER NoMerge
  只创建 PR、不自动合并（默认按用户的常驻授权直接 squash 合并）。

.EXAMPLE
  & ./scripts/publish.ps1 -Message "fix(deploy): 切换站点时保留 404.html 与 .user.ini 属性"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Message,
  [string]$Title,
  [string]$Body = '',
  [string]$Repo  = 'aethna/columbina-birthday-web',
  [string]$Base  = 'main',
  [switch]$NoMerge
)

# 注意：原生命令（git / gh）把提示写进 stderr 时，Stop 模式会让脚本直接抛错中断，
# 所以这里用 Continue，错误一律靠 $LASTEXITCODE 与 Die 显式判断。
$ErrorActionPreference = 'Continue'
$PSNativeCommandUseErrorActionPreference = $false

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Say ([string]$m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok  ([string]$m) { Write-Host "    OK  $m" -ForegroundColor Green }
function Die ([string]$m) { Write-Host "    X   $m" -ForegroundColor Red; throw $m }

$utf8 = New-Object Text.UTF8Encoding($false)
$work = Join-Path $Root 'deploy-tmp'
New-Item -ItemType Directory -Force -Path $work | Out-Null
function Api-Body($obj, $name) {
  $f = Join-Path $work $name
  [IO.File]::WriteAllText($f, ($obj | ConvertTo-Json -Depth 8 -Compress), $utf8)
  return $f
}
function Gh-Api([string[]]$argsArr) {
  $out = & gh @argsArr 2>&1
  if ($LASTEXITCODE -ne 0) { Die "gh 调用失败：gh $($argsArr -join ' ')`n$($out -join "`n")" }
  return ($out -join "`n").Trim()
}

if (-not $Title) { $Title = ($Message -split "`n")[0].Trim() }
if (-not $Body)  { $Body  = $Message }

# ---------------------------------------------------------------- 1. 改动清单
Say "读取本地改动"
$lines = @(& git -c core.quotepath=false status --porcelain)
if (-not $lines.Count) { Die "工作区没有改动，无需发布" }
$changes = @()
foreach ($l in $lines) {
  if ($l.Length -lt 4) { continue }
  $xy = $l.Substring(0, 2)
  $path = $l.Substring(3).Trim()
  if ($path -match ' -> ') { $path = ($path -split ' -> ')[-1] }
  $changes += [pscustomobject]@{ XY = $xy; Path = $path }
}
foreach ($c in $changes) { Ok "$($c.XY)  $($c.Path)" }
if (-not $changes.Count) { Die "未能解析改动清单" }

# ---------------------------------------------------------------- 2. base
Say "取远端 $Base 当前状态"
$baseSha  = Gh-Api @('api', "repos/$Repo/git/ref/heads/$Base", '--jq', '.object.sha')
$baseTree = Gh-Api @('api', "repos/$Repo/git/commits/$baseSha", '--jq', '.tree.sha')
Ok "base commit $baseSha"
Ok "base tree   $baseTree"

# ---------------------------------------------------------------- 3. blobs
Say "创建 blob"
$treeItems = @()
foreach ($c in $changes) {
  if ($c.XY -match 'D') {
    $treeItems += @{ path = $c.Path; mode = '100644'; type = 'blob'; sha = $null }
    Ok "删除 $($c.Path)"
    continue
  }
  $local = Join-Path $Root ($c.Path -replace '/', '\')
  if (-not (Test-Path $local)) { Die "文件不存在：$($c.Path)" }
  $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($local))
  $jf  = Api-Body @{ content = $b64; encoding = 'base64' } ("blob-" + [guid]::NewGuid().ToString('N').Substring(0,8) + ".json")
  $sha = Gh-Api @('api', '-X', 'POST', "repos/$Repo/git/blobs", '--input', $jf, '--jq', '.sha')
  $treeItems += @{ path = $c.Path; mode = '100644'; type = 'blob'; sha = $sha }
  Ok "$($c.Path) -> $($sha.Substring(0,10))…"
}

# ---------------------------------------------------------------- 4. tree / commit / ref
Say "创建 tree"
$tjf  = Api-Body @{ base_tree = $baseTree; tree = $treeItems } 'tree.json'
$tree = Gh-Api @('api', '-X', 'POST', "repos/$Repo/git/trees", '--input', $tjf, '--jq', '.sha')
Ok "tree $tree"

Say "创建 commit"
$cjf    = Api-Body @{ message = $Message; tree = $tree; parents = @($baseSha) } 'commit.json'
$commit = Gh-Api @('api', '-X', 'POST', "repos/$Repo/git/commits", '--input', $cjf, '--jq', '.sha')
Ok "commit $commit"

$branch = 'chore/publish-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
Say "创建分支 $branch"
$rjf = Api-Body @{ ref = "refs/heads/$branch"; sha = $commit } 'ref.json'
[void](Gh-Api @('api', '-X', 'POST', "repos/$Repo/git/refs", '--input', $rjf, '--jq', '.ref'))
Ok "分支已创建"

# ---------------------------------------------------------------- 5. PR
Say "创建 PR"
$pjf  = Api-Body @{ title = $Title; head = $branch; base = $Base; body = $Body } 'pr.json'
$prNum = Gh-Api @('api', '-X', 'POST', "repos/$Repo/pulls", '--input', $pjf, '--jq', '.number')
Ok "PR #$prNum  https://github.com/$Repo/pull/$prNum"

# ---------------------------------------------------------------- 6. merge
if ($NoMerge) {
  Write-Host "    (已指定 -NoMerge，跳过合并)" -ForegroundColor Yellow
} else {
  Say "squash 合并 PR #$prNum"
  # 用 --input 传参：PowerShell 会把含空格/引号的内联参数拆坏（踩过）
  $mjf = Api-Body @{ merge_method = 'squash' } 'merge.json'
  $res = Gh-Api @('api', '-X', 'PUT', "repos/$Repo/pulls/$prNum/merge", '--input', $mjf)
  if ($res -notmatch '"merged"\s*:\s*true') { Die "合并未成功：$res" }
  $mergeSha = ([regex]::Match($res, '"sha"\s*:\s*"([0-9a-f]{40})"')).Groups[1].Value
  Ok "已合并，main -> $mergeSha"
  # 确认合并成功后再删分支
  [void](Gh-Api @('api', '-X', 'DELETE', "repos/$Repo/git/refs/heads/$branch"))
  Ok "已删除远端分支 $branch"
}

# ---------------------------------------------------------------- 7. 同步本地
Say "同步本地到 $Base（先确认 fetch 成功再 reset —— 踩过这个坑）"
$fetched = $false
for ($i = 1; $i -le 6; $i++) {
  $null = & git -c http.sslBackend=openssl fetch origin $Base --prune 2>&1
  if ($LASTEXITCODE -eq 0) { $fetched = $true; Ok "fetch 成功（第 $i 次）"; break }
  Write-Host "    fetch 第 $i 次失败，重试…" -ForegroundColor Yellow
  Start-Sleep -Seconds 6
}
if ($fetched) {
  $null = & git reset --hard "origin/$Base" 2>&1
  $null = & git branch -D $branch 2>&1
  Ok "本地已对齐 origin/$Base"
  Write-Host "    $(git log --oneline -1)"
} else {
  Write-Host "    ! fetch 未成功，本地保持在原状态（远端已更新，注意不要盲目 reset）" -ForegroundColor Yellow
}

Write-Host ""
Say "完成"
Write-Host "    提交 : $commit"
if (-not $NoMerge) { Write-Host "    PR   : #$prNum（已合并）" }
