@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo ============================================
echo  OwnChat local host - no Cloudflare, no domain
echo ============================================
node -e "process.exit(Number(process.versions.node.split('.')[0])>=24?0:1)" >nul 2>nul
if errorlevel 1 (
  echo [需要 Node.js 24+] 未检测到可用的 Node 24。正在打开下载页，装完重新双击本脚本。
  start "" https://nodejs.org/zh-cn
  pause
  exit /b 1
)
if not exist ".dev.vars" (
  if exist ".dev.vars.example" (
    copy /y ".dev.vars.example" ".dev.vars" >nul
    echo 已生成 .dev.vars —— 请在记事本里把模型 Key 填上（保存并关闭记事本后脚本会继续）。
    start /wait notepad ".dev.vars"
  )
)
echo.
echo 本机宿主：http://127.0.0.1:8787  （关掉本窗口即停止）
echo 首次启动会生成 admin-password.txt，路径在下面的日志里；用它登录。
echo.
node server/local.mjs --port 8787
pause
