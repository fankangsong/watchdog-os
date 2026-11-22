# Files 网络挂载（SMB / WebDAV）

Files 侧栏的 **Network** 分区可管理远程共享：把 SMB/CIFS 或 WebDAV 目录挂载到本机后，
它们就是普通本地目录，Files 的浏览、上传、预览、编辑、压缩解压全部天然可用——前端完全
不需要知道它是远程的。

## 工作原理

```
Files Network 面板 ──HTTP──> /api/mounts/* ──sudo -n──> scripts/mount-helper.sh ──> mount -t cifs / davfs
                                    │
                                    └─> 挂载点 <MOUNTS_DIR>/<id> 并入 FS_ROOTS，Files 用 node:fs 直接读写
```

- 连接配置（不含密码）存 `~/.watchdog-os/data.json` 的 `mounts` 键；密码单独存
  `~/.watchdog-os/mount-creds/<id>.cred`（600，仅服务用户与 root 可读），任何 API 响应都不回传密码。
- 挂载动作经 `sudo -n mount-helper.sh` 提权；sudoers 只白名单这一个脚本，脚本内部再校验
  挂载点必须在 `<MOUNTS_DIR>/<id>`、协议与 UNC/URL 合法，杜绝借提权挂任意目录。
- 能力探测 `/api/mounts/caps` 只读，不需 sudo；挂载状态读 `/proc/mounts`，网络断开导致的
  掉线会被 8 秒轮询发现。

## 部署（Linux）

以 root 在服务器上执行：

```bash
# 1. 安装系统挂载工具
sudo apt-get install -y cifs-utils davfs2      # Debian/Ubuntu
# sudo dnf install -y cifs-utils davfs2        # RHEL/Fedora

# 2. 安装 sudoers 白名单（见 scripts/mount-helper.sudoers 顶部说明）
sudo chown root:root /path/to/watchdog-os/scripts/mount-helper.sh
sudo chmod 755 /path/to/watchdog-os/scripts/mount-helper.sh
sudo visudo -f /etc/sudoers.d/watchdog-os-mounts
# 写入一行：<service-user> ALL=(root) NOPASSWD: <abs-path>/scripts/mount-helper.sh

# 3. 验证（以服务用户执行，应秒回且不再要密码）
sudo -u <service-user> sudo -n /abs/path/scripts/mount-helper.sh
```

在 `.env` 中可配置：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MOUNTS_DIR` | `~/.watchdog-os/mounts` | 挂载父目录，每个连接挂到其下的 `<id>` 子目录 |
| `MOUNTS_AUTO_MOUNT` | `true` | 启动时恢复标记为 autoMount 的连接 |
| `MOUNTS_TIMEOUT_MS` | `30000` | 单次 mount/umount 命令超时 |

`MOUNTS_DIR` 会自动并入 `FS_ROOTS` 白名单，无需在 `FS_ROOTS` 里重复写。若你的 `FS_ROOTS`
是自定义值，也不影响——挂载父目录是独立加入的。

> 服务以哪个用户运行，`MOUNTS_DIR` 就默认取该用户 home 下的路径。`scripts/mount-helper.sh`
> 通过 `HOME` 解析同一路径（sudo 默认保留调用者 HOME）。若服务以 root 运行，则两者都是 `/root/.watchdog-os/mounts`。

## 使用

1. 打开 Files → 侧栏 **Network** → **+ New Network Location…**
2. 选择协议：
   - **SMB / CIFS**：填 Server（主机名或 IP）、Share、可选 Domain、用户名、密码
   - **WebDAV**：填完整 URL（`http(s)://...`，不要在 URL 里带账号密码）、用户名、密码
3. 勾选 "Mount at startup" 可让该连接开机自动挂载。
4. 保存后，点击侧栏里的连接名：未挂载则自动挂载，已挂载则进入远程目录。
   右键连接可 Mount / Unmount / Edit / Delete。
5. 根列表里也会出现每个已挂载连接的磁盘条目，双击即可进入。

## 常见问题

- **侧栏显示 "Mount unavailable: ..."**：`/api/mounts/caps` 的 `missing` 列出了缺少的项。
  常见为未装 `cifs-utils`/`davfs2`、sudoers 未配置、helper 不可执行。逐项补齐后刷新页面。
- **挂载失败，提示 `mount.cifs failed` / `Permission denied`**：多为凭据错误、SMB 版本不匹配
  （脚本默认 `vers=3.1.1`，老服务器可在编辑里确认账号）、或服务端未开启 SMB3。
- **WebDAV 中文 / 特殊字符密码异常**：密码写在独立凭据文件，脚本按第一行原样读取，避免 shell
  转义问题；若仍失败，检查 davfs2 版本与服务器兼容性。
- **卸载失败**：脚本会先正常 `umount`，失败再 `umount -l`（lazy）。若远程不可达导致 IO 阻塞，
  lazy 卸载会立即返回，待连接恢复后真正释放。
- **服务重启后挂载消失**：勾选了 autoMount 的连接会在启动时恢复；未勾选的需手动点击挂载。
  这符合"不擅自访问远程"的默认安全策略。
- **Windows 开发机**：原生挂载仅 Linux 支持。Windows/macOS 下能力探测会明确报告不支持，
  连接配置仍可正常增删改查（便于导出配置），只是无法真正挂载。

## 安全说明

- 前端已登录用户无法借本接口提权：所有 mount/umount 都经 sudoers 白名单脚本，脚本内部
  对挂载点前缀、目录名、协议、UNC/URL、凭据来源做二次校验，全部参数用 `execFile` 传数组
  （无 shell 字符串拼接）。
- 密码不进 `data.json`、不进日志、不回传前端；仅存在于 600 权限的凭据文件与 davfs2 secrets。
- 连接名与协议展示在侧栏，但 host/share/url 只在 tooltip 里显示，便于辨识且不误暴露凭据。
