@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo ============================================
echo  OwnChat local server (Plan C) - no domain needed
echo ============================================
where node >nul 2>nul
if errorlevel 1 (
  echo [需要 Node.js 18+] 未检测到 Node.js，正在打开下载页，装完重新双击本脚本。
  start "" https://nodejs.org/zh-cn
  pause
  exit /b 1
)
if not exist ".dev.vars" (
  if exist ".dev.vars.example" (
    copy /y ".dev.vars.example" ".dev.vars" >nul
    echo 已生成 .dev.vars —— 请在记事本里把 NVIDIA_API_KEY= 填上（保存并关闭记事本后脚本会继续）。
    start /wait notepad ".dev.vars"
  ) else (
    echo 缺少 .dev.vars.example，无法生成配置。
    pause
    exit /b 1
  )
)
echo.
echo 服务地址将是 http://127.0.0.1:8787  （关掉本窗口即停止服务）
echo 桌面壳里填这个地址，或点启动页的「填入本机地址」按钮。
echo.
npx --yes wrangler dev --port 8787
pause
