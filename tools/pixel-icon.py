#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
像素图标生成器 —— 按 skills/pixelart 技能的 ≤48px 规范工作。

流程：语义调色板 + 32x32 字符网格 -> 贪心最大同色矩形合并 -> 单色 <path> SVG
      同时输出 8x PNG 预览（含棋盘格透明底），用于自检迭代。

产物：
  src/assets/icons/terminal.svg   32x32, viewBox="0 0 32 32", crispEdges, 仅 <path>
  src/assets/icons/chat.svg       同上
  src/assets/icons/docker.svg     同上
  src/assets/icons/runner.svg     同上（窗口 + 绿色圆形播放徽章 + 日志行 + 进度条）
  src/assets/icons/blog.svg       同上（窗口 + 白纸文本行 + 铅笔）
  src/assets/icons/audit.svg      同上（窗口 + 日志纸 + 结果标记 + 放大镜）
  src/assets/icons/disk.svg       同上（窗口 + 大圆形存储盘 + 环形容量弧 + 中心主轴）
  src/assets/icons/converter.svg  同上（无外框，参考 Chat：蓝 → / 琥珀 ← 两个大箭头前后叠放）
  src/assets/icons/files.svg      同上（无外框，参考 macOS 经典打开文件夹：橙黄 tab + 浅黄大圆角面板）
  src/assets/icons/editor.svg     同上（无外框，参考 Chat：深蓝后本 + 琥珀前本前后叠放）
  src/assets/icons/watchdog.svg   同上（独立 8 齿钢灰齿轮 + 中心绿运行灯；登录页/手机首页复用）
  src/assets/icons/fm-back.svg    16x16, viewBox="0 0 16 16"（窗口操作按钮带内嵌图标）
  src/assets/icons/fm-up.svg      同上
  src/assets/icons/fm-fav.svg     同上
  tools/preview/*.png             预览（非交付物，可删）
  tools/files-icon-redesign.html  Files 图标设计稿（新/旧网格对照，自包含，随脚本重生成）
  tools/icons-redesign.html       5 应用图标集设计稿（新/旧 32px + 16px 对照，同上）

重设计记录（2026-11-09）：
  Files —— 旧版「平蓝板 + 两条孤立横纹 + 4 行白纸」在 16px 缩略下糊成带黑点的
     蓝抽屉。新版回到一整块经典文件夹：靠 tab 缺口认形、靠整圈浮雕高光/暗边
     交代立体、折痕用亮暗成对（缩略后并回蓝面）。中途试过「后片 + 白纸 + 前片」
     三层，白纸把蓝色切成左右两块、16px 下只剩三条蓝横杠，已否决。
  Editor / WatchDog OS —— 原本用 classicy 内置图标（simpletext / systemProfiler），
     与自绘像素体系不统一；改为自绘，并让登录页品牌图标复用 watchdog.svg。
  Converter / Runner / Disks —— 旧网格语义偏弱（两张一样的照片 / 裸三角 / 单盘），
     重做主体。三者旧网格分别保留为 build_*_legacy() 供对照与一键回滚。
  第三轮（同日，用户指定具象符号风格）—— WatchDog OS 齿轮 / Editor 笔记本封面 /
     Converter 字母 / Disks 存储盘，Runner 与 Files 保持不动：
       · watchdog 改为独立齿轮主体，不套窗口（主应用 + 登录页/手机首页小尺寸 logo
         要占满画布才读得出；chat / docker 已有独立主体先例）。
       · converter 的 HEIC / JPG 用 SKILL.md 的 3×5 像素字体逐字照抄，禁止近似。
       · 上一轮 4 个网格保留为 build_{editor,converter,disk,watchdog}_v2()，
         设计稿的「旧版」对照即指向它们；最初的 *_legacy() 仍可回滚。
  第四轮（同日，Converter 单点）—— 用户要求「交换箭头」创意：字母版保留为
     build_converter_v3()，新版用上琥珀 → / 下蓝色 ← 两条镜像立体粗箭头，尾部各挂
     一个 4x4 格式块。踩坑：outline 会把两条箭头中间的 2px 缝也补成深色，⇄ 糊成
     一整块，故只用 bevel 不上外框。
  第五轮（同日，Converter 单点）—— 用户要求「参考 Chat，去掉外边框，2 个大箭头
     相互交换」：带窗口外框的平行箭头版保留为 build_converter_v4()，新版改成
     build_chat() 式前后叠放：无窗口、透明底，后箭头蓝 → 偏左上 / 前箭头琥珀 ←
     偏右下，由同一 14 行轮廓水平镜像 + 下移 8 行生成。这里与第四轮相反，
     **必须用 outline** —— 前层的整圈深色描边正是把自己从后层「切」出来的层次线。
  第六轮（同日，Editor 单点）—— 用户「参考这个风格」= 第五轮 Converter 的 Chat 式
     无外框叠放。带窗口的单本封面版保留为 build_editor_v3()，新版改成后本深蓝偏
     左上（x2..21 / y2..18）/ 前本琥珀偏右下（x10..29 / y10..26）、重叠 10 行。
     实现要点：前层先铺一圈**实心 K 描边框**（x9..30 / y9..27）再铺封面内容，
     两层才不会在同一处糊成一片。
  第七轮（同日，Files 单点）—— 用户「去掉外边框，保留文件夹样式即可」：带窗口
     版保留为 build_files_windowed()，新版只做减法，文件夹放大到占满画布
     （tab x4..14 / y4..9，主体 x2..29 / y9..27），tab 凸角 / bevel 浮雕 /
     N 外框 / 亮暗成对折痕一律保留；outline 顺带勾出的 tab 右缘与主体顶边正好
     是经典文件夹缺口。至此 watchdog / converter / editor / files 四个独立主体，
     两份设计稿（Files 专用稿 + 图标集总览）都补上了本轮新/旧对照。
  第八轮（同日，Files 单点）—— 用户「文件夹改成被打开的样子」：闭合独立大文件夹
     版保留为 build_files_closed()，新版拆成两层：后片 tab + 立着的背板压暗成
     m/N 留在敞口阴影里（刻意比前片窄），前片是 y15 起上窄下宽
     （x9..22 / 14px → x2..29 / 28px）的梯形盖（亮蓝 b + h 高光 / m 暗部），
     盖住后片下部。靠明度差 + 梯形斜边 + outline 勾出的敞口横线交代「打开」。
     两处迭代：① 第一版梯形只扩 6px，读作上下两个方块；② 后片与前片等宽时
     16px 缩略仍糊成上下两色块，把后片收窄到 20px 后才留住「上窄下宽」。
     仍不放白纸（第一轮三层方案在 26×19 小内容区会把蓝块切碎，虽已换成大
     画布也不重踩）。两份设计稿对照改为「打开 vs 闭合」。
  第九轮（同日，Files 单点）—— 用户给参考图（macOS 经典打开文件夹）：蓝色
     梯形打开版保留为 build_files_open_blue()，新版改成小圆角橙黄 tab 在后
     （x2..16 / y3..13，下部被盖住只露 y3..7）+ 大圆角浅黄渐变面板在前
     （x1..30 / y8..29，占约 80%），顶部 W 高光敞口线、底部 y→Y 逐行压深，
     外框用暖色 o 不用 K/N 硬黑边。调色板新增 J (#ffc233) / V (#ffeaa8)。
     ⚠️ 桌面语义由「蓝 = Files」变为「暖黄 = Files」；与 Editor 琥珀笔记本靠
     形状区分（纯色块 + 圆角 vs 书脊 / 绑带 / 书签带）。两份设计稿对照改为
     「参考图风格 vs 蓝梯形打开版」。

统一可读性约定：关键元素 ≥2px、对齐偶数坐标，保证 2×2 多数票降采样到 16px 后
仍是清晰色块；1px 细节只允许作为 32px 专属（如旧的 watchdog 点状网格）。
禁用 <text>/<font>：所有字形与箭头一律像素网格，不是字体。

约束（docs/design-spec.md 7.4）：
  - 32 档：viewBox 0 0 32 32，与 classicy 内置桌面/标题栏图标同档（实测 32x32 PNG）
  - 16 档：viewBox 0 0 16 16，工具栏图标档（按钮内嵌图标 1:1 渲染，见 icon-pipeline.md §1.2）
  - 禁用 <text>/<font>，字符一律 <path>
  - 靠浮雕高光（顶/左）与暗边（下/右）做 Mac OS 9 的 3D 感，不加投影
  - 体积 < 4 KB，便于 Vite 内联为 data URI

零依赖：PNG 编码器用标准库 zlib + struct 手写。
"""

import math
import os
import re
import struct
import sys
import zlib

W = H = 32


def set_size(n):
    """切换网格尺寸：32 = 桌面/标题栏档；16 = 工具栏按钮内嵌图标档（icon-pipeline.md §1.2）。

    所有绘制/输出函数均在调用时读取全局 W/H，故构建前调用一次即可。
    """
    global W, H
    W = H = n
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON_DIR = os.path.join(ROOT, 'src', 'assets', 'icons')
PREVIEW_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'preview')

# ---------------------------------------------------------------- 调色板
# 沿用现有 terminal.svg / chat.svg 的取色，保证换图后桌面整体色调不跳。
PALETTE = {
    '.': None,          # 透明
    # --- 终端 ---
    'K': '#3a3a44',     # 窗口描边（Platinum 黑边）
    'D': '#6f6f7c',     # 暗边
    'M': '#a0a0ab',     # 中间调
    'L': '#d8d8de',     # 面板基色
    'W': '#ffffff',     # 高光（光源：左上）
    'S': '#282830',     # 屏幕外圈
    'B': '#111116',     # 屏幕底色
    'T': '#f6f6f8',     # 终端文字
    # --- 对话 ---
    'O': '#2b2b33',     # 前气泡描边
    'N': '#1b3d72',     # 后气泡描边
    'h': '#a8cff5',     # 蓝高光
    'b': '#4a86d8',     # 蓝基色
    'm': '#2a62b2',     # 蓝暗部
    'w': '#f4f4f8',     # 白气泡基色
    'd': '#dcdde7',     # 白气泡暗部
    'g': '#71717f',     # 灰文本线
    # --- Runner（播放键，绿）---
    'G': '#2c6e31',     # 播放键暗部
    'P': '#46a049',     # 播放键基色
    'p': '#7cc47f',     # 播放键高光
    # --- Blog（铅笔：橡皮高光/橡皮/杆身高光/基色/暗部/木杆/木杆暗部）---
    'e': '#d98a8a',     # 橡皮高光
    'E': '#c46a6a',     # 橡皮
    'y': '#f2d488',     # 铅笔杆高光
    'Y': '#e8b84b',     # 铅笔杆基色
    'o': '#c09434',     # 铅笔杆暗部
    'A': '#d8a878',     # 木杆
    'a': '#b08050',     # 木杆暗部
    # --- Audit（登录审计：成功点复用 Runner 的 P 绿，失败点用红）---
    'r': '#cf3b2f',     # 失败标记（登录失败的行首小方块）
    # --- Files（参考图：macOS 经典打开文件夹的暖黄渐变）---
    'J': '#ffc233',     # tab 橙黄基色（比 Y 更亮、更贴参考图）
    'V': '#ffeaa8',     # 前片顶部浅黄高光
    # 前片主体用 y (#f2d488)，底部渐变压回 Y / o，外框用 o（暖色，不用 K 硬黑边）
    # --- 按钮内嵌图标（16 档工具栏字形，双色：N 深蓝描边 + b 蓝面）---
    'C': 'currentColor',  # 跟随宿主元素文字色（本组图标不用它，保留给将来的单色字形）
    # 本组取 'N' + 'b'（与对话气泡同一支蓝）：固定色，不随按钮文字变化。
    # 白面不可行——工具栏按钮启用态背景就是白色，白面会与底色融合成一色；
    # 固定色带来的三态缺口由 styles.css 的 filter 补（按下反白 / 禁用压灰）。
}

# 换算成 RGB
RGB = {}
for _k, _v in PALETTE.items():
    if _v is None:
        RGB[_k] = (0, 0, 0, 0)
    elif _v == 'currentColor':
        RGB[_k] = (0, 0, 0, 255)   # 预览按黑色画；真实颜色由浏览器上下文决定
    else:
        RGB[_k] = (int(_v[1:3], 16), int(_v[3:5], 16), int(_v[5:7], 16), 255)


# ---------------------------------------------------------------- 网格工具
def blank():
    return [['.'] * W for _ in range(H)]


def fill(g, x, y, w, h, c):
    for j in range(y, y + h):
        if not (0 <= j < H):
            continue
        for i in range(x, x + w):
            if 0 <= i < W:
                g[j][i] = c


def hline(g, x, y, w, c):
    fill(g, x, y, w, 1, c)


def vline(g, x, y, h, c):
    fill(g, x, y, 1, h, c)


def roundbox(g, x, y, w, h, c, r=2):
    """填充圆角（切角）矩形。"""
    fill(g, x, y, w, h, c)
    for k in range(r):
        for i in range(r - k):
            for (yy, xx) in ((y + i, x + k - i), (y + i, x + w - 1 - k + i),
                             (y + h - 1 - i, x + k - i), (y + h - 1 - i, x + w - 1 - k + i)):
                if 0 <= yy < H and 0 <= xx < W:
                    g[yy][xx] = '.'


def blit(g, rows, x, y):
    for j, row in enumerate(rows):
        for i, c in enumerate(row):
            if 0 <= y + j < H and 0 <= x + i < W and c != '.':
                g[y + j][x + i] = c
    return g


# ---------------------------------------------------------------- 剪影工具
def sil_rect(sil, x0, y0, x1, y1):
    """把 [x0..x1] x [y0..y1]（闭区间）标进剪影。"""
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            if 0 <= x < W and 0 <= y < H:
                sil[y][x] = True


def bevel(g, sil, base, hi, lo):
    """按左上光源给剪影上色：顶/左 -> hi，底/右 -> lo，内部 -> base。"""
    for y in range(H):
        for x in range(W):
            if not sil[y][x]:
                continue
            up = y > 0 and sil[y - 1][x]
            down = y < H - 1 and sil[y + 1][x]
            left = x > 0 and sil[y][x - 1]
            if not up or not left:
                g[y][x] = hi
            elif not down or (x < W - 1 and not sil[y][x + 1]):
                g[y][x] = lo
            else:
                g[y][x] = base


def outline(g, sil, c):
    """给剪影描 1px 外框（4 邻域在剪影内即描）。"""
    for y in range(H):
        for x in range(W):
            if sil[y][x]:
                continue
            if ((y > 0 and sil[y - 1][x]) or (y < H - 1 and sil[y + 1][x]) or
                    (x > 0 and sil[y][x - 1]) or (x < W - 1 and sil[y][x + 1])):
                g[y][x] = c


def face(g, edge='C', fill='W', thickness=1, min_area=3, core=None):
    """双色上色：剪影（非 '.' 像素）外侧 thickness 圈刷 edge，更内部刷 fill。

    16 档工具栏图标走这条路：先按纯剪影画（全 'K'），再统一换成双色观感
    （icon-pipeline.md §1.2）。厚度用 4 邻域 BFS 距离变换算，因此最细处
    （1~2px 的臂、尖角）自然保持实心，不会出现 1px 白点把形状打碎。
    剪影里写 'X' 的像素强制保持描边色，用于「这里必须实心」的细部（如星腿）。

    core=(x0, y0, x1, y1) 只允许该闭区间内出面，用于把双色收进图形中央，
    避免尖角/横臂末端出现零碎小灰点；min_area 再把小块并回描边色。
    """
    sil = [[c != '.' for c in row] for row in g]
    force = [[c == 'X' for c in row] for row in g]
    dist = [[0] * W for _ in range(H)]
    frontier = []
    for y in range(H):
        for x in range(W):
            if sil[y][x] and any(not (0 <= i < W and 0 <= j < H) or not sil[j][i]
                                 for i, j in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1))):
                dist[y][x] = 1
                frontier.append((x, y))
    d = 1
    while d < thickness and frontier:
        nxt = []
        for (x, y) in frontier:
            for i, j in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if 0 <= i < W and 0 <= j < H and sil[j][i] and dist[j][i] == 0:
                    dist[j][i] = d + 1
                    nxt.append((i, j))
        frontier = nxt
        d += 1
    for y in range(H):
        for x in range(W):
            if sil[y][x]:
                solid = force[y][x] or 1 <= dist[y][x] <= thickness
                if not solid and core and not (core[0] <= x <= core[2] and core[1] <= y <= core[3]):
                    solid = True
                g[y][x] = edge if solid else fill

    seen = [[False] * W for _ in range(H)]
    for y in range(H):
        for x in range(W):
            if g[y][x] != fill or seen[y][x]:
                continue
            blob, stack = [], [(x, y)]
            seen[y][x] = True
            while stack:
                cx, cy = stack.pop()
                blob.append((cx, cy))
                for i, j in ((cx - 1, cy), (cx + 1, cy), (cx, cy - 1), (cx, cy + 1)):
                    if 0 <= i < W and 0 <= j < H and not seen[j][i] and g[j][i] == fill:
                        seen[j][i] = True
                        stack.append((i, j))
            if len(blob) < min_area:
                for (cx, cy) in blob:
                    g[cy][cx] = edge
    return g


# ---------------------------------------------------------------- 图形
def build_terminal():
    """Mac OS 9 终端窗口：条纹标题栏 + 深色屏幕 + '>' 提示符与光标。"""
    g = blank()

    # 窗口外框 x2..x29 / y2..y29
    fill(g, 2, 2, 28, 28, 'L')
    hline(g, 2, 2, 28, 'K')
    hline(g, 2, 29, 28, 'K')
    vline(g, 2, 2, 28, 'K')
    vline(g, 29, 2, 28, 'K')

    # 标题栏 y3..y8：顶高光 -> 基色(+短横) -> 条纹 -> 基色 -> 底暗边
    fill(g, 3, 3, 26, 6, 'L')
    fill(g, 3, 3, 26, 1, 'W')
    fill(g, 3, 5, 26, 1, 'M')
    fill(g, 3, 8, 26, 1, 'D')
    fill(g, 13, 4, 5, 1, 'M')          # 标题居中短横

    # 内容区：右侧与底部压暗边（光源左上）
    fill(g, 3, 9, 26, 19, 'L')
    fill(g, 28, 9, 1, 19, 'M')
    fill(g, 3, 27, 26, 1, 'M')
    fill(g, 3, 28, 26, 1, 'D')
    fill(g, 28, 26, 1, 2, 'D')

    # 屏幕 x4..x27 / y10..y25
    fill(g, 4, 10, 24, 16, 'B')
    hline(g, 4, 10, 24, 'S')
    hline(g, 4, 25, 24, 'S')
    vline(g, 4, 10, 16, 'S')
    vline(g, 27, 10, 16, 'S')

    # 提示符 '>' 5x7 @ (7,13)
    blit(g, ['T....',
             '.T...',
             '..T..',
             '...T.',
             '..T..',
             '.T...',
             'T....'], 7, 13)
    # 光标 4x1
    fill(g, 13, 18, 4, 1, 'T')
    return g


def build_chat():
    """双气泡对话：后蓝气泡 + 前白气泡（带尾）。"""
    g = blank()

    # 后气泡（蓝）x2..x19 / y3..y16
    roundbox(g, 2, 3, 18, 14, 'N', r=1)
    fill(g, 3, 4, 16, 12, 'b')
    fill(g, 4, 4, 14, 1, 'h')          # 顶高光
    fill(g, 4, 15, 14, 1, 'm')         # 底暗部
    fill(g, 6, 8, 9, 1, 'W')           # 白文本线
    fill(g, 6, 11, 6, 1, 'W')

    # 前气泡（白）x11..x29 / y13..y26
    roundbox(g, 11, 13, 19, 14, 'O', r=1)
    fill(g, 12, 14, 17, 12, 'w')
    fill(g, 13, 14, 15, 1, 'W')        # 顶高光
    fill(g, 13, 25, 15, 1, 'd')        # 底暗部
    fill(g, 15, 18, 10, 1, 'g')        # 灰文本线
    fill(g, 15, 21, 6, 1, 'g')

    # 气泡尾（指向左下）
    fill(g, 11, 27, 1, 1, 'O')
    fill(g, 12, 27, 3, 1, 'w')
    fill(g, 12, 28, 2, 1, 'w')
    return g


def build_docker():
    """Docker：蓝鲸驮三只白色集装箱（对齐 Docker Logo 构图）。"""
    g = blank()

    # 鲸体剪影（头左尾右，尾鳍上扬）：y13..y22 为主体，y10..y17 右侧为尾鳍
    sil = [[False] * W for _ in range(H)]
    sil_rect(sil, 5, 13, 24, 13)      # 背（右上接尾柄）
    sil_rect(sil, 4, 14, 23, 14)
    sil_rect(sil, 4, 15, 23, 15)
    sil_rect(sil, 3, 16, 23, 16)      # 头部前缘最左
    sil_rect(sil, 3, 17, 23, 17)
    sil_rect(sil, 3, 18, 22, 18)
    sil_rect(sil, 3, 19, 22, 19)
    sil_rect(sil, 4, 20, 21, 20)
    sil_rect(sil, 5, 21, 20, 21)
    sil_rect(sil, 7, 22, 18, 22)      # 腹部底线
    sil_rect(sil, 23, 10, 26, 10)     # 上尾鳍
    sil_rect(sil, 22, 11, 26, 12)
    sil_rect(sil, 22, 15, 26, 15)     # 下尾鳍
    sil_rect(sil, 22, 16, 25, 16)
    sil_rect(sil, 23, 17, 25, 17)

    # 立体色（顶/左 h，底/右 m，内部 b）+ 深蓝外框 N
    bevel(g, sil, 'b', 'h', 'm')
    outline(g, sil, 'N')
    # 眼睛 1px（白）
    g[16][5] = 'T'

    # 三只集装箱 5x4 @ y9..y12：顶高光 W、中 w、底暗 d（盖在鲸背轮廓上）
    for x0 in (5, 11, 17):
        fill(g, x0, 9, 5, 1, 'W')
        fill(g, x0, 10, 5, 2, 'w')
        fill(g, x0, 12, 5, 1, 'd')
    return g


def build_runner_legacy():
    """【旧版，保留作设计稿对照 / 一键回滚】Runner：窗口 + 绿三角 + 日志行。"""
    g = blank()

    # 窗口外框（与 terminal 同构，保持桌面观感统一）x2..x29 / y2..y29
    fill(g, 2, 2, 28, 28, 'L')
    hline(g, 2, 2, 28, 'K')
    hline(g, 2, 29, 28, 'K')
    vline(g, 2, 2, 28, 'K')
    vline(g, 29, 2, 28, 'K')

    # 标题栏 y3..y8
    fill(g, 3, 3, 26, 6, 'L')
    fill(g, 3, 3, 26, 1, 'W')
    fill(g, 3, 5, 26, 1, 'M')
    fill(g, 3, 8, 26, 1, 'D')
    fill(g, 13, 4, 5, 1, 'M')          # 标题居中短横

    # 内容区：右侧与底部压暗边（光源左上）
    fill(g, 3, 9, 26, 19, 'L')
    fill(g, 28, 9, 1, 19, 'M')
    fill(g, 3, 27, 26, 1, 'M')
    fill(g, 3, 28, 26, 1, 'D')
    fill(g, 28, 26, 1, 2, 'D')

    # 播放三角（左尖右宽）x13..x18 / y11..y21
    sil = [[False] * W for _ in range(H)]
    for i, w in enumerate((1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1)):
        sil_rect(sil, 13, 11 + i, 12 + w, 11 + i)
    bevel(g, sil, 'P', 'p', 'G')

    # 日志行（灰，递减宽度，像被截断的输出）
    hline(g, 11, 23, 12, 'g')
    hline(g, 11, 25, 8, 'g')
    return g


def build_blog():
    """Blog：Mac OS 9 窗口 + 白纸文本行 + 斜放铅笔（橡皮右上、尖左下）。

    与 terminal/runner 同构的窗口外框保证桌面观感统一；纸面承接灰色文本行，
    铅笔后画盖在纸面上——「写」即博客。铅笔 3px 宽、左上光源：每行
    高光 y / 基色 Y / 暗部 o，木杆 A/a，笔尖收为 2px K。
    """
    g = blank()

    # 窗口外框 x2..x29 / y2..y29（与 terminal/runner 同构，保持桌面观感统一）
    fill(g, 2, 2, 28, 28, 'L')
    hline(g, 2, 2, 28, 'K')
    hline(g, 2, 29, 28, 'K')
    vline(g, 2, 2, 28, 'K')
    vline(g, 29, 2, 28, 'K')

    # 标题栏 y3..y8：顶高光 -> 基色(+标题短横) -> 条纹 -> 底暗边
    fill(g, 3, 3, 26, 6, 'L')
    fill(g, 3, 3, 26, 1, 'W')
    fill(g, 3, 5, 26, 1, 'M')
    fill(g, 3, 8, 26, 1, 'D')
    fill(g, 13, 4, 5, 1, 'M')          # 标题居中短横

    # 内容区：右侧与底部压暗边（光源左上）
    fill(g, 3, 9, 26, 19, 'L')
    fill(g, 28, 9, 1, 19, 'M')
    fill(g, 3, 27, 26, 1, 'M')
    fill(g, 3, 28, 26, 1, 'D')
    fill(g, 28, 26, 1, 2, 'D')

    # 白纸 x4..x19 / y11..y23：底/右压暗边，纸面 W
    fill(g, 4, 11, 16, 13, 'W')
    fill(g, 4, 23, 16, 1, 'd')         # 纸底暗部
    fill(g, 19, 11, 1, 13, 'd')        # 纸右暗部

    # 纸面文本行（灰，递减宽度，像被截断的段落）
    hline(g, 6, 13, 12, 'g')
    hline(g, 6, 15, 11, 'g')
    hline(g, 6, 17, 12, 'g')
    hline(g, 6, 19, 8, 'g')
    hline(g, 6, 21, 6, 'g')

    # 铅笔（斜放，后画盖在纸面上）：橡皮在右上、尖在左下
    fill(g, 24, 11, 3, 1, 'e')         # 橡皮（顶行压亮，左上光源）
    fill(g, 24, 12, 3, 1, 'E')
    for x, y in ((23, 13), (22, 14), (21, 15), (20, 16), (19, 17), (18, 18)):
        g[y][x] = 'y'                  # 杆身高光（左上光源）
        g[y][x + 1] = 'Y'
        g[y][x + 2] = 'o'              # 杆身暗部
    for x, y in ((17, 19), (16, 20)):  # 木杆
        g[y][x] = 'A'
        g[y][x + 1] = 'A'
        g[y][x + 2] = 'a'
    fill(g, 16, 21, 2, 1, 'K')         # 笔尖（收尖）
    fill(g, 15, 22, 2, 1, 'K')
    return g


def build_audit():
    """Audit Log：Mac OS 9 窗口 + 日志纸（绿/红行首标记 = 登录成功/失败）+ 放大镜（审查与分析）。

    与 terminal / runner / blog 同构的窗口外框保证桌面观感统一；纸面承接记录行，
    放大镜后画并压在纸面右下角——「把日志逐条看清」即审查。行首 2px 彩色标记是
    本图标相对 blog（纸 + 铅笔）的语义区分点：审计关心的是每条记录的**结果**。
    """
    g = blank()

    # 窗口外框 x2..x29 / y2..y29（与 terminal/runner/blog 同构）
    fill(g, 2, 2, 28, 28, 'L')
    hline(g, 2, 2, 28, 'K')
    hline(g, 2, 29, 28, 'K')
    vline(g, 2, 2, 28, 'K')
    vline(g, 29, 2, 28, 'K')

    # 标题栏 y3..y8：顶高光 -> 基色(+标题短横) -> 条纹 -> 底暗边
    fill(g, 3, 3, 26, 6, 'L')
    fill(g, 3, 3, 26, 1, 'W')
    fill(g, 3, 5, 26, 1, 'M')
    fill(g, 3, 8, 26, 1, 'D')
    fill(g, 13, 4, 5, 1, 'M')          # 标题居中短横

    # 内容区：右侧与底部压暗边（光源左上）
    fill(g, 3, 9, 26, 19, 'L')
    fill(g, 28, 9, 1, 19, 'M')
    fill(g, 3, 27, 26, 1, 'M')
    fill(g, 3, 28, 26, 1, 'D')
    fill(g, 28, 26, 1, 2, 'D')

    # 日志纸 x4..x16 / y11..y26：底/右压暗边，纸面 W
    fill(g, 4, 11, 13, 16, 'W')
    fill(g, 4, 26, 13, 1, 'd')         # 纸底暗部
    fill(g, 16, 11, 1, 16, 'd')        # 纸右暗部

    # 记录行：行首 2px 结果标记（P 成功 / r 失败）+ 灰文本线（宽度递减，像被截断）
    for y, dot, w in ((13, 'P', 7), (16, 'r', 6), (19, 'P', 7), (22, 'r', 5), (25, 'P', 6)):
        fill(g, 5, y, 2, 1, dot)
        hline(g, 8, y, w, 'g')

    # 放大镜：镜片 9x9（外圈 K + 玻璃 h + 左上 W 高光），压在纸面右下角
    cx, cy = 20.5, 17.5   # 镜片中心（以像素中心计）
    for y in range(12, 24):
        for x in range(15, 27):
            d = ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2) ** 0.5
            if d <= 3.2:
                g[y][x] = 'h'          # 玻璃
            elif d <= 4.4:
                g[y][x] = 'K'          # 镜圈
    g[15][18] = 'W'                    # 高光（左上光源）
    g[16][18] = 'W'
    g[15][19] = 'W'

    # 镜柄：45° 向右下，2px 宽（外 K 内 M，保持立体感）
    for i in range(4):
        x, y = 24 + i, 21 + i
        g[y][x] = 'K'
        g[y][x + 1] = 'M'
    return g


def build_disk_legacy():
    """【旧版，保留作设计稿对照 / 一键回滚】Disk：窗口 + 硬盘盘片 + 容量条。

    与 terminal / runner / blog / audit 同构的窗口外框保证桌面观感统一；
    盘体内左侧是圆形盘片（外圈 K / 盘面 B / 主轴 W），右侧三条绿色容量条
    （M 轨道 + P 已用，长度递减表示不同挂载点的使用率）——「看盘还剩多少」
    即磁盘容量。条形复用 Runner 播放键的同一支绿，桌面色调不跳。
    """
    g = blank()

    # 窗口外框 x2..x29 / y2..y29（与 terminal/runner/blog/audit 同构）
    fill(g, 2, 2, 28, 28, 'L')
    hline(g, 2, 2, 28, 'K')
    hline(g, 2, 29, 28, 'K')
    vline(g, 2, 2, 28, 'K')
    vline(g, 29, 2, 28, 'K')

    # 标题栏 y3..y8：顶高光 -> 基色(+标题短横) -> 条纹 -> 底暗边
    fill(g, 3, 3, 26, 6, 'L')
    fill(g, 3, 3, 26, 1, 'W')
    fill(g, 3, 5, 26, 1, 'M')
    fill(g, 3, 8, 26, 1, 'D')
    fill(g, 13, 4, 5, 1, 'M')          # 标题居中短横

    # 内容区：右侧与底部压暗边（光源左上）
    fill(g, 3, 9, 26, 19, 'L')
    fill(g, 28, 9, 1, 19, 'M')
    fill(g, 3, 27, 26, 1, 'M')
    fill(g, 3, 28, 26, 1, 'D')
    fill(g, 28, 26, 1, 2, 'D')

    # 硬盘盘体 x5..x26 / y12..y23：白面 + K 外框 + 右/下内阴影（光源左上）
    fill(g, 5, 12, 22, 12, 'W')
    hline(g, 5, 12, 22, 'K')
    hline(g, 5, 23, 22, 'K')
    vline(g, 5, 12, 12, 'K')
    vline(g, 26, 12, 12, 'K')
    fill(g, 5, 22, 22, 1, 'M')         # 底部内阴影
    fill(g, 25, 13, 1, 10, 'M')        # 右侧内阴影

    # 盘片：外圈 K / 盘面 B / 主轴 2x2 W（圆心 (10.5, 17.5)）
    cx, cy = 10.5, 17.5
    for y in range(13, 23):
        for x in range(6, 16):
            d = ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2) ** 0.5
            if d <= 1.5:
                g[y][x] = 'S'          # 主轴座
            elif d <= 4.0:
                g[y][x] = 'B'          # 盘面
            elif d <= 4.9:
                g[y][x] = 'K'          # 外圈
    g[17][10] = 'W'                    # 主轴高光
    g[17][11] = 'W'
    g[18][10] = 'W'

    # 容量条 x16..x24 / y14|17|20：M 轨道 + P 绿色已用（长度递减）
    for y, wfill in ((14, 8), (17, 5), (20, 3)):
        hline(g, 16, y, 9, 'M')
        hline(g, 16, y, wfill, 'P')
    return g


def build_converter_legacy():
    """【旧版，保留作设计稿对照 / 一键回滚】Converter：窗口 + 两张竖幅照片 + 琥珀箭头。

    与 terminal / runner / blog / audit / disk 同构的窗口外框保证桌面观感统一。
    两张卡外形完全一致——换格式不改变构图，语义差异全交给中间的箭头承担：
    卡是「照片」，箭头是「转换」，方向即数据流（左进右出）。

    相对旧版（7x12 小卡 + 纯 K 黑箭头）的两处改动，都是为了 16px 档缩略可读：
      1. 卡改竖幅 7x16（内部 5x14 风景）——竖幅既像 iPhone 拍的 HEIC 原片，
         又把彩色面积拉高约 40%，缩到 16px 后仍是明显的蓝绿照片块而非灰条；
      2. 箭头由纯 K 改成琥珀立体（bevel y/Y/o，与 blog 铅笔同一支黄）——
         灰内容区上唯一的高饱和焦点，缩到 16px 也不会和窗口描边混成一块黑疙瘩
         （旧版黑箭头缩小后是哑铃状，正是它最先糊掉的部分）。

    照片 7x16 占 x4..x10 / x20..x26、y10..y25，内部 5x14 风景：天空 h 6 行、
    淡黄太阳 y 2x2、山体 p 亮坡 + P 暗坡（光源左上）、草地 G 2 行收底。
    箭头 7x9 骑在 x12..x18 / y13..y21：轴 3 行高、头是「尖 1 / 2 / 3 / 底 7」
    逐行张开的右向三角（45° 边）。两卡之间与内容区左右各留 1px 呼吸。
    """
    g = blank()

    # 窗口外框 x2..x29 / y2..y29（与 terminal/runner/blog/audit/disk 同构）
    fill(g, 2, 2, 28, 28, 'L')
    hline(g, 2, 2, 28, 'K')
    hline(g, 2, 29, 28, 'K')
    vline(g, 2, 2, 28, 'K')
    vline(g, 29, 2, 28, 'K')

    # 标题栏 y3..y8：顶高光 -> 基色(+标题短横) -> 条纹 -> 底暗边
    fill(g, 3, 3, 26, 6, 'L')
    fill(g, 3, 3, 26, 1, 'W')
    fill(g, 3, 5, 26, 1, 'M')
    fill(g, 3, 8, 26, 1, 'D')
    fill(g, 13, 4, 5, 1, 'M')          # 标题居中短横

    # 内容区：右侧与底部压暗边（光源左上）
    fill(g, 3, 9, 26, 19, 'L')
    fill(g, 28, 9, 1, 19, 'M')
    fill(g, 3, 27, 26, 1, 'M')
    fill(g, 3, 28, 26, 1, 'D')
    fill(g, 28, 26, 1, 2, 'D')

    # 竖幅照片（7x16，内部 5x14 风景）：K 外框 + 天空 / 淡黄太阳 / 山 / 草地
    photo = [
        'hhhhh',
        'hhyyh',
        'hhyyh',
        'hhhhh',
        'hhhhh',
        'hhhhh',
        'hhhph',
        'hhpPh',
        'hpppP',
        'pppPP',
        'pppPP',
        'pppPP',
        'GGGGG',
        'GGGGG',
    ]
    for px in (4, 20):
        fill(g, px, 10, 7, 16, 'K')    # 照片外框
        blit(g, photo, px + 1, 11)     # 画面（源 / 输出两张完全一致）

    # 右向箭头 x12..x18 / y13..y21：轴 3 行高，头逐行张开的 45° 三角（尖在中行）
    arrow = ((18, 18), (17, 18), (16, 18),
             (12, 18), (12, 18), (12, 18),
             (16, 18), (17, 18), (18, 18))
    sil = [[False] * W for _ in range(H)]
    for i, (x0, x1) in enumerate(arrow):
        sil_rect(sil, x0, 13 + i, x1, 13 + i)
    bevel(g, sil, 'Y', 'y', 'o')
    return g


def build_files_legacy():
    """【旧版，保留作设计稿对照 / 一键回滚】Files：窗口 + 平蓝文件夹 + 探出的白纸。

    与 terminal / runner / blog / audit / disk / converter 同构的窗口外框保证桌面观感统一。

    只画「一个」文件夹主体，不做「背板 + 前板」两块——32px 上两块蓝之间那条分界线
    会跟外框糊成一片，缩到 16px 更是三条蓝杠。改为一个整体色块，靠 tab（左上凸角）、
    前片横纹、以及从顶部探出的白纸三处细节交代「这是个文件夹、里面有文件」。

    配色刻意与其它应用区分：blog / audit 的主体是「白纸」（灰窗口里一片浅色），
    Files 反过来——主体是一整块饱和的蓝（b/h/m 与对话气泡同一支蓝，即 macOS 文件夹的蓝），
    白纸只在顶端露出 4 行。桌面上扫一眼，蓝块 = 文件夹，浅色块 = 文档类应用，不必读标题。

    结构（文件夹外框 y12..y25，内容区上留 2 / 下留 1）：
      纸    白面 x11..x23 / y11..y19 —— 先画，文件夹盖住 y15 以下，只露顶端 4 行；
      文件夹 L 形剪影：tab x5..x10 / y13..y16 + 主体 x4..x27 / y16..y24，
            bevel 左上高光 + outline 深蓝外框；
      横纹  y20 / y22 两条 m 暗线（Mac OS 9 前片的凹槽），是它区别于「下载/归档」图标的细节。
    绘制顺序：纸 → 文件夹 → 横纹（后画的盖住先画的）。
    """
    g = blank()

    # 窗口外框 x2..x29 / y2..y29（与 terminal/runner/blog/audit/disk/converter 同构）
    fill(g, 2, 2, 28, 28, 'L')
    hline(g, 2, 2, 28, 'K')
    hline(g, 2, 29, 28, 'K')
    vline(g, 2, 2, 28, 'K')
    vline(g, 29, 2, 28, 'K')

    # 标题栏 y3..y8：顶高光 -> 基色(+标题短横) -> 条纹 -> 底暗边
    fill(g, 3, 3, 26, 6, 'L')
    fill(g, 3, 3, 26, 1, 'W')
    fill(g, 3, 5, 26, 1, 'M')
    fill(g, 3, 8, 26, 1, 'D')
    fill(g, 13, 4, 5, 1, 'M')          # 标题居中短横

    # 内容区：右侧与底部压暗边（光源左上）
    fill(g, 3, 9, 26, 19, 'L')
    fill(g, 28, 9, 1, 19, 'M')
    fill(g, 3, 27, 26, 1, 'M')
    fill(g, 3, 28, 26, 1, 'D')
    fill(g, 28, 26, 1, 2, 'D')

    # 纸：先画，下半会被文件夹压住。两张错开 2px 叠在一起（顶行窄 2px 即台阶），
    # 一张平齐的白条更像「贴了张便签」，错落才有「一叠文件」的意思。
    fill(g, 13, 11, 11, 9, 'W')        # 后张（窄 2px，只露顶端一条）
    fill(g, 11, 12, 13, 8, 'W')        # 前张
    fill(g, 23, 11, 1, 9, 'd')         # 右沿压暗（两张共用）
    hline(g, 13, 13, 9, 'g')           # 灰字线
    hline(g, 13, 14, 6, 'g')

    # 文件夹：tab（左上凸角）+ 主体，左上光源立体蓝 + 深蓝外框
    folder = [[False] * W for _ in range(H)]
    sil_rect(folder, 5, 13, 10, 16)    # tab（4 行高，够看出「凸起的一角」）
    sil_rect(folder, 4, 16, 27, 24)    # 主体（y16 与 tab 重叠，连成一整块）
    bevel(g, folder, 'b', 'h', 'm')
    outline(g, folder, 'N')

    # 前片横纹（Mac OS 9 文件夹的凹槽）：两条 m 暗线，别画太满
    hline(g, 7, 20, 18, 'm')
    hline(g, 7, 22, 18, 'm')
    return g


def window_chrome():
    """返回一张画好 Mac OS 9 同构窗口外框的空白网格：黑边 + 条纹标题栏 + 内容区。

    terminal / runner / blog / audit / disk / converter / files 共用的那套底色。
    抽出来给 Files 重设计复用；既有 build_* 保持原样，不改动已验收的像素。
    """
    g = blank()
    fill(g, 2, 2, 28, 28, 'L')
    hline(g, 2, 2, 28, 'K')
    hline(g, 2, 29, 28, 'K')
    vline(g, 2, 2, 28, 'K')
    vline(g, 29, 2, 28, 'K')
    fill(g, 3, 3, 26, 6, 'L')
    fill(g, 3, 3, 26, 1, 'W')
    fill(g, 3, 5, 26, 1, 'M')
    fill(g, 3, 8, 26, 1, 'D')
    fill(g, 13, 4, 5, 1, 'M')
    fill(g, 3, 9, 26, 19, 'L')
    fill(g, 28, 9, 1, 19, 'M')
    fill(g, 3, 27, 26, 1, 'M')
    fill(g, 3, 28, 26, 1, 'D')
    fill(g, 28, 26, 1, 2, 'D')
    return g


def build_files_windowed():
    """【上一版，保留作设计稿对照 / 回滚】Files：Mac OS 9 窗口 + 立体蓝文件夹。

    相对旧版（平蓝板 + 两条孤立横纹 + 顶端 4 行白纸）的三处改动：
      1. 不再往文件夹里塞「后片 / 白纸 / 前片」三层。32px 内容区只有 26×19，
         白纸会把蓝色切成左右两块，缩到 16px 更只剩三条蓝横杠 —— 试过并否决。
         改为一整块完整色块，靠 tab 缺口（左上凸起 + 右侧 N 轮廓线）认形。
      2. 删掉两条孤立 m 横纹（16px 下的深色脏点来源），改由 bevel 的整圈
         「顶/左 h 高光、底/右 m 暗部」+ outline 一圈 N 承担全部立体感。
      3. 前片折痕用「1px h 亮 + 1px m 暗」成对高光带：32px 上是折角，
         2×2 多数票降采样后并回蓝面，不会像孤立暗线那样留下脏点。
    桌面语义不变：蓝块 = Files，浅色块 = 文档类应用（blog / audit）。
    """
    g = window_chrome()

    # 文件夹剪影：tab x5..13 / y11..14 与主体 x4..26 / y14..24 共享 y14，连成一整块。
    folder = [[False] * W for _ in range(H)]
    sil_rect(folder, 5, 11, 13, 14)
    sil_rect(folder, 4, 14, 26, 24)
    bevel(g, folder, 'b', 'h', 'm')
    outline(g, folder, 'N')

    # 前片折痕：亮/暗成对，缩略时并回蓝面
    hline(g, 5, 18, 21, 'h')
    hline(g, 5, 19, 21, 'm')
    return g


def build_editor_v2():
    """【上一轮，保留作设计稿对照 / 回滚】Editor：窗口 + 行号栏 + 彩色语法高亮行。

    原来用的是 classicy 内置 simpletext 图标，与自绘像素图标不是一套。新图标靠
    「行号栏 + 彩色代码行」与 blog（白纸 + 灰线 + 铅笔）、terminal（黑屏 + >）区分：
    blog 写文章、Editor 写代码，颜色就是分界。代码行一律 2px 高并对齐偶数 y，
    2×2 多数票降采样后仍是彩条，不会像 1px 细线那样被白底吃掉。
    """
    g = window_chrome()

    # 编辑区：K 黑框 + W 白面
    fill(g, 4, 10, 24, 15, 'K')
    fill(g, 5, 11, 22, 13, 'W')

    # 行号栏 x5..8（L 浅灰底 + M 分隔线 + 2x2 行号点，不写文字）
    fill(g, 5, 11, 4, 13, 'L')
    vline(g, 9, 11, 13, 'M')
    for y in (12, 16, 20):
        fill(g, 6, y, 2, 2, 'g')

    # 三行语法高亮：蓝关键字 / 绿字符串 / 琥珀数字 / 灰注释 + 块状光标
    fill(g, 11, 12, 5, 2, 'b')
    fill(g, 17, 12, 6, 2, 'P')
    fill(g, 24, 12, 3, 2, 'Y')
    fill(g, 13, 16, 6, 2, 'Y')
    fill(g, 20, 16, 5, 2, 'b')
    fill(g, 11, 20, 4, 2, 'P')
    fill(g, 16, 20, 5, 2, 'g')
    fill(g, 22, 20, 2, 2, 'K')
    return g


def build_converter_v2():
    """【上一轮，保留作设计稿对照 / 回滚】Converter：照片 → 琥珀箭头 → 文件卡。

    旧版左右是两张一模一样的照片，看不出「格式变了」。新版把输出端换成一张
    白纸文件卡（折角 + 灰文本行），左图右文 + 单向箭头把「图片 → 另一种文件」
    的方向交代清楚；箭头用 bevel 立体琥珀（与 blog 铅笔同一支黄），缩略后仍是
    内容区里唯一的高饱和焦点。
    """
    g = window_chrome()

    # 左：竖幅山景照片 x4..12 / y10..24（K 外框 + 7x13 风景）
    fill(g, 4, 10, 9, 15, 'K')
    photo = [
        'hhhhhhh',
        'hhyyhhh',
        'hhyyhhh',
        'hhhhhhh',
        'hhhhhhh',
        'hhhphhh',
        'hhpPPhh',
        'hpppPPh',
        'pppPPPP',
        'pppPPPP',
        'GGGGGGG',
        'GGGGGGG',
        'GGGGGGG',
    ]
    blit(g, photo, 5, 11)

    # 右：白纸文件卡 x20..27 / y10..24，右上折角（d 灰面 + K 斜边）
    fill(g, 20, 10, 8, 15, 'K')
    fill(g, 21, 11, 6, 13, 'W')
    for i, x0 in enumerate((24, 25, 26)):
        hline(g, x0, 11 + i, 27 - x0, 'g')   # 深灰折角（d 太浅，16px 下读不出）
    g[11][24] = 'K'
    g[12][25] = 'K'
    g[13][26] = 'K'
    fill(g, 22, 16, 5, 2, 'g')
    fill(g, 22, 19, 4, 2, 'g')

    # 中：右向立体箭头 x13..19 / y13..21（沿用旧版已验证的大箭头，右移 1px）
    arrow = [[False] * W for _ in range(H)]
    for i, (x0, x1) in enumerate(((19, 19), (18, 19), (17, 19),
                                  (13, 19), (13, 19), (13, 19),
                                  (17, 19), (18, 19), (19, 19))):
        sil_rect(arrow, x0, 13 + i, x1, 13 + i)
    bevel(g, arrow, 'Y', 'y', 'o')
    return g


def build_runner():
    """Runner（脚本任务）：窗口 + 绿色圆形播放徽章 + 任务日志行 + 底部进度条。

    旧版是灰窗口里一个裸绿三角 + 两条灰线，缩略后像一个孤零零的箭头。新版给
    播放键套上立体圆徽章（G 外圈 / P 面 / p 左上高光 / K 描边），右侧三条日志行
    与底部绿进度条一起交代「任务正在跑、有输出、有进度」。全部横条 2px 高。
    """
    g = window_chrome()

    # 圆形徽章，圆心 (10.5, 16.5)
    cx, cy = 10.5, 16.5
    for y in range(10, 23):
        for x in range(4, 17):
            d = ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2) ** 0.5
            if d <= 5.8:
                g[y][x] = 'G' if d > 4.7 else ('p' if (x < cx and y < cy) else 'P')
            elif d <= 6.7:
                g[y][x] = 'K'

    # 白色播放三角：纯色实心、加大到 6x7。bevel 的明暗分块会在 2×2 降采样后
    # 把三角打成十字形，这里宁可少一层立体感也要保住 16px 的「▶」。
    for i, w in enumerate((2, 3, 4, 5, 6, 5, 4, 3, 2)):
        hline(g, 8, 12 + i, w, 'W')

    # 任务日志行（长度递减）
    fill(g, 18, 12, 9, 2, 'g')
    fill(g, 18, 16, 7, 2, 'g')
    fill(g, 18, 20, 5, 2, 'g')
    # 进度条：M 轨道 + P 已执行
    fill(g, 5, 23, 22, 2, 'M')
    fill(g, 5, 23, 13, 2, 'P')
    return g


def build_disk_v2():
    """【上一轮，保留作设计稿对照 / 回滚】Disks：窗口 + 三块层叠硬盘。

    旧版是「一块盘 + 三条容量条」，语义停在单盘。新版按侧视画三块盘（对应
    DiskPanel 的多个挂载点）：K 外框 + W 银白面 + P 状态灯 + M 散热槽 + b 用量条，
    用量长度递减。三块对齐 y10/16/22、每块 4px 高，正好落在 2×2 降采样块的边界上，
    16px 下是三条清晰的盘体而不是糊成一片。
    """
    g = window_chrome()
    for i, y in enumerate((10, 16, 22)):
        fill(g, 4, y, 24, 4, 'K')              # 盘体外框 x4..27 / y..y+3
        fill(g, 5, y + 1, 22, 2, 'W')         # 银白面
        fill(g, 6, y + 1, 2, 2, 'P')          # 状态灯（绿）
        for x in (10, 12, 14):
            vline(g, x, y + 1, 2, 'M')        # 散热槽
        fill(g, 18, y + 1, 9, 2, 'M')         # 容量轨道
        fill(g, 18, y + 1, (7, 5, 3)[i], 2, 'b')
    return g


def build_watchdog_v2():
    """【上一轮，保留作设计稿对照 / 回滚】WatchDog OS：窗口 + 实时曲线 + 三色灯。

    原来同样用 classicy 内置图标（systemProfiler）。作为产品主应用改自绘：内容区
    是一条 2px 粗的阶梯折线（CPU / 流量实时曲线，p 上沿高光），底下三颗状态灯
    （P 绿 / Y 琥珀 / r 红 = CPU / 内存 / 温度）。点状仪表网格是 32px 专属细节，
    1px 散点在 2×2 多数票降采样后会被 L 底吃掉，不会污染 16px 观感。
    登录页品牌图标也复用本图标，桌面与登录页保持一致。
    """
    g = window_chrome()

    # 仪表网格（点状虚线，仅大尺寸可见）
    for y in (13, 18, 23):
        for x in range(5, 27, 3):
            g[y][x] = 'M'

    # 实时曲线：水平段 2px 粗 + 竖直连接段，p 为上沿高光
    segs = [(5, 9, 20), (9, 13, 16), (13, 16, 18),
            (16, 19, 11), (19, 23, 17), (23, 26, 14)]
    for (x0, x1, y) in segs:
        fill(g, x0, y, x1 - x0 + 1, 2, 'P')
        hline(g, x0, y, x1 - x0 + 1, 'p')
    for i in range(len(segs) - 1):
        x = segs[i][1]
        y0, y1 = segs[i][2], segs[i + 1][2]
        lo, hi = min(y0, y1), max(y0, y1)
        fill(g, x, lo, 2, hi - lo + 2, 'P')
        vline(g, x, lo, hi - lo + 2, 'p')

    # 三色状态灯
    fill(g, 5, 24, 3, 2, 'P')
    fill(g, 9, 24, 3, 2, 'Y')
    fill(g, 13, 24, 3, 2, 'r')
    return g


def build_watchdog():
    """WatchDog OS：独立 8 齿钢灰齿轮 + 中心绿运行灯（主应用 / 品牌 logo）。

    本轮「齿轮风格」：系统引擎的具象符号。刻意不套窗口外框 —— 齿轮要占满画布
    才撑得住 16px 缩略与登录页的小尺寸 logo，chat / docker 已有独立主体先例。
    齿 = 半径 10 的圆盘 + 8 根沿 45° 方向伸到半径 13、宽 5px 的方头齿；不用
    正弦波形，像素画里方齿才立得住。bevel 给左上 W 高光 / 右下 M 暗部，outline
    补 1px K 外框；中心深色轴孔里一颗 2x2 P 绿点 = 看门狗正在运行。
    """
    g = blank()
    cx = cy = 15.5
    gear = [[False] * W for _ in range(H)]
    for y in range(H):
        for x in range(W):
            dx, dy = x + 0.5 - cx, y + 0.5 - cy
            r = math.hypot(dx, dy)
            if r <= 10.0:
                gear[y][x] = True
                continue
            for k in range(8):
                a = k * math.pi / 4
                ca, sa = math.cos(a), math.sin(a)
                p = dx * ca + dy * sa
                q = -dx * sa + dy * ca
                if 9.0 <= p <= 13.0 and abs(q) <= 2.4:
                    gear[y][x] = True
                    break
    bevel(g, gear, 'L', 'W', 'M')
    outline(g, gear, 'K')

    # 中心运行灯：整颗绿盘 P + 深色轴座 D。2x2 小绿点会在 2×2 降采样里被
    # 深色孔吃掉，改成直径 5px 的绿盘后 16px 仍是明显的绿心。
    for y in range(H):
        for x in range(W):
            if not gear[y][x]:
                continue
            r = math.hypot(x + 0.5 - cx, y + 0.5 - cy)
            if r <= 2.6:
                g[y][x] = 'P'
            elif r <= 3.6:
                g[y][x] = 'D'
    g[14][14] = 'p'                    # 左上高光（32px 细节）
    g[14][15] = 'p'
    return g


def build_editor_v3():
    """【上一版，保留作设计稿对照 / 回滚】Editor：窗口 + 合上的琥珀笔记本封面。

    「笔记本封面风格」：一本合上的皮面本子正视，不画打开的内页（那是 Blog 的白纸）。
    书脊（左深棕 + 一道亮棱）、弹性绑带（右深色竖条）、两道压印标题线、底沿垂出的
    红书签带，四处细节凑出 Moleskine 质感；暖琥珀封面在满桌蓝灰图标里也独一份。
    压印线与书签带均 ≥2px，16px 缩略不会消失。
    """
    g = window_chrome()

    # 封面 x6..25 / y9..23：K 外框 + 琥珀皮面（左上 y 高光、右下 o 暗部）
    fill(g, 6, 9, 20, 15, 'K')
    fill(g, 7, 10, 18, 13, 'Y')
    hline(g, 7, 10, 18, 'y')
    hline(g, 7, 22, 18, 'o')
    vline(g, 24, 10, 13, 'o')

    # 书脊 x7..9（深棕 a/o）+ 右侧一道亮棱 x10
    fill(g, 7, 10, 3, 13, 'a')
    vline(g, 7, 10, 13, 'o')
    vline(g, 10, 10, 13, 'y')

    # 弹性绑带 x21..22 + 底部小扣
    fill(g, 21, 10, 2, 13, 'K')
    fill(g, 21, 20, 2, 2, 'D')

    # 封面压印标题（两条 2px 暗线，不写文字）
    fill(g, 13, 14, 7, 2, 'o')
    fill(g, 13, 18, 5, 2, 'o')

    # 书签带从封面底沿垂出（红 r + 末端暗红 E）
    fill(g, 17, 24, 3, 3, 'r')
    hline(g, 17, 26, 3, 'E')
    return g


def build_converter_v3():
    """【上一版，保留作设计稿对照 / 回滚】Converter：3×5 像素字母 HEIC / JPG 标签条。

    「字母风格」：字母严格照抄 skills/pixelart/SKILL.md 的 3×5 参考表（不自行近似），
    字符间 1px 间隔。上条浅蓝 h 面 + 深蓝 N 字 = 源格式，下条浅绿 p 面 + 深绿 G 字 =
    目标格式，中间琥珀下箭头 = 转换方向。两条各 7px 高，2×2 降采样后仍是完整色带，
    字母在 32px 下逐个可读、在 16px 下并成文字纹理。
    """
    g = window_chrome()

    font = {
        'H': ['#.#', '#.#', '###', '#.#', '#.#'],
        'E': ['###', '#..', '###', '#..', '###'],
        'I': ['###', '.#.', '.#.', '.#.', '###'],
        'C': ['###', '#..', '#..', '#..', '###'],
        'J': ['.##', '..#', '..#', '#.#', '##.'],
        'P': ['###', '#.#', '###', '#..', '#..'],
        'G': ['###', '#..', '#.#', '#.#', '###'],
    }

    def draw_text(s, x0, y0, fg):
        for i, c in enumerate(s):
            for j, row in enumerate(font[c]):
                for k, v in enumerate(row):
                    if v == '#':
                        g[y0 + j][x0 + i * 4 + k] = fg

    # 上：HEIC 标签
    fill(g, 4, 9, 24, 7, 'N')
    fill(g, 5, 10, 22, 5, 'h')
    draw_text('HEIC', 8, 10, 'N')

    # 中：琥珀下向箭头（柄 2px → 头 6px → 收 4px）
    fill(g, 15, 16, 2, 2, 'Y')
    fill(g, 13, 18, 6, 1, 'Y')
    fill(g, 14, 19, 4, 1, 'o')

    # 下：JPG 标签
    fill(g, 4, 20, 24, 7, 'G')
    fill(g, 5, 21, 22, 5, 'p')
    draw_text('JPG', 11, 21, 'G')
    return g


def build_disk():
    """Disks：窗口 + 大圆形存储盘（银色盘面 + 环形容量弧 + 中心主轴）。

    「存储盘风格」= 一眼看得出是「盘」：占满内容区的大圆盘，外圈一圈 P 绿 / M 灰
    容量弧（绿弧约 65% 已用，呼应 DiskPanel 的挂载点使用率），中心 S 深色主轴 +
    W 高光。盘面按左上 W / 右下 M 做金属反光；比上一轮三条横带更像存储介质，
    也不会和 audit 的放大镜（蓝玻璃圆 + 斜柄）撞。
    """
    g = window_chrome()
    cx, cy, R = 15.5, 17.5, 8.5
    for y in range(9, 27):
        for x in range(3, 29):
            dx, dy = x + 0.5 - cx, y + 0.5 - cy
            r = math.hypot(dx, dy)
            if r > R:
                continue
            if r > R - 1:
                g[y][x] = 'K'                     # 盘缘外框
                continue
            if r >= 6.0:                         # 环形容量弧
                ang = math.atan2(dx, -dy)
                if ang < 0:
                    ang += 2 * math.pi
                g[y][x] = 'P' if ang <= 2 * math.pi * 0.65 else 'M'
                continue
            # 金属反光：左上亮、右下暗；高光收窄，否则浅色底上像圆盘缺了一角
            s = dx + dy
            g[y][x] = 'W' if s < -6 else ('M' if s > 5 else 'L')

    # 中心主轴（S 深色 + D 环）+ 2x2 高光
    for y in range(9, 27):
        for x in range(3, 29):
            r = math.hypot(x + 0.5 - cx, y + 0.5 - cy)
            if r <= 2.3:
                g[y][x] = 'S'
            elif r <= 3.2:
                g[y][x] = 'D'
    fill(g, 14, 16, 2, 2, 'W')
    return g


def build_converter_v4():
    """【上一版，保留作设计稿对照 / 回滚】Converter：带窗口外框的平行 ⇄ 双箭头。

    用户指定「交换箭头」：不再用字母标签，改为上排琥珀右向箭头、下排蓝色左向箭头，
    两条粗箭头首尾反向，一眼就是「互换」。各自尾部挂一个 4x4 格式块（左端浅蓝 h /
    右端浅绿 p，沿用上一版 HEIC / JPG 标签条的取色），把「两个格式对调」的意思补齐，
    而不只是抽象的刷新符号。

    两条箭头由同一个 7 行轮廓左右镜像生成：3px 窄柄 + 7px 高的三角头，柄与头的
    高度差必须够大，否则整枚箭头读作一根粗横条（第一版就踩了）。bevel 给左上
    高光 / 右下暗部。**刻意不用 outline**：outline 会把两条箭头之间那 2px 空隙
    也当成「剪影外且相邻有剪影」补上深色，⇄ 糊成一整块；只用 bevel 才保得住缝。
    两条各占 7 行（y10..16 / y19..25），16px 缩略仍是两条完整的彩色箭头带。
    """
    g = window_chrome()

    # 右向箭头的 7 行轮廓 (x0, x1)：3px 窄柄（y2..y4）+ 7px 高的三角头，
    # 尖在 x26 / 中心行。柄与头的高度差必须够大，否则整枚箭头读作一根粗横条。
    rows = [(19, 20), (19, 22), (5, 24), (5, 26),
            (5, 24), (19, 22), (19, 20)]

    def arrow(y0, mirrored, base, hi, lo):
        sil = [[False] * W for _ in range(H)]
        for i, (a, b) in enumerate(rows):
            if mirrored:
                a, b = 31 - b, 31 - a
            sil_rect(sil, a, y0 + i, b, y0 + i)
        bevel(g, sil, base, hi, lo)

    arrow(10, False, 'Y', 'y', 'o')     # 上：→ 琥珀（y10..16）
    arrow(19, True, 'b', 'h', 'm')      # 下：← 蓝（y19..25）

    # 两端格式块（4x4 深色框 + 2x2 亮面）：上箭头尾部 / 下箭头尾部
    fill(g, 5, 11, 4, 4, 'N')
    fill(g, 6, 12, 2, 2, 'h')
    fill(g, 23, 20, 4, 4, 'G')
    fill(g, 24, 21, 2, 2, 'p')
    return g


def build_converter():
    """Converter：无窗口外框，参考 Chat 双气泡构图 —— 两个大箭头前后叠放相互交换。

    用户要求「参考 Chat，去掉外边框，2 个大箭头相互交换」：不再画 Mac OS 9 窗口，
    主体直接落在透明底上（chat / docker / watchdog 齿轮已有先例）。构图照抄
    build_chat() 的前后关系 —— 后箭头偏左上、前箭头偏右下、错开叠压，前层用整圈
    描边把自己从后层上「切」出来，和 Chat 前白气泡压后蓝气泡是同一套手法。

    一枚箭头 14 行：6px 柄 + 14px 高的三角头，尖占 2 行。两条由同一轮廓
    水平镜像（x -> 31-x）+ 下移 8 行生成，所以一个朝右、一个朝左，头分别落在
    右上与左下，绕着中心互相交换。后箭头用 Chat 后气泡那支蓝（N/b/h/m），
    前箭头用琥珀（K/Y/y/o），亮暖色在前更醒目；柄上各两条 1px 文本线是
    32px 专属细节，呼应 Chat 气泡里的文字线。
    """
    g = blank()

    # 右向箭头的 14 行轮廓 (x0, x1)：柄 x2.. / 三角头 x18..24，尖在 x24
    rows = [
        (18, 18), (18, 19), (18, 20), (18, 21),
        (2, 22), (2, 23), (2, 24), (2, 24),
        (2, 23), (2, 22), (18, 21), (18, 20), (18, 19), (18, 18),
    ]

    def arrow(y0, mirrored, base, hi, lo, edge):
        sil = [[False] * W for _ in range(H)]
        for i, (a, b) in enumerate(rows):
            if mirrored:
                a, b = 31 - b, 31 - a
            sil_rect(sil, a, y0 + i, b, y0 + i)
        bevel(g, sil, base, hi, lo)
        outline(g, sil, edge)

    # 下移 8 行（不是 12）：两枚箭头重叠 6 行，才读作「前后叠压」而非上下排列
    arrow(5, False, 'b', 'h', 'm', 'N')     # 后：→ 蓝，左上（y5..18）
    arrow(13, True, 'Y', 'y', 'o', 'K')     # 前：← 琥珀，右下（y13..26）

    # 柄上的文本线（32px 专属细节，呼应 Chat 气泡里的文字线）
    hline(g, 5, 10, 9, 'W')
    hline(g, 5, 12, 6, 'W')
    hline(g, 17, 18, 9, 'o')
    hline(g, 17, 20, 6, 'o')
    return g


def build_editor():
    """Editor：无窗口外框，参考 Chat / Converter 的前后叠放 —— 两本笔记本封面。

    用户要求「参考这个风格」（即新版 Converter 的 Chat 式构图）重做笔记本封面：
    透明底、无 Mac OS 9 窗口，后本深蓝偏左上（x2..21 / y2..18）、前本琥珀偏右下
    （x10..29 / y10..26），重叠 10 行；前本外铺一圈 1px K 描边框把自己从后层
    「切」出来，和 Chat 前白气泡压后蓝气泡、Converter 前琥珀箭头压后蓝箭头同一手法。

    前本是主角，封面细节全在它身上：深棕书脊 + 亮棱、弹性绑带 + 小扣、两道
    压印标题线、底沿垂出的红书签带；后本只留高光/暗部与一条白文本线呼应 Chat
    气泡。压印线与书签带 ≥2px，16px 缩略不会消失。
    """
    g = blank()

    # 后本（深蓝，偏左上）x2..21 / y2..18：N 外框 + b 面 + h/m 浮雕
    fill(g, 2, 2, 20, 17, 'N')
    fill(g, 3, 3, 18, 15, 'b')
    hline(g, 3, 3, 18, 'h')
    vline(g, 3, 3, 15, 'h')
    hline(g, 3, 17, 18, 'm')
    vline(g, 20, 3, 15, 'm')
    fill(g, 3, 3, 3, 15, 'N')          # 书脊
    vline(g, 6, 3, 15, 'h')            # 书脊亮棱
    hline(g, 8, 5, 10, 'W')            # 两条白压印线（呼应 Chat 气泡的文本线）
    hline(g, 8, 7, 7, 'W')

    # 前本整圈 K 描边框 x9..30 / y9..27：前后分层线
    fill(g, 9, 9, 22, 19, 'K')

    # 前本（琥珀，偏右下）x10..29 / y10..26
    fill(g, 10, 10, 20, 17, 'Y')
    hline(g, 10, 10, 20, 'y')
    vline(g, 10, 10, 17, 'y')
    hline(g, 10, 26, 20, 'o')
    vline(g, 29, 10, 17, 'o')
    fill(g, 10, 10, 3, 17, 'a')        # 深棕书脊 x10..12
    vline(g, 10, 10, 17, 'o')
    vline(g, 13, 10, 17, 'y')          # 亮棱
    fill(g, 25, 10, 2, 17, 'K')        # 弹性绑带
    fill(g, 25, 23, 2, 2, 'D')         # 小扣
    fill(g, 16, 15, 7, 2, 'o')         # 压印标题线
    fill(g, 16, 19, 5, 2, 'o')

    # 红书签带从底沿垂出
    fill(g, 21, 26, 3, 4, 'r')
    hline(g, 21, 29, 3, 'E')
    return g


def build_files_closed():
    """【上一版，保留作设计稿对照 / 回滚】Files：无外框、闭合的独立大蓝文件夹。

    用户要求「去掉外边框，保留文件夹样式即可」：不再画 Mac OS 9 窗口，文件夹
    从内容区放大到占满画布（tab x4..14 / y4..9，主体 x2..29 / y9..27），
    其余一律保留 —— tab 凸角、bevel 左上 h 高光 / 右下 m 暗部、N 深蓝外框、
    1px h / 1px m 成对的前片折痕。outline 顺带把 tab 右缘与主体顶边勾出深蓝线，
    正是经典文件夹的「缺口」轮廓。四周留 1~3px 透明边，与 watchdog / converter /
    editor 一样改用独立主体。
    """
    g = blank()

    folder = [[False] * W for _ in range(H)]
    sil_rect(folder, 4, 4, 14, 9)      # tab（6 行高，足够看出凸起的一角）
    sil_rect(folder, 2, 9, 29, 27)     # 主体（19 行高，y9 与 tab 连成一整块）
    bevel(g, folder, 'b', 'h', 'm')
    outline(g, folder, 'N')

    # 前片折痕：亮/暗成对，2×2 降采样后并回蓝面
    hline(g, 5, 18, 23, 'h')
    hline(g, 5, 19, 23, 'm')
    return g


def build_files_open_blue():
    """【上一版，保留作设计稿对照 / 回滚】Files：蓝色梯形前片的打开文件夹。

    用户要求「文件夹改成被打开的样子」：从一整块闭合蓝板拆成两层 ——
      后片：tab（x7..17 / y4..8）+ 立着的背板（x6..25 / y8..17），压暗成 m/N
            留在敞口阴影里；**刻意比前片窄一截**，两端在 y15..17 仍露出来，
            2×2 降采样后才留得住「上窄下宽」的打开形（等宽会糊成上下两个方块）；
      前片：从 y15 向下张开的梯形盖（上沿 x9..22 / 14px → 下沿 x2..29 / 28px，
            每 1~2 行左右各扩 1px），亮蓝 b + h 高光 / m 暗部，盖住后片下部。
    两层靠明度差 + 梯形斜边 + outline 勾出的敞口横线交代「打开」。不放白纸 ——
    第一轮在 26×19 的小内容区试过后片/白纸/前片三层，白纸把蓝块切成左右两块、
    16px 下只剩三条蓝横杠，这个坑不再踩。四周留 1~3px 透明边。
    """
    g = blank()

    # 后片（暗）：tab + 立着的背板。比前片窄，左右两端在 y15..17 仍露出来，
    # 才能读作「后面还有一块板」而不是上下平分的两半。
    back = [[False] * W for _ in range(H)]
    sil_rect(back, 7, 4, 17, 8)
    sil_rect(back, 6, 8, 25, 17)
    bevel(g, back, 'm', 'b', 'N')
    outline(g, back, 'N')

    # 前片（亮）：向前翻开的梯形，上沿 14px → 下沿 28px。后片刻意比前片窄一截，
    # 2×2 降采样后才留得住「上窄下宽」的打开形（等宽会糊成上下两个方块）。
    front = [[False] * W for _ in range(H)]
    rows = [(9, 22), (8, 23), (8, 23), (7, 24), (6, 25), (5, 26),
            (4, 27), (3, 28), (2, 29), (2, 29), (2, 29), (2, 29),
            (2, 29), (2, 29)]
    for i, (a, b) in enumerate(rows):
        sil_rect(front, a, 15 + i, b, 15 + i)
    bevel(g, front, 'b', 'h', 'm')
    outline(g, front, 'N')          # 顺带在 y14 勾出一条深色敞口线
    return g


def build_files():
    """Files：参考 macOS 经典打开文件夹 —— 小圆角 tab 在后 + 大圆角浅黄面板在前。

    用户给的参考图：橙黄小 tab 只露出上沿，前面是一整块大圆角浅黄渐变面板，
    两层之间一条亮敞口线，没有硬黑描边。按这个造型重做，与上一版「暗蓝后片 +
    亮蓝梯形前片」的透视画法完全不同：
      · 后片只画 tab（x2..16 / y3..13 的圆角块），下部被前片盖住，仅露 y3..7；
      · 前片是 x1..30 / y8..29 的大圆角面板，占约 80% 面积，顶部 W 高光带、
        中部 V 浅黄、底部 y→Y 渐变压深；外框用暖色 o 而非 K 硬黑边。
    配色随参考图改为暖黄（新增 J / V 两色），桌面语义从「蓝 = Files」变成
    「暖黄 = Files」；与 Editor 的琥珀笔记本靠形状区分（本版是纯色块 + 圆角，
    没有书脊 / 绑带 / 书签带）。
    """
    g = blank()

    # 后片 tab（橙黄，圆角；下部被前片盖住，只露顶部 5 行）
    roundbox(g, 2, 3, 15, 11, 'o', r=3)
    roundbox(g, 3, 4, 13, 9, 'J', r=2)
    hline(g, 6, 4, 7, 'y')

    # 前片：大圆角浅黄面板（参考图的主体）
    roundbox(g, 1, 8, 30, 22, 'o', r=3)
    roundbox(g, 2, 9, 28, 20, 'V', r=2)
    hline(g, 5, 9, 22, 'W')                 # 上沿亮高光 = 敞口线
    for yy, x0, w in ((24, 3, 26), (25, 3, 26), (26, 4, 24), (27, 5, 22)):
        hline(g, x0, yy, w, 'y')            # 底部渐变，逐行收窄呼应圆角
    hline(g, 6, 28, 20, 'Y')
    return g


# ---------------------------------------------------------------- 16 档：窗口操作按钮带内嵌图标
# 规格见 docs/icon-pipeline.md §1.2：16x16 网格 1:1 渲染（.sp-tb-icon）。
# 双色：'N'（#1b3d72 深蓝描边）+ 'b'（#4a86d8 蓝面）——沿用水泡图标的同一支蓝。
# 固定色（不走 currentColor），三态由 src/styles.css 的 filter 补：按下反白、禁用压灰。
# 三个字形统一光源（左上）、描边厚度与留白，视觉上是一套：Back 左向、Up 上向、Favorites 五角星。
def build_fm_back(edge='N', tone='b', thickness=1):
    """Back：左向箭头（尖三角 + 矩形柄），12x11，四周 ≥2px 透明边。

    三角形按 45° 张开（每列上下各扩 1px），尖在 x=2 / y=7，基边 x=7；
    柄 x=7..13 / y=5..9，高度取三角中段。剪影完成后交给 face() 上双色。
    """
    g = blank()
    for x in range(2, 8):
        for y in range(7 - (x - 2), 7 + (x - 2) + 1):
            g[y][x] = 'K'
    fill(g, 7, 5, 7, 5, 'K')
    # core 收在三角中段与柄内：尖端只留 1px 的角，出不了面
    return face(g, edge=edge, fill=tone, thickness=thickness, core=(5, 5, 13, 9))


def build_fm_up(edge='N', tone='b', thickness=1):
    """Up：上向箭头（尖三角 + 矩形柄），11x11，与 Back 同参数旋转 90°。"""
    g = blank()
    for y in range(2, 8):
        for x in range(7 - (y - 2), 7 + (y - 2) + 1):
            g[y][x] = 'K'
    fill(g, 5, 7, 5, 6, 'K')
    # core 收在三角中段与柄内：尖端只留 1px 的角，出不了面
    return face(g, edge=edge, fill=tone, thickness=thickness, core=(5, 4, 10, 11))


def build_fm_fav(edge='N', tone='b', thickness=1):
    """Favorites：五角星（12x11，上尖 + 双臂 + 张开的双腿）。"""
    g = blank()
    blit(g, [
        '.....KK.....',
        '....KKKK....',
        '....KKKK....',
        '...KKKKKK...',
        'KKKKKKKKKKKK',
        'KKKKKKKKKKKK',
        '.KKKKKKKKKK.',
        '..KKKKKKKK..',
        '..KKKKKKKK..',
        '..XXX..XXX..',
        '.XXX....XXX.',
        '.XX......XX.',
    ], 2, 2)
    return face(g, edge=edge, fill=tone, thickness=thickness, core=(4, 5, 11, 8))


def build_home(edge='N', tone='b', thickness=1):
    """Home：小屋（斜屋顶 + 屋檐 + 屋身 + 门洞），14x13，四周 ≥1px 透明边。

    手机端「返回首页」悬浮键的图标（16 档 1:1）：屋顶压成三角、屋檐比屋身宽 2px
    形成投影感、门洞挖空（透明）作为唯一细节——16px 上再多细节就糊成一团。
    门洞两侧的屋身仍有 ≥4px 宽度，face() 的距离场不会把它切成零碎面点。
    """
    g = blank()
    blit(g, [
        '................',
        '.......KK.......',
        '......KKKK......',
        '.....KKKKKK.....',
        '....KKKKKKKK....',
        '...KKKKKKKKKK...',
        '..KKKKKKKKKKKK..',
        '.KKKKKKKKKKKKKK.',
        '..KKKKKKKKKKKK..',
        '..KKKKKKKKKKKK..',
        '..KKKKK..KKKKK..',
        '..KKKKK..KKKKK..',
        '..KKKKK..KKKKK..',
        '................',
    ], 0, 0)
    # core 只放屋身：屋顶每行都很薄，出面会碎；门洞把屋身分成左右两半，各自仍够宽
    return face(g, edge=edge, fill=tone, thickness=thickness, core=(3, 8, 12, 12))


# ---------------------------------------------------------------- SVG 输出
def merge_rects(g):
    """贪心最大同色矩形合并，返回 [(x, y, w, h, ch)]。"""
    used = [[False] * W for _ in range(H)]
    out = []
    for y in range(H):
        for x in range(W):
            c = g[y][x]
            if c == '.' or used[y][x]:
                continue
            w = 1
            while x + w < W and g[y][x + w] == c and not used[y][x + w]:
                w += 1
            h = 1
            while y + h < H and all(g[y + h][x + i] == c and not used[y + h][x + i]
                                    for i in range(w)):
                h += 1
            for j in range(h):
                for i in range(w):
                    used[y + j][x + i] = True
            out.append((x, y, w, h, c))
    return out


def to_svg(g, name):
    rects = merge_rects(g)
    by_color = {}
    for (x, y, w, h, c) in rects:
        by_color.setdefault(c, []).append((x, y, w, h))

    # 浅色先画、深色后画：让描边压在上层，相邻像素即便出现抗锯齿缝也不发灰。
    # verify() 已断言矩形互不重叠，故此顺序只影响接缝观感，不影响正确性。
    order = sorted(by_color, key=lambda c: -sum(RGB[c][i] for i in range(3)))

    parts = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" '
             'width="%d" height="%d" shape-rendering="crispEdges">' % (W, H, W, H)]
    for c in order:
        d = ''.join('M%d %dh%dv%dh-%dz' % (x, y, w, h, w) for (x, y, w, h) in by_color[c])
        parts.append('<path fill="%s" d="%s"/>' % (PALETTE[c], d))
    parts.append('</svg>')
    return '\n'.join(parts) + '\n', len(rects)


def parse_svg_grid(path):
    """解析已写出的 SVG 还原字符网格。只认本脚本生成的 `M x y h w v h h -w z` 语法。

    这是防回归的关键：to_svg() 里的矩形合并必须真正落进文件，
    预览也必须来自本函数而非内存中的 rects，否则「预览正常、文件残缺」会被掩盖。
    """
    svg = open(path, encoding='utf-8').read()
    rev = {v: k for k, v in PALETTE.items() if v}
    grid = [['.'] * W for _ in range(H)]
    for fill_hex, d in re.findall(r'<path fill="([^"]+)" d="([^"]+)"/>', svg):
        ch = rev.get(fill_hex)
        if ch is None:
            raise ValueError('未知颜色 %s' % fill_hex)
        for mx, my, mw, mh, _mw2 in re.findall(
                r'M(\d+) (\d+)h(\d+)v(\d+)h-(\d+)z', d):
            x, y, w, h = int(mx), int(my), int(mw), int(mh)
            for j in range(y, y + h):
                for i in range(x, x + w):
                    if 0 <= i < W and 0 <= j < H:
                        grid[j][i] = ch
    return grid


# ---------------------------------------------------------------- PNG 输出
def _chunk(tag, data):
    body = tag + data
    return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xffffffff)


def write_png(path, rgba, w, h):
    raw = b''.join(b'\x00' + bytes(v for px in row for v in px) for row in rgba)
    png = b'\x89PNG\r\n\x1a\n'
    png += _chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += _chunk(b'IDAT', zlib.compress(raw, 9))
    png += _chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


def rasterize(rects):
    """从合并后的矩形（= SVG 的真实几何）还原 32x32 RGBA 缓冲。"""
    buf = [[(0, 0, 0, 0)] * W for _ in range(H)]
    for (x, y, w, h, c) in rects:
        for j in range(y, y + h):
            for i in range(x, x + w):
                buf[j][i] = RGB[c]
    return buf


def upscale(buf, scale, checker=True):
    """整数倍放大；checker=True 时用棋盘格铺底，便于观察透明区。"""
    h, w = len(buf), len(buf[0])
    out = []
    for y in range(h):
        row = []
        for x in range(w):
            r, g, b, a = buf[y][x]
            if a == 0 and checker:
                t = 0xC8 if ((x // 4) + (y // 4)) % 2 == 0 else 0xE8
                r = g = b = t
                a = 255
            row += [(r, g, b, a)] * scale
        for _ in range(scale):
            out.append(list(row))
    return out


def shrink(buf, f):
    """多数票降采样：模拟小尺寸档（16px）的实际观感。"""
    h, w = len(buf), len(buf[0])
    out = []
    for y in range(0, h, f):
        row = []
        for x in range(0, w, f):
            cnt = {}
            for dy in range(f):
                for dx in range(f):
                    c = buf[y + dy][x + dx]
                    cnt[c] = cnt.get(c, 0) + 1
            row.append(max(cnt, key=lambda c: (cnt[c], c[3])))
        out.append(row)
    return out


def preview(g, name):
    """预览一律从 SVG 几何光栅化，保证「预览所见 = SVG 所得」。"""
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    buf = rasterize(merge_rects(g))
    write_png(os.path.join(PREVIEW_DIR, '%s-8x.png' % name), upscale(buf, 8), W * 8, H * 8)
    if H >= 32:
        # 仅 32 档输出 16px 缩略观感（16 档本身就是工具栏目标尺寸，无需再缩）
        small = shrink(buf, 2)                     # 32 -> 16
        write_png(os.path.join(PREVIEW_DIR, '%s-16px-8x.png' % name),
                  upscale(small, 8), len(small[0]) * 8, len(small) * 8)


def verify(g, svg):
    """回读校验：design-spec 7.4 硬约束 + 矩形不重叠。"""
    problems = []
    if '<text' in svg or '<font' in svg:
        problems.append('SVG 含 <text>/<font>（7.4 禁止）')
    if 'viewBox="0 0 %d %d"' % (W, H) not in svg:
        problems.append('viewBox 非 0 0 %d %d' % (W, H))
    if 'shape-rendering="crispEdges"' not in svg:
        problems.append('缺 shape-rendering=crispEdges（缩放会糊）')
    covered = set()
    for (x, y, w, h, c) in merge_rects(g):
        for j in range(y, y + h):
            for i in range(x, x + w):
                if (i, j) in covered:
                    problems.append('矩形重叠于 (%d,%d)' % (i, j))
                covered.add((i, j))
    return problems


def lint_imports():
    """扫描 src 下所有图标 import，强制带 `?no-inline`。

    为什么需要机器来守：Vite 内联 SVG 时产出的 data URI 含单引号，会让 classicy
    注入的 CSS 自定义属性被浏览器**静默丢弃**（style 属性整个消失，页面不报错、
    控制台无输出），纯靠人 review 极易漏掉。这里把 SOP §6.2 变成硬失败。
    """
    problems = []
    src = os.path.join(ROOT, 'src')
    pattern = re.compile(
        r"""from\s+['"](?P<path>[^'"]*assets/icons/(?P<name>[^'"?]+)\.svg)(?P<query>\?[^'"]*)?['"]""")
    seen = 0
    for dirpath, _dirs, files in os.walk(src):
        for fn in sorted(files):
            if not fn.endswith(('.tsx', '.ts')):
                continue
            path = os.path.join(dirpath, fn)
            with open(path, encoding='utf-8') as f:
                text = f.read()
            for m in pattern.finditer(text):
                seen += 1
                query = m.group('query') or ''
                if 'no-inline' not in query:
                    problems.append('%s → import %s 缺少 ?no-inline（当前 %s）'
                                    % (os.path.relpath(path, ROOT).replace('\\', '/'),
                                       m.group('path'), query or '(无查询串)'))
    if seen == 0:
        problems.append('未扫描到任何图标 import，检查 src 目录是否正确')
    return seen, problems


# ---------------------------------------------------------------- 设计稿（pixelart 技能输出）
# 单文件、零依赖：ART 为技能规定的「字符串数组 + 语义调色板」结构，CSS Grid 逐像素渲染。
# 32 档和 16px 降采样档都由本脚本直接 dump，JS 只负责铺格子 —— 设计稿与落盘 SVG 同源。
def shrink_chars(rows, f=2):
    """字符网格的多数票降采样，近似 preview() 里 shrink(buf, 2) 的 16px 观感。"""
    out = []
    for y in range(0, len(rows), f):
        line = ''
        for x in range(0, len(rows[0]), f):
            cnt = {}
            for dy in range(f):
                for dx in range(f):
                    c = rows[y + dy][x + dx]
                    cnt[c] = cnt.get(c, 0) + 1
            def weight(c):
                lum = sum(RGB[c][:3]) if c != '.' else 0
                return (cnt[c], c != '.', lum)
            line += max(cnt, key=weight)
        out.append(line)
    return out


DESIGN_SHEET_TMPL = r'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Files · 图标重设计 · Pixel Art</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    min-height: 100vh; padding: 40px 24px 64px;
    background: #e9e9ee; color: #23232b;
    font: 13px/1.7 ui-monospace, "SFMono-Regular", Consolas, "Microsoft YaHei", monospace;
  }
  .sheet { max-width: 940px; margin: 0 auto; }
  header { border-bottom: 2px solid #23232b; padding-bottom: 14px; margin-bottom: 26px; }
  h1 { font-size: 22px; letter-spacing: .04em; }
  .sub { color: #6a6a78; margin-top: 4px; }
  .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  .card { background: #fafafd; border: 1px solid #c3c3cf; padding: 18px; }
  .card.pick { border: 2px solid #2a62b2; padding: 17px; }
  h2 { font-size: 14px; display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .badge { background: #2a62b2; color: #fff; font-size: 10px; padding: 1px 7px; letter-spacing: .06em; }
  .card p.desc { color: #6a6a78; font-size: 12px; min-height: 40px; }
  .stage-row { display: flex; gap: 18px; align-items: flex-end; margin-top: 14px; }
  .stage-box { text-align: center; }
  .stage { display: grid; image-rendering: pixelated; background: #fff;
    background-image: conic-gradient(#c0c0ca 0 25%, #e2e2ea 0 50%, #c0c0ca 0 75%, #e2e2ea 0);
    background-size: 16px 16px; border: 1px solid #c3c3cf; }
  .stage i { display: block; }
  .cap { color: #6a6a78; font-size: 11px; margin-top: 6px; }
  section.notes { margin-top: 30px; background: #fafafd; border: 1px solid #c3c3cf; padding: 20px 24px; }
  section.notes h3 { font-size: 13px; margin-bottom: 10px; }
  ol { padding-left: 20px; }
  li { margin-bottom: 7px; }
  .rules { margin-top: 18px; border-top: 1px dashed #c3c3cf; padding-top: 14px; color: #50505e; font-size: 12px; }
  code { background: #e6e6ee; padding: 1px 5px; }
  footer { margin-top: 22px; color: #6a6a78; font-size: 11px; }
  @media (max-width: 720px) { .cards { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="sheet">
  <header>
    <h1>Files · 图标重设计</h1>
    <div class="sub">32×32 · string-array pixel art · Mac OS 9 / Platinum · 生成自 tools/pixel-icon.py</div>
  </header>

  <div class="cards">
    <figure class="card pick">
      <h2>新版：经典 macOS 打开文件夹 <span class="badge">已落地</span></h2>
      <p class="desc">小圆角橙黄 tab 只露上沿，大圆角浅黄渐变面板在前；柔和暖色外框，无硬黑边。</p>
      <div class="stage-row">
        <div class="stage-box"><div class="stage" id="new-8x"></div><div class="cap">32px · 8× 放大</div></div>
        <div class="stage-box"><div class="stage" id="new-16"></div><div class="cap">16px 缩略 · 8×</div></div>
      </div>
    </figure>
    <figure class="card">
      <h2>上一版：蓝色梯形打开文件夹</h2>
      <p class="desc">暗蓝后片 + 亮蓝梯形前片的透视画法，靠明度差与敞口线交代「打开」。</p>
      <div class="stage-row">
        <div class="stage-box"><div class="stage" id="old-8x"></div><div class="cap">32px · 8× 放大</div></div>
        <div class="stage-box"><div class="stage" id="old-16"></div><div class="cap">16px 缩略 · 8×</div></div>
      </div>
    </figure>
  </div>

  <section class="notes">
    <h3>改动理由</h3>
    <ol>
      <li><b>按参考图换造型（本轮）</b>：不再用蓝梯形透视，改成小圆角橙黄 tab 在<b>后</b>（<code>x2..16 / y3..13</code>，下部被盖住只露 <code>y3..7</code>）+ 大圆角浅黄面板在<b>前</b>（<code>x1..30 / y8..29</code>，占约 80% 面积）。tab 宽约为面板一半、露出高度约 18%，比例对齐参考图。</li>
      <li><b>柔和渐变代替深色描边</b>：新增 <code>J</code>（#ffc233 橙黄）/ <code>V</code>（#ffeaa8 浅黄）两色；前片顶部一条 <code>W</code> 亮高光 = 敞口线，中部 <code>V</code> 浅黄，底部 <code>y → Y</code> 逐行收窄压深；外框改用暖色 <code>o</code> 而非 <code>K</code> / <code>N</code> 硬黑边。</li>
      <li><b>配色随参考图改为暖黄</b>：桌面语义由「蓝 = Files」变为「暖黄 = Files」。与 Editor 的琥珀笔记本靠形状区分 —— 本版是纯色块 + 圆角，没有书脊 / 绑带 / 书签带。</li>
      <li><b>保留独立主体，无窗口外框</b>：仍不画条纹标题栏与 1px 黑边，文件夹占满画布、四周留 1~3px 透明边，与 watchdog / converter / editor 一致；16px 缩略下「小 tab + 大面板」依旧清楚。</li>
    </ol>
    <div class="rules">
      规范约束（docs/design-spec.md §7.4）：<code>viewBox 0 0 32 32</code>、仅 <code>&lt;path&gt;</code> 无 <code>&lt;text&gt;/&lt;font&gt;</code>、
      <code>shape-rendering="crispEdges"</code>、体积 &lt; 4 KB、光源左上（高光 + 暗边，不加投影）、
      import 必须带 <code>?no-inline</code>。本版按参考图改为暖黄渐变 + 圆角，独立主体无外框。
    </div>
  </section>

  <footer>本页零外部依赖：像素数据内联为 ART（name / width / height / palette / pixels），CSS Grid 逐格渲染。换图标后老用户需清 <code>localStorage.classicyDesktopState</code> 才能看到新图标。</footer>
</div>
<script>
/*__ART__*/
function render(id, art, scale) {
  const el = document.getElementById(id);
  el.style.gridTemplateColumns = 'repeat(' + art.width + ', ' + scale + 'px)';
  el.style.gridAutoRows = scale + 'px';
  const frag = document.createDocumentFragment();
  art.pixels.forEach(function (row) {
    for (const ch of row) {
      const px = document.createElement('i');
      px.style.background = art.palette[ch] || 'transparent';
      frag.appendChild(px);
    }
  });
  el.appendChild(frag);
}
render('new-8x', ART.new32, 8);
render('new-16', ART.new16, 8);
render('old-8x', ART.old32, 8);
render('old-16', ART.old16, 8);
</script>
</body>
</html>
'''


def write_design_sheet(new_g, old_g):
    """把新/旧网格写成自包含 HTML 设计稿（技能 Mode 1 的 ≤48px 输出格式）。"""
    import json
    palette = {k: v for k, v in PALETTE.items() if v and v != 'currentColor'}

    def art(name, rows):
        return {'name': name, 'width': W, 'height': H,
                'palette': palette, 'pixels': rows}

    new_rows = [''.join(r) for r in new_g]
    old_rows = [''.join(r) for r in old_g]
    data = {
        'new32': art('Files · 新版 32x32', new_rows),
        'new16': art('Files · 新版 16px', shrink_chars(new_rows)),
        'old32': art('Files · 旧版 32x32', old_rows),
        'old16': art('Files · 旧版 16px', shrink_chars(old_rows)),
    }
    # 16px 档的 width/height 是 16，渲染器按它铺格子
    data['new16']['width'] = data['new16']['height'] = 16
    data['old16']['width'] = data['old16']['height'] = 16

    html = DESIGN_SHEET_TMPL.replace(
        '/*__ART__*/', 'const ART = ' + json.dumps(data, ensure_ascii=False, indent=2) + ';')
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'files-icon-redesign.html')
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(html)
    return path, len(html)


ICON_SET_TMPL = r'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>桌面图标重设计 · 5 个应用 · Pixel Art</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { min-height: 100vh; padding: 40px 24px 64px; background: #e9e9ee; color: #23232b;
         font: 13px/1.7 ui-monospace, "SFMono-Regular", Consolas, "Microsoft YaHei", monospace; }
  .sheet { max-width: 1000px; margin: 0 auto; }
  header { border-bottom: 2px solid #23232b; padding-bottom: 14px; margin-bottom: 24px; }
  h1 { font-size: 22px; letter-spacing: .04em; }
  .sub { color: #6a6a78; margin-top: 4px; }
  .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  .card { background: #fafafd; border: 1px solid #c3c3cf; padding: 16px; }
  h2 { font-size: 14px; display: flex; align-items: center; gap: 8px; }
  .badge { background: #2a62b2; color: #fff; font-size: 10px; padding: 1px 7px; letter-spacing: .06em; }
  p.desc { color: #50505e; font-size: 12px; margin-top: 4px; }
  .stage-row { display: flex; gap: 14px; align-items: flex-end; margin-top: 12px; }
  .stage-row.old { margin-top: 8px; padding-top: 8px; border-top: 1px dashed #c3c3cf; }
  .stage-box { text-align: center; }
  .stage { display: grid; image-rendering: pixelated; background: #fff;
           background-image: conic-gradient(#c0c0ca 0 25%, #e2e2ea 0 50%, #c0c0ca 0 75%, #e2e2ea 0);
           background-size: 16px 16px; border: 1px solid #c3c3cf; }
  .stage i { display: block; }
  .cap { color: #6a6a78; font-size: 10px; margin-top: 5px; }
  .reason { margin-top: 12px; padding-top: 10px; border-top: 1px dashed #c3c3cf; font-size: 11px; color: #50505e; }
  .oldtext { margin-top: 8px; font-size: 11px; color: #6a6a78; }
  section.rules { margin-top: 26px; background: #fafafd; border: 1px solid #c3c3cf; padding: 18px 22px; }
  section.rules h3 { font-size: 13px; margin-bottom: 8px; }
  section.rules p { font-size: 12px; color: #50505e; }
  code { background: #e6e6ee; padding: 1px 5px; }
  footer { margin-top: 20px; color: #6a6a78; font-size: 11px; }
  @media (max-width: 780px) { .cards { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="sheet">
  <header>
    <h1>桌面图标重设计 · 当前图标集</h1>
    <div class="sub">32×32 · 齿轮 / 笔记本 / 交换箭头 / 文件夹 / 存储盘 / 播放徽章 · Mac OS 9 / Platinum · 生成自 tools/pixel-icon.py</div>
  </header>
  <div class="cards" id="cards"></div>
  <section class="rules">
    <h3>统一规范</h3>
    <p>WatchDog OS（齿轮）、Converter（交换箭头）、Editor（笔记本封面）与 Files（文件夹）用独立主体直接落在透明底上，其余共用同构 Mac OS 9 窗口外框（条纹标题栏 + 1px 黑边 + 右下暗边），
       光源统一左上。关键元素按 2px 栅格对齐偶数坐标，保证 2×2 多数票降采样到 16px 后不糊。
       Converter 的双箭头由同一轮廓镜像叠压，前层整圈描边做前后分层。
       <code>viewBox 0 0 32 32</code>、仅 <code>&lt;path&gt;</code>、
       <code>shape-rendering="crispEdges"</code>、&lt; 4 KB、import 带 <code>?no-inline</code>（docs/design-spec.md §7.4）。</p>
  </section>
  <footer>本页零外部依赖：像素数据内联为 ART（name / width / height / palette / pixels），CSS Grid 逐格渲染。
    换图标后老用户需清 <code>localStorage.classicyDesktopState</code> 才能看到新图标。</footer>
</div>
<script>
/*__ART__*/
function makeStage(art, scale) {
  const el = document.createElement('div');
  el.className = 'stage';
  el.style.gridTemplateColumns = 'repeat(' + art.width + ', ' + scale + 'px)';
  el.style.gridAutoRows = scale + 'px';
  const frag = document.createDocumentFragment();
  art.pixels.forEach(function (row) {
    for (const ch of row) {
      const px = document.createElement('i');
      px.style.background = art.palette[ch] || 'transparent';
      frag.appendChild(px);
    }
  });
  el.appendChild(frag);
  return el;
}
function figure(art, scale, cap) {
  const box = document.createElement('div');
  box.className = 'stage-box';
  box.appendChild(makeStage(art, scale));
  const c = document.createElement('div');
  c.className = 'cap'; c.textContent = cap;
  box.appendChild(c);
  return box;
}
ART.apps.forEach(function (app) {
  const card = document.createElement('figure');
  card.className = 'card';
  const h = document.createElement('h2');
  h.innerHTML = app.name + ' <span class="badge">已落地</span>';
  card.appendChild(h);
  const p = document.createElement('p');
  p.className = 'desc'; p.textContent = app.desc;
  card.appendChild(p);

  const newRow = document.createElement('div');
  newRow.className = 'stage-row';
  newRow.appendChild(figure(app.new32, 6, '新版 32px · 6×'));
  newRow.appendChild(figure(app.new16, 8, '新版 16px · 8×'));
  card.appendChild(newRow);

  if (app.old32) {
    const oldRow = document.createElement('div');
    oldRow.className = 'stage-row old';
    oldRow.appendChild(figure(app.old32, 3, '旧版 32px · 3×'));
    oldRow.appendChild(figure(app.old16, 6, '旧版 16px · 6×'));
    card.appendChild(oldRow);
  } else {
    const t = document.createElement('div');
    t.className = 'oldtext'; t.textContent = '旧版：' + app.old;
    card.appendChild(t);
  }

  const r = document.createElement('div');
  r.className = 'reason'; r.textContent = app.reason;
  card.appendChild(r);
  document.getElementById('cards').appendChild(card);
});
</script>
</body>
</html>
'''


