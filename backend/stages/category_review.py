"""Surfaces unmatched Category values for human review, instead of silently
logging them.

Three buckets, per value:
  - matched: map_category found an exact hit (not surfaced here at all).
  - possible-match: no exact hit, but a fuzzy match against the known bucket
    values cleared FUZZY_THRESHOLD -- needs a human to confirm before it
    counts toward anything.
  - unmatched: no exact hit and no fuzzy match either.
"""
import math

import pandas as pd
from rapidfuzz import fuzz

from backend.stages.category_mapping import _load_map, normalize_loose, resolve_category, is_overridden

# 80 so year-suffix variants of documented codes (CPR 26 vs CPR 25) still get a suggestion
FUZZY_THRESHOLD = 80

_LOOSE_INDEX_CACHE = None


def _loose_index():
    """[(loose_normalized_known_value, bucket), ...], built once from
    config/category_map.json and cached for the process lifetime."""
    global _LOOSE_INDEX_CACHE
    if _LOOSE_INDEX_CACHE is None:
        _LOOSE_INDEX_CACHE = [
            (normalize_loose(raw_key), entry["bucket"]) for raw_key, entry in _load_map().items()
        ]
    return _LOOSE_INDEX_CACHE


def fuzzy_best_match(raw_value, threshold: int = FUZZY_THRESHOLD):
    """Best fuzzy match against known bucket values, or None if nothing
    clears the threshold. Returns {"bucket": ..., "similarity": ...}."""
    if not isinstance(raw_value, str):
        return None
    loose = normalize_loose(raw_value)
    if not loose:
        return None

    best_bucket, best_score = None, -1.0
    for loose_key, bucket in _loose_index():
        if not loose_key:
            continue
        score = fuzz.ratio(loose, loose_key)
        if score > best_score:
            best_score, best_bucket = score, bucket

    if best_bucket is not None and best_score >= threshold:
        return {"bucket": best_bucket, "similarity": round(best_score, 1)}
    return None


def _clean_raw_value(raw_value):
    if raw_value is None:
        return None
    if isinstance(raw_value, float) and math.isnan(raw_value):
        return None
    return raw_value


def get_unmatched_categories(
    df: pd.DataFrame, category_column: str = "Category", source_file: str = None, overrides: dict = None
) -> list:
    """Every unique raw value in category_column that map_category rejects,
    with frequency and source, sorted by frequency descending. Values already
    given an explicit override -- whether assigned a bucket or deliberately
    excluded (category_mapping.EXCLUDED) -- are treated as already-reviewed
    and excluded here, so they stop reappearing once a human has decided.
    """
    if category_column not in df.columns:
        return []

    counts = df[category_column].value_counts(dropna=False)
    result = []
    for raw_value, count in counts.items():
        if is_overridden(raw_value, overrides):
            continue
        if resolve_category(raw_value, overrides) is not None:
            continue
        result.append(
            {
                "raw_value": _clean_raw_value(raw_value),
                "frequency": int(count),
                "source_file": source_file,
            }
        )

    result.sort(key=lambda entry: entry["frequency"], reverse=True)
    return result


def classify_unmatched(unmatched: list) -> dict:
    """Second, looser pass over an unmatched list (from get_unmatched_categories):
    splits it into possible_matches (fuzzy hit, needs confirmation) and
    unmatched (no match at all). Never auto-accepts a fuzzy hit.
    """
    possible_matches = []
    still_unmatched = []

    for entry in unmatched:
        match = fuzzy_best_match(entry["raw_value"])
        if match:
            possible_matches.append(
                {**entry, "suggested_bucket": match["bucket"], "similarity": match["similarity"]}
            )
        else:
            still_unmatched.append(entry)

    possible_matches.sort(key=lambda entry: entry["frequency"], reverse=True)
    still_unmatched.sort(key=lambda entry: entry["frequency"], reverse=True)
    return {"possible_matches": possible_matches, "unmatched": still_unmatched}


def review_dataframe(df: pd.DataFrame, category_column: str, source_file: str, overrides: dict = None) -> dict:
    """Runs both passes for one dataframe/report: {"possible_matches": [...], "unmatched": [...]}."""
    unmatched = get_unmatched_categories(df, category_column, source_file, overrides)
    return classify_unmatched(unmatched)


def merge_reviews(reviews: list) -> dict:
    """Combines multiple per-report review dicts into one, re-sorted by frequency."""
    possible_matches = [entry for review in reviews for entry in review["possible_matches"]]
    unmatched = [entry for review in reviews for entry in review["unmatched"]]
    possible_matches.sort(key=lambda entry: entry["frequency"], reverse=True)
    unmatched.sort(key=lambda entry: entry["frequency"], reverse=True)
    return {"possible_matches": possible_matches, "unmatched": unmatched}
