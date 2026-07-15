"""Build a review sheet PNG like render_previews.py but using the Pillow rasterizer."""
from __future__ import annotations
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from rasterize import render  # noqa: E402

SIZES = [32, 64, 128, 256, 512]
OUT = HERE / "_review.png"


def main():
    W, H = 1200, 900
    sheet = Image.new("RGB", (W, H), "#EEEEEE")
    draw = ImageDraw.Draw(sheet)
    tile_w = W // len(SIZES)

    for row, (bg,) in enumerate([("#FFFFFF",), ("#111111",)]):
        y = row * 250 + 20
        for i, s in enumerate(SIZES):
            box = Image.new("RGB", (tile_w - 20, 220), bg)
            if row == 0:
                png = render(s, (0, 0, 0, 255), None).convert("RGBA")
            else:
                png = render(s, (255, 255, 255, 255), None).convert("RGBA")
            box.paste(png, ((tile_w - 20 - s) // 2, (220 - s) // 2), png)
            sheet.paste(box, (i * tile_w + 10, y))
            draw.text((i * tile_w + 12, y + 222), f"{s}px", fill="#333")

    # Row 3 - app icon frame + grid overlay
    y = 520
    app = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
    mask = Image.new("L", (256, 256), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, 255, 255], radius=56, fill=255)
    frame = Image.new("RGB", (256, 256), "#D97706")
    frame.putalpha(mask)
    png = render(200, (255, 255, 255, 255), None).convert("RGBA")
    app.paste(frame, (0, 0), frame)
    app.paste(png, ((256 - 200) // 2, (256 - 200) // 2), png)
    sheet.paste(app, (40, y), app)
    draw.text((40, y + 260), "App-icon (256, amber rounded square)", fill="#333")

    big = render(512, (0, 0, 0, 255), None).convert("RGBA")
    canvas = Image.new("RGB", (512, 512), "#FFFFFF")
    canvas.paste(big, (0, 0), big)
    dd = ImageDraw.Draw(canvas)
    for i in range(0, 513, 512 // 24):
        dd.line([(i, 0), (i, 512)], fill=(220, 220, 220), width=1)
        dd.line([(0, i), (512, i)], fill=(220, 220, 220), width=1)
    dd.line([(256, 0), (256, 512)], fill=(255, 100, 100), width=1)
    dd.line([(0, 256), (512, 256)], fill=(255, 100, 100), width=1)
    sheet.paste(canvas.resize((320, 320)), (400, y))
    draw.text((400, y + 322), "24x24 grid overlay (center in red)", fill="#333")

    sheet.save(OUT, "PNG")
    print(f"[review] wrote {OUT}")


if __name__ == "__main__":
    main()
