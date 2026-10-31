import pandas as pd

from backend.stages.long_stay_patients import process_long_stay_patients


def _df(rows):
    return pd.DataFrame(rows, columns=["MrdNo", "Category", "Days"])


def test_process_long_stay_patients_excludes_10_days_and_below():
    df = _df([
        [1, "GNL", 10],
        [2, "GNL", 11],
        [3, "TPA", 15],
    ])
    result = process_long_stay_patients(df)
    assert result["General"] == 1
    assert result["TPA"] == 1
    assert result["Total"] == 2


def test_process_long_stay_patients_counts_each_bucket():
    df = _df([
        [1, "GNL", 12],
        [2, "TPA", 20],
        [3, "ECHS", 30],
        [4, "P CARD FUND", 40],
        [5, "CPR", 50],
        [6, "GNL", 5],  # below threshold, excluded
    ])
    result = process_long_stay_patients(df)
    assert result == {
        "General": 1,
        "TPA": 1,
        "ECHS": 1,
        "P.Card.Fund": 1,
        "Corporates": 1,
        "Total": 5,
        "category_review": {"possible_matches": [], "unmatched": []},
    }


def test_process_long_stay_patients_excludes_unparseable_days_without_crashing():
    df = _df([
        [1, "GNL", "not a number"],
        [2, "GNL", 15],
        [3, "GNL", None],
    ])
    result = process_long_stay_patients(df)
    # unparseable and blank Days rows excluded, not counted as 0 or long-stay
    assert result["General"] == 1
    assert result["Total"] == 1


def test_process_long_stay_patients_surfaces_unmatched_category():
    df = _df([
        [1, "GNL", 15],
        [2, "Nonsense Category", 20],
    ])
    result = process_long_stay_patients(df, source_file="ip_discharges.xlsx")
    assert result["Total"] == 1
    assert result["category_review"]["unmatched"][0]["raw_value"] == "Nonsense Category"


def test_process_long_stay_patients_applies_overrides():
    df = _df([[1, "Weird Custom Value", 20]])
    overrides = {"weirdcustomvalue": "TPA"}
    result = process_long_stay_patients(df, overrides=overrides)
    assert result["TPA"] == 1
    assert result["Total"] == 1
    assert result["category_review"]["unmatched"] == []


def test_process_long_stay_patients_handles_cate_gory_column_variant():
    df = pd.DataFrame(
        [[1, "GNL", 15]],
        columns=["MrdNo", "Cate\ngory", "Days"],
    )
    result = process_long_stay_patients(df)
    assert result["General"] == 1


def test_process_long_stay_patients_excludes_admission_ward():
    df = pd.DataFrame(
        [[1, "GNL", 15, "Admission Ward"], [2, "GNL", 15, "ICU"]],
        columns=["MrdNo", "Category", "Days", "Ward"],
    )
    assert process_long_stay_patients(df)["Total"] == 1


def test_process_long_stay_patients_from_real_sample_workbook():
    df = pd.read_excel("Daily report to automate.xlsx", sheet_name="IP Discharges 20,21,22,23,24,25")
    result = process_long_stay_patients(df, source_file="IP Discharges")
    # 14 rows have Days > 10; 3 of them carry the known ESI2025/TPA AASANTHA 25
    # near-miss categories (same ones seen elsewhere in this file) and are
    # correctly held out of Total pending Category Review confirmation.
    assert result["Total"] == 11
    possible_raw_values = {e["raw_value"] for e in result["category_review"]["possible_matches"]}
    assert possible_raw_values == {"ESI2025", "TPA AASANTHA 25"}
