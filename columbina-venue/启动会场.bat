@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 生日会会场 - 开发服务器

cd /d "%~dp0"

echo ============================================
echo   生日会会场 - 启动中
echo ============================================
echo.

REM =====================================================================
REM  ★ 定位 Node —— 优先用 DSH 自带的，其次才找系统 PATH
REM
REM  踩过的坑 1：这台机器上 node / npm / npx 都【不在 PATH 里】，
REM  只有 DSH 自带的运行时。以前直接 call npx vite 会瞬间闪退。
REM
REM  踩过的坑 2：DSH 的安装路径里带 "(x86)"。cmd 在【解析阶段】就会
REM  扫遍整个 if ( ... ) 括号块，遇到未加引号的 ")" 就当成块结束符，
REM  于是路径被截断，剩下 "\DeepSeek was unexpected at this time."。
REM
REM  所以：本文件的 set 赋值一律【放在括号块外面】，块内只引用变量。
REM  路径用双引号包住，括号就不会被误认。（8.3 短名 PROGRA~2 和
REM  %ProgramFiles(x86)% 在这台机器上都【不可用】，别再用它们。）
REM =====================================================================

set "NODE_EXE="
set "DSH_DEPS=D:\Program Files (x86)\DeepSeek Harness\resources\runtime\primary-runtime\dependencies"

if exist "%DSH_DEPS%\node\bin\node.exe" goto use_dsh_node

where node >nul 2>nul
if not errorlevel 1 goto use_path_node

goto no_node

:use_dsh_node
set "NODE_EXE=%DSH_DEPS%\node\bin\node.exe"
set "PATH=%DSH_DEPS%\node\bin;%PATH%"
echo [1/3] 使用 DSH 自带 Node
goto node_ok

:use_path_node
set "NODE_EXE=node"
echo [1/3] 使用系统 PATH 中的 Node
goto node_ok

:no_node
echo.
echo [错误] 找不到 Node.js。
echo.
echo    已尝试：
echo      1. DSH 自带  %DSH_DEPS%\node\bin\node.exe
echo      2. 系统 PATH 中的 node
echo.
echo    请安装 Node.js，或修正上面的 DSH 路径。
echo.
pause
exit /b 1

:node_ok

REM 依赖检查（根本不用 npm install：DSH 的 node_modules 里 vite/phaser/puppeteer 都装好了）
if not exist "node_modules\vite\bin\vite.js" goto no_deps
echo       依赖已就绪
goto deps_ok

:no_deps
echo.
echo [警告] 依赖不完整（缺少 node_modules\vite）。
echo    请先在本目录执行一次： pnpm install
echo    （pnpm 在 PATH 里，是 DSH 自带的 11.7.0）
echo.
pause
exit /b 1

:deps_ok

echo [2/3] 启动服务器...
echo.
echo ============================================
echo   启动完成后浏览器会自动打开
echo   如果没自动打开，请手动访问：
echo.
echo       首页        http://localhost:5173/
echo       会场游戏    http://localhost:5173/venue.html
echo.
echo   [注意] 不要双击 html 文件打开，那样是黑屏
echo ============================================
echo.
echo   关闭这个窗口即可停止服务器
echo.

REM 直接用 node 跑 vite.js，不经过 npx（npx 不在 PATH 里）
"%NODE_EXE%" "node_modules\vite\bin\vite.js" --port 5173 --strictPort --open

echo.
echo 服务器已停止。
pause
