"""生成一张用于自测的 DXF 示例图（R12 格式，纯文本）。

用途：验证"列表 → 打开 → 渲染"整条链路是否通畅。
真实图纸请直接把 .dwg / .dxf 放进配置好的目录。
"""
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "sample" / "sample-plan.dxf"

W, H = 8000.0, 6000.0
T = 200.0  # 墙厚


def line(layer, x1, y1, x2, y2):
    return [("0", "LINE"), ("8", layer), ("10", f"{x1}"), ("20", f"{y1}"),
            ("11", f"{x2}"), ("21", f"{y2}")]


def circle(layer, cx, cy, r):
    return [("0", "CIRCLE"), ("8", layer), ("10", f"{cx}"), ("20", f"{cy}"), ("40", f"{r}")]


def arc(layer, cx, cy, r, a1, a2):
    return [("0", "ARC"), ("8", layer), ("10", f"{cx}"), ("20", f"{cy}"),
            ("40", f"{r}"), ("50", f"{a1}"), ("51", f"{a2}")]


def text(layer, x, y, h, value):
    return [("0", "TEXT"), ("8", layer), ("10", f"{x}"), ("20", f"{y}"),
            ("40", f"{h}"), ("1", value)]


entities = []

# 外墙（双线，简化为矩形 + 内偏移）
entities += [
    line("WALL", 0, 0, W, 0),
    line("WALL", W, 0, W, H),
    line("WALL", W, H, 0, H),
    line("WALL", 0, H, 0, 0),
    line("WALL", T, T, W - T, T),
    line("WALL", W - T, T, W - T, H - T),
    line("WALL", W - T, H - T, T, H - T),
    line("WALL", T, H - T, T, T),
]

# 隔墙 + 门洞
entities += [
    line("WALL", 4200, T, 4200, 3200),
    line("WALL", 4200, 3900, 4200, H - T),
    arc("DOOR", 4200, 3200, 700, 0, 90),
    line("DOOR", 4200, 3900, 4900, 3900),
]

# 窗
entities += [
    line("WINDOW", 1500, H - T, 3000, H - T),
    line("WINDOW", 1500, H, 3000, H),
    line("WINDOW", 2200, H - T, 2200, H),
]

# 一些设备/家具示意
entities += [
    circle("FURNITURE", 1800, 1600, 900),
    circle("FURNITURE", 1800, 1600, 500),
    line("FURNITURE", 5600, 1000, 7400, 1000),
    line("FURNITURE", 7400, 1000, 7400, 2200),
    line("FURNITURE", 7400, 2200, 5600, 2200),
    line("FURNITURE", 5600, 2200, 5600, 1000),
]

entities += [
    text("TEXT", 200, H + 400, 300, "SAMPLE FLOOR PLAN - fnos-dwg-viewer"),
    text("TEXT", 700, 3400, 260, "LIVING ROOM"),
    text("TEXT", 4600, 4600, 260, "BEDROOM"),
]

LAYERS = [("0", 7), ("WALL", 1), ("DOOR", 3), ("WINDOW", 5), ("FURNITURE", 4), ("TEXT", 2)]

out = []
a = out.append


def tag(code, value):
    a(str(code))
    a(str(value))


tag(0, "SECTION"); tag(2, "HEADER")
tag(9, "$ACADVER"); tag(1, "AC1009")
tag(9, "$INSUNITS"); tag(70, 4)  # 毫米
tag(9, "$LIMMIN"); tag(10, "0.0"); tag(20, "0.0")
tag(9, "$LIMMAX"); tag(10, f"{W}"); tag(20, f"{H}")
# 图纸范围：查看器打开时按这个范围自动缩放到合适视图
tag(9, "$EXTMIN"); tag(10, "-500.0"); tag(20, "-500.0"); tag(30, "0.0")
tag(9, "$EXTMAX"); tag(10, f"{W + 500}"); tag(20, f"{H + 900}"); tag(30, "0.0")
tag(0, "ENDSEC")

tag(0, "SECTION"); tag(2, "TABLES")
tag(0, "TABLE"); tag(2, "LAYER"); tag(70, len(LAYERS))
for name, color in LAYERS:
    tag(0, "LAYER")
    tag(2, name)
    tag(70, 0)
    tag(62, color)
    tag(6, "CONTINUOUS")
tag(0, "ENDTAB")
tag(0, "ENDSEC")

tag(0, "SECTION"); tag(2, "ENTITIES")
for ent in entities:
    for code, value in ent:
        tag(code, value)
tag(0, "ENDSEC")
tag(0, "EOF")

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text("\n".join(out) + "\n", encoding="utf-8")
print(f"已生成 {OUT.relative_to(ROOT)}（{len(entities)} 个实体）")
