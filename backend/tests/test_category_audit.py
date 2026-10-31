"""Section 3 re-audit: every raw category value documented in
config/category_map.json must still land at the 'matched' tier -- if this
starts failing, either FUZZY_THRESHOLD drifted or the Category Codes sheet
changed underneath the map without regenerating it.
"""
import json

from backend.runtime_paths import CONFIG_DIR
from backend.stages.category_mapping import map_category


def test_every_known_category_value_still_matches_exactly():
    known_values = json.loads((CONFIG_DIR / "category_map.json").read_text())
    dropped = [raw for raw, entry in known_values.items() if not entry.get("confirm") and map_category(raw) is None]
    assert not dropped, f"Category value(s) dropped out of the 'matched' tier: {dropped}"
