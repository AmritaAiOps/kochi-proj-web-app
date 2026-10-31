"""Stage 1: category-mapping engine.

Maps raw Category values from HIS exports to a fixed bucket
(CPR, General, ECHS, TPA, P CARD FUND) and region (Domestic/International),
using config/category_map.json built from the bundled Category Codes sheet.
"""
import json
import re
from pathlib import Path
from typing import Optional

from backend.runtime_paths import CONFIG_DIR

CONFIG_PATH = CONFIG_DIR / "category_map.json"

DISPLAY_LABELS = {
    "CPR": "Corporates",
}

_CATEGORY_MAP: dict = {}

# Sentinel override value meaning "explicitly excluded" -- distinct from "no
# override at all". A value with this override is deliberately resolved to
# no bucket (won't count toward anything) and won't keep showing up in
# Category Review, since a human already made that call.
EXCLUDED = "__EXCLUDED__"

# Substrings shared by every International category code in category_map.json
# (cprafroasian, tpaaasantha25, gnlsaarc, depmaldives, gnloman, ...). Used as a
# fallback ONLY for overridden values with no exact category_map.json entry --
# e.g. a fiscal-year variant like "TPA Aasantha 26-27" that hasn't been added
# to the master table yet -- so a brand-new international spelling variant
# doesn't silently default to Domestic just because it went through Category
# Review instead of an exact map lookup.
INTERNATIONAL_HINTS = (
    "afroasian", "oman", "saarc", "maldives", "aasandha", "aasantha",
    "westernersandmideasterners", "middleeast",
)


def normalize_loose(value) -> str:
    """Aggressive normalization for lookup AND fuzzy/override matching:
    strips ALL non-alphanumeric characters (not just whitespace), lowercased.
    Catches near-misses like "CPR25" vs "CPR-25" vs "CPR 25" or "ESI2025" vs
    "ESI - 2025" -- HIS exports and the master Category Codes sheet punctuate
    the same category differently often enough that whitespace-only
    normalization silently drops real rows into "unmatched".
    """
    if not isinstance(value, str):
        return ""
    return re.sub(r"[^a-z0-9]", "", value.lower())


def _load_map() -> dict:
    global _CATEGORY_MAP
    if not _CATEGORY_MAP:
        _CATEGORY_MAP = json.loads(CONFIG_PATH.read_text())
    return _CATEGORY_MAP


def _lookup(raw_value: str, include_unconfirmed: bool = False) -> Optional[dict]:
    """Exact category_map.json lookup (after normalize_loose). No year-suffix
    fallback: a new code like "CPR 26" that isn't in the documented Category
    Codes list must go to Category Review (with a fuzzy suggestion) instead of
    being counted silently. Once confirmed it's remembered as a learned override.

    Entries marked "confirm": true (codes not in the Category Codes sheet, or
    whose bucket the doc and the MIS disagree on, e.g. Study faculty) are skipped unless
    include_unconfirmed, so they show in Category Review with their bucket as
    the suggestion until a human confirms them."""
    entry = _load_map().get(normalize_loose(raw_value))
    if entry is not None and entry.get("confirm") and not include_unconfirmed:
        return None
    return entry


def map_category(raw_value: Optional[str]) -> Optional[str]:
    """Returns the internal bucket name (CPR, General, ECHS, TPA, P CARD FUND) or None.

    Pure lookup, no side effects -- callers that need to know what failed to
    match should use backend.stages.category_review instead of relying on
    this function to log anything.
    """
    if not raw_value or not isinstance(raw_value, str):
        return None
    entry = _lookup(raw_value)
    if entry is None:
        return None
    return entry["bucket"]


def map_region(raw_value: Optional[str]) -> Optional[str]:
    """Returns 'Domestic' or 'International' or None."""
    if not raw_value or not isinstance(raw_value, str):
        return None
    entry = _lookup(raw_value)
    if entry is None:
        return None
    return entry["region"]


def resolve_category(raw_value: Optional[str], overrides: Optional[dict] = None) -> Optional[str]:
    """Same as map_category, but checks an override dict first.

    overrides is keyed by normalize_loose(raw_value) -> bucket (or EXCLUDED).
    These are corrections applied via the Category Review panel -- they are
    NEVER written back to config/category_map.json, the master Category
    Codes table. A value mapped to EXCLUDED resolves to None (same as
    unmatched) but is treated as already-reviewed, so it won't keep
    reappearing in Category Review.
    """
    if overrides and isinstance(raw_value, str):
        key = normalize_loose(raw_value)
        if key in overrides:
            value = overrides[key]
            return None if value == EXCLUDED else value
    return map_category(raw_value)


def resolve_region(raw_value: Optional[str], overrides: Optional[dict] = None) -> Optional[str]:
    """Same as map_region, but checks overrides first.

    An override only records a bucket (chosen via the Category Review panel),
    not the Domestic/International flag. If the raw value is still present
    in category_map.json (just re-bucketed), use its recorded region; only
    fall back to Domestic when the raw value has no region info at all.
    """
    if overrides and isinstance(raw_value, str):
        key = normalize_loose(raw_value)
        if key in overrides:
            if overrides[key] == EXCLUDED:
                return None
            entry = _lookup(raw_value, include_unconfirmed=True)
            if entry:
                return entry["region"]
            return "International" if any(hint in key for hint in INTERNATIONAL_HINTS) else "Domestic"
    return map_region(raw_value)


def is_overridden(raw_value: Optional[str], overrides: Optional[dict] = None) -> bool:
    """True if raw_value has an explicit override recorded (bucket or EXCLUDED)."""
    if not overrides or not isinstance(raw_value, str):
        return False
    return normalize_loose(raw_value) in overrides


def display_label(bucket: str) -> str:
    return DISPLAY_LABELS.get(bucket, bucket)
