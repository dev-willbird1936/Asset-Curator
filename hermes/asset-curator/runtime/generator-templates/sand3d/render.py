# Adapted from Sandflow-ai/sand3d README (Apache-2.0); dimensions changed.
# https://github.com/Sandflow-ai/sand3d -- see LICENSE-sand3d.txt.
import sys
import json
from shutil import copyfile
from pathlib import Path
if sys.version_info[:2] not in ((3, 11), (3, 13)):
    raise SystemExit("sand3d 1.6.3 needs Python 3.11 or 3.13 and its bpy wheel; Python 3.12 is unsupported. No automatic install.")
try:
    import sand3d as s3d
except ImportError:
    raise SystemExit("sand3d runtime missing. Install pinned requirements in your chosen environment; bpy is a large optional dependency.")
root = Path(__file__).resolve().parent
out = root / "output"
out.mkdir(exist_ok=True)
# sand3d defaults to millimetres. This is a parametric bracket starter, not an arbitrary prompt result.
plate = s3d.extrude("plate", s3d.rect(90, 45, r=4), 6)
s3d.hole(plate, 6.6, on=s3d.grid(2, 1, 55, 0))
s3d.fillet(plate, 1, edges="top")
s3d.export(plate, str(out / "bracket.glb"))
copyfile(root / "LICENSE-sand3d.txt", out / "LICENSE-sand3d.txt")
(out / "GENERATION.json").write_text(json.dumps({"tool": "sand3d", "version": "1.6.3", "source": "https://github.com/Sandflow-ai/sand3d", "template": "Apache-2.0 README bracket, dimensions adapted", "units": "millimetres"}, indent=2), encoding="utf-8")
