#!/usr/bin/env bash
# OwnChat 本机服务（方案 C）—— 与 start-local.cmd 等价。用法：bash start-local.sh
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "[需要 Node.js 18+] 请先安装：https://nodejs.org/zh-cn  （装完重新运行）"
  exit 1
fi
if [ ! -f .dev.vars ]; then
  if [ -f .dev.vars.example ]; then
    cp .dev.vars.example .dev.vars
    echo "已生成 .dev.vars —— 请填上 NVIDIA_API_KEY= 后重新运行：${PWD}/.dev.vars"
    exit 0
  fi
  echo "缺少 .dev.vars.example"; exit 1
fi
echo "服务地址将是 http://127.0.0.1:8787 （Ctrl-C 停止）"
echo "桌面壳里填这个地址，或点启动页的「填入本机地址」按钮。"
exec npx --yes wrangler dev --port 8787
