#!/usr/bin/env bash
# run.sh - srv-dashboard 服务管理脚本
# 用法: ./run.sh {start|restart|stop|status}

SERVICE=srv-dashboard

usage() {
  echo "用法: $0 {start|restart|stop|status}"
  echo "  start   - 启动服务并设为开机自启"
  echo "  restart - 重启服务"
  echo "  stop    - 停止服务"
  echo "  status  - 查看服务状态"
  exit 1
}

cmd="${1:-}"
case "$cmd" in
  start)
    systemctl enable --now "$SERVICE"
    systemctl is-active "$SERVICE" --quiet && echo "[OK] $SERVICE 已启动" || echo "[FAIL] $SERVICE 启动失败"
    ;;
  restart)
    systemctl restart "$SERVICE"
    systemctl is-active "$SERVICE" --quiet && echo "[OK] $SERVICE 已重启" || echo "[FAIL] $SERVICE 重启失败"
    ;;
  stop)
    systemctl stop "$SERVICE"
    systemctl is-active "$SERVICE" --quiet || echo "[OK] $SERVICE 已停止"
    ;;
  status)
    systemctl status "$SERVICE" --no-pager -l || true
    ;;
  *)
    usage
    ;;
esac
