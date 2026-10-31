import pandas as pd

from backend.stages.category_mapping import EXCLUDED, normalize_loose
from backend.stages.category_review import (
    fuzzy_best_match,
    get_unmatched_categories,
    classify_unmatched,
    review_dataframe,
    merge_reviews,
)


def test_get_unmatched_categories_counts_frequency_and_sorts_desc():
    df = pd.DataFrame({
        "Category": ["GNL", "Bogus A", "Bogus A", "Bogus B", "GNL", "Bogus A"],
    })
    result = get_unmatched_categories(df, "Category", source_file="test.xlsx")
    assert result == [
        {"raw_value": "Bogus A", "frequency": 3, "source_file": "test.xlsx"},
        {"raw_value": "Bogus B", "frequency": 1, "source_file": "test.xlsx"},
    ]


def test_get_unmatched_categories_handles_nan():
    df = pd.DataFrame({"Category": ["GNL", None, None]})
    result = get_unmatched_categories(df, "Category", source_file="f.xlsx")
    assert len(result) == 1
    assert result[0]["raw_value"] is None
    assert result[0]["frequency"] == 2


def test_get_unmatched_categories_missing_column_returns_empty():
    df = pd.DataFrame({"Other": [1, 2]})
    assert get_unmatched_categories(df, "Category") == []


def test_get_unmatched_categories_excludes_explicitly_overridden_values():
    df = pd.DataFrame({"Category": ["GNL", "Bogus A", "Bogus B"]})
    overrides = {normalize_loose("Bogus A"): EXCLUDED}
    result = get_unmatched_categories(df, "Category", overrides=overrides)
    # Bogus A was explicitly excluded by a human -- stops reappearing
    assert [e["raw_value"] for e in result] == ["Bogus B"]


def test_get_unmatched_categories_excludes_bucket_assigned_values():
    df = pd.DataFrame({"Category": ["GNL", "Bogus A", "Bogus B"]})
    overrides = {normalize_loose("Bogus A"): "TPA"}
    result = get_unmatched_categories(df, "Category", overrides=overrides)
    assert [e["raw_value"] for e in result] == ["Bogus B"]


def test_fuzzy_best_match_catches_near_miss_real_world_case():
    # "ESI2025" (no separators) vs the actual Category Codes entry "ESI - 2025"
    match = fuzzy_best_match("ESI2025")
    assert match is not None
    assert match["bucket"] == "ECHS"
    assert match["similarity"] >= 90


def test_fuzzy_best_match_catches_trailing_period_and_extra_chars():
    match = fuzzy_best_match("CPR .")
    assert match is not None
    assert match["bucket"] == "CPR"


def test_fuzzy_best_match_returns_none_for_completely_different_value():
    assert fuzzy_best_match("Totally Unrelated Nonsense Value") is None


def test_fuzzy_best_match_returns_none_for_non_string():
    assert fuzzy_best_match(None) is None
    assert fuzzy_best_match(float("nan")) is None


def test_classify_unmatched_splits_possible_from_unmatched():
    unmatched = [
        {"raw_value": "ESI2025", "frequency": 6, "source_file": "a.xlsx"},
        {"raw_value": "Totally Unrelated Nonsense", "frequency": 1, "source_file": "a.xlsx"},
    ]
    result = classify_unmatched(unmatched)
    assert len(result["possible_matches"]) == 1
    assert result["possible_matches"][0]["raw_value"] == "ESI2025"
    assert result["possible_matches"][0]["suggested_bucket"] == "ECHS"
    assert "similarity" in result["possible_matches"][0]

    assert len(result["unmatched"]) == 1
    assert result["unmatched"][0]["raw_value"] == "Totally Unrelated Nonsense"


def test_classify_unmatched_never_auto_accepts():
    unmatched = [{"raw_value": "ESI2025", "frequency": 1, "source_file": "a.xlsx"}]
    result = classify_unmatched(unmatched)
    # possible match is flagged, not folded into a "matched" bucket anywhere
    assert result["possible_matches"][0]["suggested_bucket"] == "ECHS"
    assert result["unmatched"] == []


def test_review_dataframe_combines_both_passes():
    # "ESSI2025" isn't in the map under any punctuation (unlike "ESI2025",
    # which loosely matches the mapped "ESI - 2025"), so it's a genuine
    # fuzzy-only near-miss.
    df = pd.DataFrame({
        "Category": ["GNL", "ESSI2025", "ESSI2025", "Nonsense Value"],
    })
    review = review_dataframe(df, "Category", "billing_op.xlsx")
    assert review["possible_matches"][0]["raw_value"] == "ESSI2025"
    assert review["possible_matches"][0]["frequency"] == 2
    assert review["unmatched"][0]["raw_value"] == "Nonsense Value"


def test_merge_reviews_combines_and_resorts():
    review_a = {
        "possible_matches": [{"raw_value": "X", "frequency": 2, "source_file": "a"}],
        "unmatched": [{"raw_value": "Y", "frequency": 1, "source_file": "a"}],
    }
    review_b = {
        "possible_matches": [{"raw_value": "Z", "frequency": 5, "source_file": "b"}],
        "unmatched": [{"raw_value": "W", "frequency": 9, "source_file": "b"}],
    }
    merged = merge_reviews([review_a, review_b])
    assert [e["raw_value"] for e in merged["possible_matches"]] == ["Z", "X"]
    assert [e["raw_value"] for e in merged["unmatched"]] == ["W", "Y"]
