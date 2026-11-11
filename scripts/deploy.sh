#!/bin/bash
# 部署：构建前端 + 重启服务
#
# 用法：
#   bash scripts/deploy.sh                    # 后台执行，命令立即返回
#   WD_FOREGROUND=1 bash scripts/deploy.sh    # 前台执行（需要盯实时输出时）
#   tail -f deploy.log                        # 跟踪后台进度（日志落在项目根目录）
#
# 后台化用 setsid + nohup + </dev/null：SSH 断开 / 终端关闭都不会把构建打断。

set -u

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"
DEPLOY_LOG="${DEPLOY_LOG:-$ROOT/deploy.log}"

# ---------- 父进程：把自己丢到后台后立即退出 ----------
if [ "${WD_DEPLOY_DAEMON:-0}" != "1" ] && [ "${WD_FOREGROUND:-0}" != "1" ]; then
  SETSID=""
  if command -v setsid >/dev/null 2>&1; then
    SETSID="setsid"
  fi

  WD_DEPLOY_DAEMON=1 $SETSID nohup bash "$SELF" "$@" </dev/null >>"$DEPLOY_LOG" 2>&1 &
  pid=$!

  echo "deploy 已在后台启动 (pid=$pid)"
  echo "日志  : $DEPLOY_LOG"
  echo "跟踪  : tail -f $DEPLOY_LOG"
  exit 0
fi

# ---------- 子进程：真正的构建与重启 ----------
set -e
cd "$ROOT"

echo "=== deploy start: $(date '+%F %T') ==="
git pull --ff-only
npm run build
bash run.sh restart
echo "=== deploy done : $(date '+%F %T') ==="
