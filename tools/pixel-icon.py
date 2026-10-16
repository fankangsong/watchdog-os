#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
像素图标生成器 —— 按 skills/pixelart 技能的 ≤48px 规范工作。

流程：语义调色板 + 32x32 字符网格 -> 贪心最大同色矩形合并 -> 单色 <path> SVG
      同时输出 8x PNG 预览（含棋盘格透明底），用于自检迭代。

产物：
  src/assets/icons/terminal.svg   32x32, viewBox="0 0 32 32", crispEdges, 仅 <path>
  src/assets/icons/chat.svg       同上
  tools/pixel-icon/preview/*.png   预览（非交付物，可删）

约束（docs/design-spec.md 7.4）：
  - viewBox 0 0 32 32，与 classicy 内置桌面/标题栏图标同档（实测 32x32 PNG）
  - 禁用 <text>/<font>，字符一律 <path>
  - 靠浮雕高光（顶/左）与暗边（下/右）做 Mac OS 9 的 3D 感，不加投影
  - 体积 < 4 KB，便于 Vite 内联为 data URI

零依赖：PNG 编码器用标准库 zlib + struct 手写。
"""

import os
import re
import struct
import zlib

W = H = 32
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
}

# 换算成 RGB
RGB = {}
for _k, _v in PALETTE.items():
    if _v is None:
        RGB[_k] = (0, 0, 0, 0)
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

    parts = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" '
             'width="32" height="32" shape-rendering="crispEdges">']
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
    small = shrink(buf, 2)                     # 32 -> 16
    write_png(os.path.join(PREVIEW_DIR, '%s-16px-8x.png' % name),
              upscale(small, 8), len(small[0]) * 8, len(small) * 8)


def verify(g, svg):
    """回读校验：design-spec 7.4 硬约束 + 矩形不重叠。"""
    problems = []
    if '<text' in svg or '<font' in svg:
        problems.append('SVG 含 <text>/<font>（7.4 禁止）')
    if 'viewBox="0 0 32 32"' not in svg:
        problems.append('viewBox 非 0 0 32 32')
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
    emit(build_terminal(), 'terminal')
    emit(build_chat(), 'chat')
    print('preview dir: %s' % PREVIEW_DIR)