def write_icon_set_sheet(apps):
    """5 个应用的新/旧 32px + 16px 对照总览（单文件、零依赖）。"""
    import json
    palette = {k: v for k, v in PALETTE.items() if v and v != 'currentColor'}

    def art(name, rows, w, h):
        return {'name': name, 'width': w, 'height': h,
                'palette': palette, 'pixels': rows}

    out = []
    for a in apps:
        new_rows = [''.join(r) for r in a['new']]
        item = {
            'name': a['name'], 'key': a['key'], 'desc': a['desc'],
            'old': a['old'], 'reason': a['reason'],
            'new32': art(a['name'] + ' 新版32', new_rows, W, H),
            'new16': art(a['name'] + ' 新版16', shrink_chars(new_rows), 16, 16),
            'old32': None, 'old16': None,
        }
        if a['legacy'] is not None:
            old_rows = [''.join(r) for r in a['legacy']]
            item['old32'] = art(a['name'] + ' 旧版32', old_rows, W, H)
            item['old16'] = art(a['name'] + ' 旧版16', shrink_chars(old_rows), 16, 16)
        out.append(item)

    html = ICON_SET_TMPL.replace(
        '/*__ART__*/',
        'const ART = ' + json.dumps({'apps': out}, ensure_ascii=False) + ';')
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'icons-redesign.html')
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(html)
    return path, len(html)


