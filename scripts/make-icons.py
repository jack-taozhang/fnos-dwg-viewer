"""
生成 fnOS 应用图标（纯标准库，无第三方依赖）。

输出：
  fnos-package/ICON.PNG            64x64   （应用包图标）
  fnos-package/ICON_256.PNG        256x256
  fnos-package/app/ui/images/icon_64.png    （桌面入口 / 文件打开方式图标）
  fnos-package/app/ui/images/icon_256.png

图形：圆角矩形底 + 白色 CAD 几何（圆 + 方框），符合飞牛"圆角、留白"的图标规范。
"""
import math
import pathlib
import struct
import zlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
PKG = ROOT / "fnos-package"

# ---------- PNG 编码 ----------


def write_png(path: pathlib.Path, width: int, height: int, pixels: bytearray) -> None:
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)  # filter type: None
        raw += pixels[y * stride : (y + 1) * stride]

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)


# ---------- 几何工具 ----------


def rounded_rect_sdf(x, y, cx, cy, hw, hh, r):
    """圆角矩形有向距离（<0 在内部）。"""
    qx = abs(x - cx) - (hw - r)
    qy = abs(y - cy) - (hh - r)
    ax, ay = max(qx, 0.0), max(qy, 0.0)
    return math.hypot(ax, ay) + min(max(qx, qy), 0.0) - r


def ring_sdf(x, y, cx, cy, radius, half_width):
    """圆环有向距离。"""
    return abs(math.hypot(x - cx, y - cy) - radius) - half_width


def segment_sdf(x, y, ax, ay, bx, by, half_width):
    """线段有向距离。"""
    px, py = x - ax, y - ay
    bx_, by_ = bx - ax, by - ay
    denom = bx_ * bx_ + by_ * by_
    t = 0.0 if denom == 0 else max(0.0, min(1.0, (px * bx_ + py * by_) / denom))
    return math.hypot(px - bx_ * t, py - by_ * t) - half_width


TOP = (0x3B, 0x82, 0xF6)
BOTTOM = (0x1D, 0x4E, 0xD8)
WHITE = (0xFF, 0xFF, 0xFF)


def render(size: int, ss: int = 4) -> bytearray:
    """ss 倍超采样后再降采样，得到平滑边缘。"""
    n = size * ss
    buf = bytearray(size * size * 4)

    # 归一化坐标（0..1）
    inv = 1.0 / (n - 1)

    accent = bytearray(n * n)  # 前景覆盖率
    cover = bytearray(n * n)  # 背景覆盖率

    for j in range(n):
        y = j * inv
        for i in range(n):
            x = i * inv
            idx = j * n + i

            # 背景圆角矩形：留 3% 边距，圆角半径 0.21
            d = rounded_rect_sdf(x, y, 0.5, 0.5, 0.47, 0.47, 0.21)
            c = 1.0 if d < 0 else 0.0
            cover[idx] = int(c * 255)

            # 前景：圆 + 方框（CAD 几何）
            d1 = ring_sdf(x, y, 0.395, 0.395, 0.175, 0.038)
            d2 = rounded_rect_sdf(x, y, 0.615, 0.615, 0.19, 0.19, 0.0)
            d2 = abs(d2) - 0.038
            a = 1.0 if (d1 < 0 or d2 < 0) else 0.0
            accent[idx] = int(a * 255)

    # 降采样
    total = ss * ss
    for j in range(size):
        for i in range(size):
            cov_sum = 0
            acc_sum = 0
            for dj in range(ss):
                row = (j * ss + dj) * n
                for di in range(ss):
                    k = row + i * ss + di
                    cov_sum += cover[k]
                    acc_sum += accent[k]
            cov = cov_sum / total / 255.0
            acc = acc_sum / total / 255.0

            # 垂直渐变的底色
            t = j / (size - 1)
            base = (
                TOP[0] + (BOTTOM[0] - TOP[0]) * t,
                TOP[1] + (BOTTOM[1] - TOP[1]) * t,
                TOP[2] + (BOTTOM[2] - TOP[2]) * t,
            )
            # 前景叠加白色
            r = base[0] + (WHITE[0] - base[0]) * acc
            g = base[1] + (WHITE[1] - base[1]) * acc
            b = base[2] + (WHITE[2] - base[2]) * acc

            o = (j * size + i) * 4
            buf[o] = int(r + 0.5)
            buf[o + 1] = int(g + 0.5)
            buf[o + 2] = int(b + 0.5)
            buf[o + 3] = int(cov * 255 + 0.5)

    return buf


def main() -> None:
    for size in (256, 64):
        pixels = render(size)
        ui_name = f"icon_{size}.png"
        write_png(PKG / "app" / "ui" / "images" / ui_name, size, size, pixels)
        print(f"已生成 app/ui/images/{ui_name}")

    # 包图标固定文件名
    write_png(PKG / "ICON.PNG", 64, 64, render(64))
    write_png(PKG / "ICON_256.PNG", 256, 256, render(256))
    print("已生成 ICON.PNG / ICON_256.PNG")


if __name__ == "__main__":
    main()
