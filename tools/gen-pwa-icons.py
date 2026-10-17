#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PWA 图标生成器 —— 把「看门狗徽章」像素画输出为各尺寸 PNG。

与 tools/pixel-icon.py 同一思路（语义调色板 + 网格 + 浮雕/描边），但目标不同：
pixel-icon.py 产 32/16 档 SVG 给桌面/标题栏用；本脚本产 PWA 需要的 PNG
（manifest 图标、apple-touch-icon），要求满底色（无透明区）——Android 启动器
与 iOS 会按各自的遮罩裁剪，透明角会露出 background_color 形成难看的补丁。

产物（相对项目根）：
  pwa/icons/icon-192.png           192x192  常规（any）
  pwa/icons/icon-512.png           512x512  常规（any）
  pwa/icons/icon-maskable-512.png  512x512  可遮罩（maskable，图案收缩进安全区）
  pwa/icons/apple-touch-icon.png   180x180  iOS 主屏图标

设计：32 档网格，2x 超采样抗锯齿后按多数表决降采；配色沿用 favicon.png 的
蓝家族（#7D9EEC 底 + 藏青狗 + 红色项圈），保持品牌一致。

零依赖：PNG 编码用标准库 zlib + struct 手写（RGBA8，filter 0）。
用法：python3 tools/gen-pwa-icons.py [--ascii]
"""

import os
import struct
import sys
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'pwa', 'icons')

# ---------------------------------------------------------------- 调色板
# 字符仅用于内部网格，最终都换算成 RGB
PALETTE = {
    'b': (0x7D, 0x9E, 0xEC),  # 徽章底：favicon 蓝
    'n': (0x2A, 0x37, 0x68),  # 狗头：藏青
    'e': (0x1B, 0x26, 0x50),  # 耳朵：藏青暗部（与头分层）
    'o': (0x14, 0x1C, 0x3C),  # 描边：近黑藏青（Mac OS 9 贴纸感）
    'w': (0xFF, 0xFF, 0xFF),  # 口鼻/眼睛高光
    'r': (0xE0, 0x52, 0x52),  # 项圈
    'g': (0xF2, 0xC9, 0x4C),  # 项圈牌
}

GRID = 32   # 逻辑网格（32 档，与桌面图标同档）
S = 2       # 超采样倍率（内部 64x64，降采时多数表决平滑边缘）
W = H = GRID * S


# ---------------------------------------------------------------- 网格绘制
def blank(ch='b'):
    return [[ch] * W for _ in range(H)]


def ellipse(g, cx, cy, rx, ry, c):
    """实心椭圆（坐标/半径为 32 档单位，内部按 S 超采样）。"""
    for y in range(H):
        for x in range(W):
            px, py = (x + 0.5) / S, (y + 0.5) / S
            if ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1.0:
                g[y][x] = c


def rrect(g, x0, y0, x1, y1, r, c):
    """圆角矩形（x0..y1 为 32 档单位上的外沿坐标，含端点的单元格填充）。"""
    for y in range(H):
        for x in range(W):
            px, py = (x + 0.5) / S, (y + 0.5) / S
            if not (x0 - 0.5 <= px <= x1 + 0.5 and y0 - 0.5 <= py <= y1 + 0.5):
                continue
            dx = max(x0 + r - px, px - (x1 - r), 0.0)
            dy = max(y0 + r - py, py - (y1 - r), 0.0)
            if dx * dx + dy * dy <= r * r:
                g[y][x] = c


def cells(g, x0, y0, x1, y1, c):
    """整数单元格填充（含端点，用于眼睛/鼻子这类硬边像素）。"""
    for y in range(int(y0 * S), int((y1 + 1) * S)):
        for x in range(int(x0 * S), int((x1 + 1) * S)):
            if 0 <= y < H and 0 <= x < W:
                g[y][x] = c


def outline(g, subjects, line_c):
    """给 subject 字符的实心区描边：仅把相邻的底色格染成描边色（贴纸感）。"""
    add = set()
    for y in range(H):
        for x in range(W):
            if g[y][x] in subjects:
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < W and 0 <= ny < H and g[ny][nx] == 'b':
                        add.add((nx, ny))
    for x, y in add:
        g[y][x] = line_c


def draw_badge():
    """32 档看门狗徽章：垂耳狗头 + 白口鼻 + 红项圈金牌，满蓝底。"""
    g = blank('b')
    # 耳朵（先画，头部椭圆盖住贴合部分，只露顶部两角）
    rrect(g, 4, 5, 8, 18, 1.5, 'e')
    rrect(g, 23, 5, 27, 18, 1.5, 'e')
    # 头
    ellipse(g, 16, 17.5, 10, 9, 'n')
    # 白口鼻
    ellipse(g, 16, 22.5, 5, 3.6, 'w')
    # 鼻子（口鼻上部，圆角小横条）
    rrect(g, 15, 20, 17, 21.5, 0.8, 'n')
    # 嘴：鼻下一竖 + 两侧点
    cells(g, 16, 22, 16, 23, 'n')
    cells(g, 15, 24, 15, 24, 'n')
    cells(g, 17, 24, 17, 24, 'n')
    # 眼睛：白色 2x2 + 下内角瞳孔
    cells(g, 10, 15, 11, 16, 'w')
    cells(g, 20, 15, 21, 16, 'w')
    cells(g, 11, 16, 11, 16, 'n')
    cells(g, 20, 16, 20, 16, 'n')
    # 项圈横带（横过低区，略宽于下颌）+ 金牌
    rrect(g, 9, 24.5, 23, 26, 0.6, 'r')
    ellipse(g, 16, 25.2, 1.7, 1.7, 'g')
    # 统一深色描边（不含白色区——白在藏青上已足够亮）
    outline(g, ('n', 'e', 'r', 'g'), 'o')
    return g


# ---------------------------------------------------------------- 缩放与编码
def downsample(g, target):
    """多数表决降采样（内部 W -> target）。用于常规 32 档与 maskable 收缩。"""
    ratio = W / target
    out = []
    for ty in range(target):
        row = []
        for tx in range(target):
            y0, y1 = int(ty * ratio), max(int((ty + 1) * ratio), int(ty * ratio) + 1)
            x0, x1 = int(tx * ratio), max(int((tx + 1) * ratio), int(tx * ratio) + 1)
            counts = {}
            for y in range(y0, min(y1, H)):
                for x in range(x0, min(x1, W)):
                    counts[g[y][x]] = counts.get(g[y][x], 0) + 1
            row.append(max(counts, key=counts.get))
        out.append(row)
    return out


def pad_center(g, size, ch='b'):
    """把网格居中补到 size（maskable 用：图案收缩后四周留安全边）。"""
    n = len(g)
    off = (size - n) // 2
    return [[ch] * size for _ in range(off)] + [
        [ch] * off + row + [ch] * (size - n - off) for row in g
    ] + [[ch] * size for _ in range(size - n - off)]


def upscale(g, size):
    """最近邻放大到 size（像素画保持硬边）。"""
    n = len(g)
    px = []
    for y in range(size):
        sy = min(y * n // size, n - 1)
        row = []
        for x in range(size):
            sx = min(x * n // size, n - 1)
            r, gg, b = PALETTE[g[sy][sx]]
            row.append((r, gg, b, 255))
        px.append(row)
    return px


def write_png(path, pixels, w, h):
    raw = bytearray()
    for y in range(h):
        raw.append(0)  # filter: None
        for x in range(w):
            raw += bytes(pixels[y][x])

    def chunk(typ, data):
        return (
            struct.pack('>I', len(data))
            + typ
            + data
            + struct.pack('>I', zlib.crc32(typ + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)  # 8bit RGBA
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(chunk(b'IHDR', ihdr))
        f.write(chunk(b'IDAT', zlib.compress(bytes(raw), 9)))
        f.write(chunk(b'IEND', b''))


def ascii_dump(g, title):
    print('--- %s (%dx%d) ---' % (title, len(g[0]), len(g)))
    for row in g:
        print(''.join(row))


def main():
    show = '--ascii' in sys.argv
    os.makedirs(OUT_DIR, exist_ok=True)

    hi = draw_badge()                       # 64x64 超采样
    regular = downsample(hi, GRID)          # 32x32 常规图案
    # maskable：缩到 20 档（约 62%）再居中补回 32，保证图案全在中心 80% 安全圆内
    maskable = pad_center(downsample(hi, 20), GRID)

    if show:
        ascii_dump(regular, 'regular 32')
        ascii_dump(maskable, 'maskable 32')

    jobs = [
        ('icon-192.png', regular, 192),
        ('icon-512.png', regular, 512),
        ('icon-maskable-512.png', maskable, 512),
        ('apple-touch-icon.png', regular, 180),
    ]
    for name, grid, size in jobs:
        path = os.path.join(OUT_DIR, name)
        write_png(path, upscale(grid, size), size, size)
        print('wrote %s (%dx%d)' % (path, size, size))


if __name__ == '__main__':
    main()
