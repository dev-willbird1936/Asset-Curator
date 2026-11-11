# CC0 starter spec; SpriteKiln renderer is MIT. No showcase assets are included.
import importlib.util
import json
from shutil import copyfile
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parent
if importlib.util.find_spec("spritekiln") is None:
    raise SystemExit("SpriteKiln runtime missing. Install the pinned requirements in your chosen environment; nothing was installed automatically.")
# Render an actual atlas and animation, not --draft (which makes previews only).
subprocess.run([sys.executable, "-m", "spritekiln", "render", str(root / "model.yaml"),
                "--anims", "idle", "--dirs", "s", "--jobs", "1", "--backend", "numpy",
                "-o", str(root / "output")], cwd=root, check=True, timeout=180)
copyfile(root / "LICENSE-CC0.txt", root / "output" / "LICENSE-CC0.txt")
(root / "output" / "GENERATION.json").write_text(json.dumps({"tool": "SpriteKiln", "version": "0.3.0", "source": "https://github.com/LucasJRamos/spritekiln", "template": "CC0 humanoid by Lucas Ramos; size/name/camera adapted", "note": "Starter, not an arbitrary intent match; preserve actual edited input rights."}, indent=2), encoding="utf-8")
