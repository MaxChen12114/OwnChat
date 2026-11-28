#!/usr/bin/env bash
# OwnChat local host - no Cloudflare, no domain. Usage: bash start-local.sh
set -e
cd "$(dirname "$0")"
major=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
if [ "$major" -lt 24 ]; then
  echo "[需要 Node.js 24+] 请先安装：https://nodejs.org/zh-cn"
  exit 1
fi
if [ ! -f .dev.vars ] && [ -f .dev.vars.example ]; then
  cp .dev.vars.example .dev.vars
  echo "已生成 .dev.vars —— 请填入模型 Key 后重新运行。"
  exit 0
fi
echo "本机宿主：http://127.0.0.1:8787 （Ctrl-C 停止）"
echo "首次启动会生成 admin-password.txt，路径在下面的日志里；用它登录。"
exec node server/local.mjs --port 8787
