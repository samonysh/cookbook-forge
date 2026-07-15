"""Generate favicon.ico (multi-size) from logo PNGs."""
from pathlib import Path
from PIL import Image

HERE = Path(__file__).resolve().parent.parent
STAGE = HERE / "_stage"
FAV = HERE / "favicon"
FAV.mkdir(parents=True, exist_ok=True)

sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64)]
images = []
for s in sizes:
    p = STAGE / "png" / f"logo-{s[0]}.png"
    img = Image.open(p).convert("RGBA")
    if img.size != s:
        img = img.resize(s, Image.LANCZOS)
    images.append(img)

ico_path = FAV / "favicon.ico"
images[0].save(
    ico_path,
    format="ICO",
    sizes=sizes,
    append_images=images[1:],
)
print(f"wrote {ico_path}")
