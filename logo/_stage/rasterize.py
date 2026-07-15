"""Rasterize CookbookForge master SVG at multiple sizes using Pillow.

Path is straight-line only (M/L/V/Z), so we parse sub-paths and fill polygons.
The nonzero fill rule is approximated here (no nested holes in our design).
"""
from __future__ import annotations
import re
import sys
from pathlib import Path
from PIL import Image, ImageDraw

MASTER = Path(__file__).resolve().parent / "master-24.svg"
OUT = Path(__file__).resolve().parent / "png"
COLOR_OUT = Path(__file__).resolve().parent / "color-png"
BRAND = "#D97706"

PATH_RE = re.compile(r'<path\s+d="([^"]+)"')
CMD_RE = re.compile(r"([MmLlVvHhZzCcSsQqTtAa])([^MmLlVvHhZzCcSsQqTtAa]*)")
NUM_RE = re.compile(r"-?\d*\.?\d+")


def parse_path(d: str):
    polys = []
    cur = []
    cx = cy = 0.0
    sx = sy = 0.0
    for m in CMD_RE.finditer(d):
        cmd = m.group(1)
        nums = [float(x) for x in NUM_RE.findall(m.group(2))]
        if cmd == "M":
            if cur:
                polys.append(cur)
            cx, cy = nums[0], nums[1]
            sx, sy = cx, cy
            cur = [(cx, cy)]
            i = 2
            while i + 1 < len(nums):
                cx, cy = nums[i], nums[i + 1]
                cur.append((cx, cy))
                i += 2
        elif cmd == "m":
            if cur:
                polys.append(cur)
            cx += nums[0]; cy += nums[1]
            sx, sy = cx, cy
            cur = [(cx, cy)]
            i = 2
            while i + 1 < len(nums):
                cx += nums[i]; cy += nums[i + 1]
                cur.append((cx, cy))
                i += 2
        elif cmd == "L":
            for i in range(0, len(nums), 2):
                cx, cy = nums[i], nums[i + 1]
                cur.append((cx, cy))
        elif cmd == "l":
            for i in range(0, len(nums), 2):
                cx += nums[i]; cy += nums[i + 1]
                cur.append((cx, cy))
        elif cmd == "V":
            for v in nums:
                cy = v
                cur.append((cx, cy))
        elif cmd == "v":
            for v in nums:
                cy += v
                cur.append((cx, cy))
        elif cmd == "H":
            for v in nums:
                cx = v
                cur.append((cx, cy))
        elif cmd == "h":
            for v in nums:
                cx += v
                cur.append((cx, cy))
        elif cmd in ("Z", "z"):
            cx, cy = sx, sy
            cur.append((cx, cy))
            polys.append(cur)
            cur = []
    if cur:
        polys.append(cur)
    return polys


def render(size: int, fill: str, bg: str | None) -> Image.Image:
    if bg is None:
        img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    else:
        img = Image.new("RGBA", (size, size), bg)
    draw = ImageDraw.Draw(img)
    polys = parse_path(PATH_RE.search(MASTER.read_text(encoding="utf-8")).group(1))
    scale = size / 24.0
    for poly in polys:
        pts = [(x * scale, y * scale) for x, y in poly]
        draw.polygon(pts, fill=fill)
    return img


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    COLOR_OUT.mkdir(parents=True, exist_ok=True)
    sizes = [16, 24, 32, 64, 128, 256, 512]
    for s in sizes:
        render(s, (0, 0, 0, 255), None).save(OUT / f"logo-{s}.png")
        render(s, BRAND, None).save(COLOR_OUT / f"logo-{s}.png")
        print(f"png {s} -> {OUT / f'logo-{s}.png'}")


if __name__ == "__main__":
    main()
