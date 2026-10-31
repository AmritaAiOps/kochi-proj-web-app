"""Persists accepted Category Review corrections across runs/days.

Deliberately separate from config/category_map.json (the master Category
Codes table) -- this file only remembers one-off corrections a human
explicitly accepted via the Category Review panel. The master table is never
touched by the app. If you want a correction to become permanent business
logic (not just a remembered exception), update category_map.json directly
(see scripts/build_category_map.py) rather than relying on this file forever.
"""
import json
from pathlib import Path

from backend.runtime_paths import CONFIG_DIR

LEARNED_OVERRIDES_PATH = CONFIG_DIR / "learned_overrides.json"


def load_learned_overrides() -> dict:
    """{loose_normalized_raw_value: bucket}. Empty dict if none saved yet."""
    if not LEARNED_OVERRIDES_PATH.exists():
        return {}
    return json.loads(LEARNED_OVERRIDES_PATH.read_text())


def save_learned_overrides(overrides: dict) -> None:
    LEARNED_OVERRIDES_PATH.parent.mkdir(parents=True, exist_ok=True)
    LEARNED_OVERRIDES_PATH.write_text(json.dumps(overrides, indent=2, sort_keys=True))


def add_learned_overrides(new_entries: dict) -> dict:
    """Merges new_entries into the persisted store and saves. Returns the
    full merged dict."""
    current = load_learned_overrides()
    current.update(new_entries)
    save_learned_overrides(current)
    return current
