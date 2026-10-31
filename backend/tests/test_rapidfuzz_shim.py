"""The browser build swaps rapidfuzz for web/pyshim/rapidfuzz (no Pyodide
build exists). Category suggestions must not change, so the shim's ratio has
to equal the real one on the values the app actually compares."""
import importlib.util
import json
from pathlib import Path

from rapidfuzz import fuzz

from backend.runtime_paths import CONFIG_DIR, ROOT
from backend.stages.category_mapping import normalize_loose

_spec = importlib.util.spec_from_file_location("shim_fuzz", ROOT / "web" / "pyshim" / "rapidfuzz" / "fuzz.py")
shim = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(shim)


def test_shim_ratio_matches_rapidfuzz():
    keys = sorted(json.loads((CONFIG_DIR / "category_map.json").read_text()))
    raw = ["CPR 26", "TPA 26", "Study-Faculty", "DEP-Middle East", "CPR-SAARC", "ESSI2025", "labcpr26op.1", "", "x"]
    values = keys + [normalize_loose(v) for v in raw] + raw
    for a in values:
        for b in keys:
            assert shim.ratio(a, b) == fuzz.ratio(a, b), (a, b)
    assert shim.ratio("", "") == fuzz.ratio("", "")
