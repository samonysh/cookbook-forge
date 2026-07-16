"""Render all .puml files to SVG using Docker PlantUML with CJK font support."""
import subprocess
import sys
from pathlib import Path

DIAGRAM_DIR = Path(r"c:\Users\13961\.trae-cn\worktrees\cookbook-forge\feat-optimize-project-logo-o3NJWC\assets\diagrams")

puml_files = sorted(DIAGRAM_DIR.glob("*.puml"))

for puml in puml_files:
    print(f"\n--- Rendering {puml.name} ---")

    docker_cmd = [
        "docker", "run", "--rm",
        "-v", f"{DIAGRAM_DIR}:/work",
        "-v", "C:\\Windows\\Fonts:/usr/share/fonts:ro",
        "plantuml/plantuml:latest",
        "-tsvg", "-charset", "UTF-8",
        f"/work/{puml.name}"
    ]

    result = subprocess.run(docker_cmd, capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        print(f"ERROR: {result.stderr}")
        sys.exit(1)
    else:
        svg_name = puml.stem + ".svg"
        svg_path = DIAGRAM_DIR / svg_name
        if svg_path.exists():
            print(f"  OK -> {svg_name}")
        else:
            print(f"  WARNING: {svg_name} not found after render")

print("\n--- All renders complete ---")