# ---------------------------------------------------------------- 主流程
def emit(g, name):
    print('=== %s ===' % name)
    print('grid (%dx%d):' % (W, H))
    for row in g:
        print('  ' + ''.join(row))
    colors = sorted({c for row in g for c in row if c != '.'})
    print('colors: %d  ->  %s' % (len(colors), ' '.join(PALETTE[c] for c in colors)))
    xs = [i for i in range(W) if any(g[y][i] != '.' for y in range(H))]
    ys = [j for j in range(H) if any(g[j][i] != '.' for i in range(W))]
    print('bbox: x %d..%d  y %d..%d' % (min(xs), max(xs), min(ys), max(ys)))

    svg, n = to_svg(g, name)
    path = os.path.join(ICON_DIR, name + '.svg')
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(svg)
    size = os.path.getsize(path)
    flag = 'OK' if size < 4096 else 'OVER 4KB'
    print('rects: %d   svg: %d bytes [%s] -> %s' % (n, size, flag, path))
    problems = verify(g, svg)
    print('verify: %s' % ('PASS' if not problems else 'FAIL -> ' + '; '.join(problems)))

    # 回读：解析落盘的 SVG 还原网格，与源网格逐像素比对
    rt = parse_svg_grid(path)
    diff = [(x, y) for y in range(H) for x in range(W) if rt[y][x] != g[y][x]]
    if diff:
        print('roundtrip: FAIL %d px differ, e.g. %s' % (len(diff), diff[:6]))
    else:
        print('roundtrip: PASS (SVG 文件与源网格逐像素一致)')

    # 预览一律来自 SVG 文件本身
    preview(rt, name)
    print()


