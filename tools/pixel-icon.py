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
  src/assets/icons/runner.svg     同上
  src/assets/icons/blog.svg       同上（窗口 + 白纸文本行 + 铅笔）
  src/assets/icons/audit.svg      同上（窗口 + 日志纸 + 结果标记 + 放大镜）
  src/assets/icons/fm-back.svg    16x16, viewBox="0 0 16 16"（窗口操作按钮带内嵌图标）
  src/assets/icons/fm-up.svg      同上
  src/assets/icons/fm-fav.svg     同上
  tools/pixel-icon/preview/*.png   预览（非交付物，可删）

约束（docs/design-spec.md 7.4）：
  - 32 档：viewBox 0 0 32 32，与 classicy 内置桌面/标题栏图标同档（实测 32x32 PNG）
  - 16 档：viewBox 0 0 16 16，工具栏图标档（按钮内嵌图标 1:1 渲染，见 icon-pipeline.md §1.2）
  - 禁用 <text>/<font>，字符一律 <path>
  - 靠浮雕高光（顶/左）与暗边（下/右）做 Mac OS 9 的 3D 感，不加投影
  - 体积 < 4 KB，便于 Vite 内联为 data URI

零依赖：PNG 编码器用标准库 zlib + struct 手写。
"""

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


def build_runner():
    """Runner：Mac OS 9 窗口 + 绿色播放键 + 日志行（脚本任务构建）。"""
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
