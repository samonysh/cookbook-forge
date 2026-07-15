from playwright.sync_api import sync_playwright
import os, sys

OUT = os.path.join(os.path.dirname(__file__), "screenshots")
os.makedirs(OUT, exist_ok=True)

PAGES = [
    ("/zh", "01-home.png"),
    ("/zh/ch01-basics", "02-ch01-basics.png"),
    ("/zh/ch02-advanced", "03-ch02-advanced.png"),
    ("/zh/appendix-a", "04-appendix-a.png"),
]

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={"width": 1280, "height": 900}, device_scale_factor=2)
    page = ctx.new_page()
    for path, fname in PAGES:
        url = f"http://localhost:3939{path}"
        print(f"GET {url}")
        page.goto(url, wait_until="networkidle")
        page.wait_for_timeout(800)
        out_path = os.path.join(OUT, fname)
        page.screenshot(path=out_path, full_page=True)
        print(f"  -> {out_path}")
    browser.close()
print("done")