if __name__ == '__main__':
    os.makedirs(ICON_DIR, exist_ok=True)
    # 32 档：桌面/标题栏图标
    set_size(32)
    emit(build_terminal(), 'terminal')
    emit(build_chat(), 'chat')
    emit(build_docker(), 'docker')
    emit(build_runner(), 'runner')
    emit(build_blog(), 'blog')
    emit(build_audit(), 'audit')
    emit(build_disk(), 'disk')
    emit(build_converter(), 'converter')
    emit(build_editor(), 'editor')
    emit(build_watchdog(), 'watchdog')
    files_new = build_files()
    emit(files_new, 'files')
    # 设计稿必须在 32 档下生成（shrink_chars / ART 的 width、height 读全局 W/H）
    sheet, sheet_size = write_design_sheet(files_new, build_files_open_blue())
    print('design sheet: %d bytes -> %s' % (sheet_size, sheet))
    icon_set = [
        dict(name='Editor', key='editor',
             desc='参考 Chat：无外框，两本笔记本封面前后叠放',
             old='',
             reason='按新版 Converter 的 Chat 式构图重做：去掉窗口外框，后本深蓝偏左上、前本琥珀偏右下重叠 10 行，前本整圈 K 描边框把自己从后层上切出来。封面细节（深棕书脊 + 亮棱、弹性绑带 + 小扣、压印标题线、红书签带）全在前本；后本留 h/m 浮雕与一条白文本线呼应 Chat 气泡。',
             new=build_editor(), legacy=build_editor_v3()),
        dict(name='Converter', key='converter',
             desc='参考 Chat：去掉外框，两个大箭头前后叠放相互交换',
             old='',
             reason='参考 Chat 双气泡构图：去掉 Mac OS 9 窗口外框，主体直接落在透明底上。后箭头偏左上（蓝 →）、前箭头偏右下（琥珀 ←）错开叠压，前层用整圈描边把自己从后层上切出来，和 Chat 前白气泡压后蓝气泡同一手法。两条由同一 14 行轮廓水平镜像 + 下移 8 行生成，头分落右上/左下绕中心互换；柄上 1px 文本线呼应 Chat 气泡。',
             new=build_converter(), legacy=build_converter_v4()),
        dict(name='Runner', key='runner',
             desc='绿色圆形播放徽章 + 任务日志行 + 底部进度条',
             old='沿用上一轮设计（本轮未改动）',
             reason='本轮 4 个指定风格不含 Runner，保持上一轮成果，放在这里凑齐全套图标集对照。',
             new=build_runner(), legacy=None),
        dict(name='Disks', key='disk',
             desc='存储盘：大圆盘 + 环形容量弧 + 中心主轴',
             old='',
             reason='「存储盘风格」要一眼是「盘」：占满内容区的大圆盘，外圈 P 绿 / M 灰容量弧（绿约 65% 已用，呼应挂载点使用率），中心 S 深色主轴。金属反光按左上 W / 右下 M，不与 audit 的放大镜撞。',
             new=build_disk(), legacy=build_disk_v2()),
        dict(name='WatchDog OS', key='watchdog',
             desc='齿轮风格：独立 8 齿钢灰齿轮 + 中心绿运行灯',
             old='',
             reason='主应用改用独立齿轮主体，刻意不套窗口 —— 齿轮占满画布才撑得住 16px 与登录页小尺寸 logo（chat / docker 已有先例）。8 根方头齿沿 45° 伸出，bevel 左上高光 / 右下暗部，轴孔里一颗绿点 = 看门狗在运行。',
             new=build_watchdog(), legacy=build_watchdog_v2()),
        dict(name='Files', key='files',
             desc='参考 macOS 经典打开文件夹：小橙黄 tab + 大圆角浅黄面板',
             old='',
             reason='按用户给的参考图重做：不再用蓝梯形透视，改成小圆角橙黄 tab 只露上沿在后、大圆角浅黄渐变面板占约 80% 面积在前，两层之间一条 W 亮敞口线；外框改用暖色 o 而非 K 硬黑边。配色随参考图改为暖黄（新增 J / V 两色），桌面语义由「蓝 = Files」变为「暖黄 = Files」，与 Editor 琥珀笔记本靠形状区分（本版纯色块 + 圆角，无书脊 / 绑带 / 书签带）。',
             new=files_new, legacy=build_files_open_blue()),
    ]
    set_sheet, set_sheet_size = write_icon_set_sheet(icon_set)
    print('icon set sheet: %d bytes -> %s\n' % (set_sheet_size, set_sheet))
    # 16 档：窗口操作按钮带内嵌图标（Back / Up / Favorites，见 icon-pipeline.md §1.2）
    set_size(16)
    emit(build_fm_back(), 'fm-back')
    emit(build_fm_up(), 'fm-up')
    emit(build_fm_fav(), 'fm-fav')
    # 16 档：移动外壳「返回首页」悬浮键（手机布局，见 docs/mobile-adaptation.md）
    emit(build_home(), 'home')
    print('preview dir: %s' % PREVIEW_DIR)

    seen, problems = lint_imports()
    print('')
    if problems:
        print('imports: FAIL（扫描 %d 处）' % seen)
        for p in problems:
            print('  - ' + p)
        print('\n图标 import 必须带 ?no-inline，否则 classicy 桌面遮罩会静默失效（见 docs/icon-pipeline.md §6.2）')
        sys.exit(1)
    print('imports: PASS（%d 处图标 import 全部带 ?no-inline）' % seen)
