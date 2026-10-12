@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 22 或以上版本，再重新打开此文件。
  pause
  exit /b 1
)
echo 启动成功后，在浏览器打开 http://127.0.0.1:3000
node "参考答案/server.mjs"
pause

