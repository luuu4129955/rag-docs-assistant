#!/usr/bin/env bash
# 后端切到 Python 之后，用这个起本地开发环境。
#
#   ./scripts/dev.sh          # 或 pnpm dev:python
#
# 做的事就两件：先把 FastAPI 起在 8000，再起 Nuxt（它会按 .env 里的
# NUXT_PY_BACKEND_URL 把 /api/* 转发过去）。
# Ctrl-C 退出时会把后端一起收掉，不留孤儿进程。
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -x .venv/bin/uvicorn ]; then
  echo "缺少 Python 环境。先执行："
  echo "  python3.12 -m venv .venv"
  echo "  .venv/bin/pip install -r requirements-dev.txt"
  exit 1
fi

if [ -z "${NUXT_PY_BACKEND_URL:-}" ] && ! grep -q '^NUXT_PY_BACKEND_URL=' .env 2>/dev/null; then
  echo "提示：.env 里没有 NUXT_PY_BACKEND_URL，前端不会转发给 Python。"
fi

.venv/bin/uvicorn api.main:app --host 127.0.0.1 --port 8000 --reload &
BACKEND_PID=$!

# 不管怎么退出（Ctrl-C、报错、被 kill）都把后端收掉
trap 'kill "$BACKEND_PID" 2>/dev/null || true' EXIT INT TERM

echo "Python 后端已启动（pid=$BACKEND_PID，http://127.0.0.1:8000）"
pnpm dev
