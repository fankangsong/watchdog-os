#!/bin/bash
# 网络挂载 sudo 辅助脚本 —— 由 server/api/mounts.js 经 `sudo -n <本脚本> <action> ...` 调用。
#
# 设计原则：sudoers 只白名单本脚本一个可执行文件，所有参数在此二次校验，
# 前端/后端都无法借 sudo 执行任意命令或把文件系统挂到 MOUNTS_DIR 之外。
#
# 用法：
#   mount-helper.sh mount smb   <mountpoint> //host/share <credFile> <domain> <username>
#   mount-helper.sh mount webdav <mountpoint> <url>        <credFile> <username>
#   mount-helper.sh umount <mountpoint>
#
# 凭据文件（credFile）由后端写入、600 权限，内容为纯密码文本：
#   - SMB：作为 mount.cifs 的 credentials 文件源，这里读取后转成 username/password 选项
#   - WebDAV：写入 davfs2 的 secrets 文件（/etc/davfs2/secrets，600）
#
# 安装：见 scripts/mount-helper.sudoers 与 docs/NETWORK_MOUNTS.md。

set -u

ACTION="${1:-}"
shift || true

# 挂载点父目录：与后端 MOUNTS_DIR 保持一致（默认 ~/.watchdog-os/mounts）。
# 服务以哪个用户运行，这里就取哪个用户的 HOME —— sudo 默认保留调用者 HOME。
MOUNTS_DIR="${MOUNTS_DIR:-${HOME}/.watchdog-os/mounts}"

log() { printf '[mount-helper] %s\n' "$1" >&2; }
die() { log "$1"; exit 1; }

# 校验挂载点必须是 MOUNTS_DIR 的直接子目录，且目录名是严格 slug。
# 杜绝把远程文件系统挂到 /etc、/ 等敏感位置（即便 sudoers 白名单只放本脚本也要防御）。
validate_mountpoint() {
  local mp="$1"
  case "$mp" in
    "$MOUNTS_DIR"/*) ;;
    *) die "refusing mountpoint outside $MOUNTS_DIR: $mp" ;;
  esac
  local base="${mp##*/}"
  case "$base" in
    ''|*[!A-Za-z0-9_-]*) die "invalid mountpoint id: $base" ;;
  esac
  # 只允许一层子目录（MOUNTS_DIR/<id>），不能有更深的路径
  case "${mp#"$MOUNTS_DIR"/}" in
    */*) die "mountpoint must be a direct child of $MOUNTS_DIR" ;;
  esac
}

read_cred() {
  local f="$1"
  [ -f "$f" ] || die "credential file missing"
  # 只取第一行、去掉结尾 CR/LF；密码本身可能含任意字符，故不 trim 内部空白
  head -n 1 "$f" | tr -d '\r\n'
}

do_mount_smb() {
  local mp="$1" unc="$2" cred="$3" domain="$4" username="$5"
  validate_mountpoint "$mp"
  case "$unc" in
    //*) ;;
    *) die "invalid SMB UNC: $unc" ;;
  esac
  [ -n "$username" ] || die "username required for SMB"
  local password
  password="$(read_cred "$cred")"

  mkdir -p "$mp" || die "cannot create mountpoint"
  local opts="username=${username},password=${password},vers=3.1.1,iocharset=utf8,uid=$(id -u),gid=$(id -g),file_mode=0660,dir_mode=0770,_netdev,nofail,soft,timeo=15,retrans=2"
  [ -n "$domain" ] && opts="${opts},domain=${domain}"
  mount -t cifs "$unc" "$mp" -o "$opts" || die "mount.cifs failed for $unc"
  log "mounted SMB $unc -> $mp"
}

do_mount_webdav() {
  local mp="$1" url="$2" cred="$3" username="$4"
  validate_mountpoint "$mp"
  case "$url" in
    http://*|https://*) ;;
    *) die "invalid WebDAV URL: $url" ;;
  esac
  [ -n "$username" ] || die "username required for WebDAV"
  local password
  password="$(read_cred "$cred")"

  # davfs2 只从固定 secrets 文件读凭据（/etc/davfs2/secrets，600）。
  # 按 mountpoint 去重追加一行 "<url> <user> <password>"。
  local secrets="/etc/davfs2/secrets"
  mkdir -p /etc/davfs2 || die "cannot create /etc/davfs2"
  [ -e "$secrets" ] || : > "$secrets"
  chmod 600 "$secrets" || die "cannot chmod $secrets"
  # 移除旧的同 mountpoint 行，再追加新行（用 mountpoint 作为第一列更稳定，
  # 因为 davfs2 允许 secrets 第一列是 URL 或挂载点；这里用 URL 以匹配服务端配置）
  grep -v -F -- "$url" "$secrets" > "${secrets}.tmp" || true
  printf '%s %s %s\n' "$url" "$username" "$password" >> "${secrets}.tmp"
  mv "${secrets}.tmp" "$secrets"
  chmod 600 "$secrets"

  mkdir -p "$mp" || die "cannot create mountpoint"
  # 允许普通用户改动挂载点内容（rw）；davfs2 的权限最终由 secrets 里的账号决定。
  mount -t davfs -o rw "$url" "$mp" || die "mount.davfs failed for $url"
  log "mounted WebDAV $url -> $mp"
}

do_umount() {
  local mp="$1"
  validate_mountpoint "$mp"
  # 先正常卸载，失败再 lazy 卸载（远端抖动时正常卸载常因 IO 阻塞失败）
  if ! umount "$mp" 2>/dev/null; then
    umount -l "$mp" 2>/dev/null || die "umount failed for $mp"
  fi
  log "unmounted $mp"
}

case "$ACTION" in
  mount)
    [ "$#" -ge 5 ] || die "mount: missing arguments"
    case "$1" in
      smb)    do_mount_smb   "$2" "$3" "$4" "$5" "${6:-}" ;;
      webdav) do_mount_webdav "$2" "$3" "$4" "${5:-}" ;;
      *)      die "unknown protocol: $1" ;;
    esac
    ;;
  umount)
    [ "$#" -ge 1 ] || die "umount: missing mountpoint"
    do_umount "$1"
    ;;
  *)
    die "unknown action: $ACTION"
    ;;
esac

exit 0
