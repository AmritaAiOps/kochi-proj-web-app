import pandas as pd

from backend.stages.cat_dependent_counts import process_ip_admission, process_ip_discharges


def _sample_df():
    return pd.DataFrame({
        "MrdNo": [1, 2, 3, 4, 5, 6],
        "Category": ["GNL", "TPA", "ECHS", "P CARD FUND", "CPR", "Totally Unknown"],
    })


def test_process_ip_admission_counts_each_bucket():
    df = _sample_df()
    result = process_ip_admission(df, source_file="ip_admission.xlsx")
    assert result["General"] == 1
    assert result["TPA"] == 1
    assert result["ECHS"] == 1
    assert result["P.Card.Fund"] == 1
    assert result["Corporates"] == 1
    assert result["Total"] == 5


def test_process_ip_admission_surfaces_unmatched_via_category_review():
    df = _sample_df()
    result = process_ip_admission(df, source_file="ip_admission.xlsx")
    review = result["category_review"]
    assert review["unmatched"] == [
        {"raw_value": "Totally Unknown", "frequency": 1, "source_file": "ip_admission.xlsx"}
    ]
    assert review["possible_matches"] == []


def test_process_ip_discharges_same_shape_with_cate_gory_column():
    df = pd.DataFrame({
        "MrdNo": [1, 2, 3, 4, 5, 6],
        "Cate\ngory": ["GNL", "TPA", "ECHS", "P CARD FUND", "CPR", "Bogus"],
    })
    result = process_ip_discharges(df, source_file="ip_discharges.xlsx")
    assert result["General"] == 1
    assert result["TPA"] == 1
    assert result["ECHS"] == 1
    assert result["P.Card.Fund"] == 1
    assert result["Corporates"] == 1
    assert result["Total"] == 5
    assert result["category_review"]["unmatched"][0]["raw_value"] == "Bogus"


def test_process_ip_admission_handles_multiple_rows_per_bucket():
    df = pd.DataFrame({
        "Category": ["GNL", "GNL", "TPA", "GNL", "ECHS"],
    })
    result = process_ip_admission(df)
    assert result["General"] == 3
    assert result["TPA"] == 1
    assert result["ECHS"] == 1
    assert result["Corporates"] == 0
    assert result["P.Card.Fund"] == 0
    assert result["Total"] == 5
    assert result["category_review"]["unmatched"] == []
    assert result["category_review"]["possible_matches"] == []


def test_process_ip_admission_applies_overrides():
    df = pd.DataFrame({"Category": ["GNL", "Weird Custom Value"]})
    overrides = {"weirdcustomvalue": "TPA"}
    result = process_ip_admission(df, overrides=overrides)
    assert result["TPA"] == 1
    assert result["General"] == 1
    assert result["Total"] == 2
    # overridden value no longer shows up as needing review
    assert result["category_review"]["unmatched"] == []
    assert result["category_review"]["possible_matches"] == []


def test_admission_ward_rows_excluded_in_every_bucket():
    # MIS leaves out "Admission Ward" (day-care) rows; other wards, incl. Daycare Lounge, still count
    df = pd.DataFrame({
        "Category": ["GNL", "GNL", "TPA", "ECHS", "TPA", None],
        "Ward": ["Admission Ward", "B-General Male", " admission ward ", "ICU", "T3F1 -Daycare Lounge", None],
    })
    for process in (process_ip_admission, process_ip_discharges):
        r = process(df)
        assert (r["General"], r["TPA"], r["ECHS"], r["Total"]) == (1, 1, 1, 3)
        assert r["category_review"]["unmatched"] == []


def test_process_ip_admission_without_ward_column_is_unaffected():
    df = _sample_df()
    result = process_ip_admission(df)
    assert result["Total"] == 5


def test_process_ip_admission_flags_fuzzy_near_miss_as_possible_match():
    # "ESI2025" (no punctuation) loosely normalizes the same as the mapped
    # "ESI - 2025" so it's an exact match now; "ESSI2025" (extra letter)
    # isn't in the map under any punctuation, so it stays a fuzzy-only
    # near-miss.
    df = pd.DataFrame({"Category": ["GNL", "ESSI2025"]})
    result = process_ip_admission(df, source_file="ip_admission.xlsx")
    assert result["ECHS"] == 0
    possible = result["category_review"]["possible_matches"]
    assert len(possible) == 1
    assert possible[0]["raw_value"] == "ESSI2025"
    assert possible[0]["suggested_bucket"] == "ECHS"
