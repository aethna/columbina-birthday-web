@echo off
chcp 65001 >nul
title 生日会会场 - 开发服务器

cd /d "%~dp0"

echo ============================================
echo   生日会会场 - 启动中
echo ============================================
echo.

REM 检查依赖是否装过
if not exist "node_modules" (
    echo [1/3] 首次运行，正在安装依赖，请稍候...
    echo       这可能需要一两分钟。
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo ❌ 依赖安装失败。请确认已安装 Node.js。
        echo.
        pause
        exit /b 1
    )
    echo.
) else (
    echo [1/3] 依赖已就绪
)

echo [2/3] 启动服务器...
echo.
echo ============================================
echo   启动完成后浏览器会自动打开
echo   如果没自动打开，请手动访问：
echo.
echo       http://localhost:5173/
echo.
echo   ⚠ 不要双击 html 文件打开，那样是黑屏
echo ============================================
echo.
echo   关闭这个窗口即可停止服务器
echo.

REM 启动 vite 并自动打开浏览器
call npx vite --port 5173 --open

echo.
echo 服务器已停止。
pause
