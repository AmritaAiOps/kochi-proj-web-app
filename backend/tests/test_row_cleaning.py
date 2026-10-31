import pandas as pd

from backend.stages.row_cleaning import strip_junk_rows, extract_op_encounter_subtotals


EXCLUDE_LIST = [
    "Radiology",
    "Njarakkal Health Center",
    "Amrita Urban Health Centre Kaloor",
    "Amrita Labs",
    "Amrita Lab Trivandrum",
    "Amrita Health Centre Palluruthy",
    "Amrita Centre For Advanced Dental Care",
]


def test_strip_junk_rows_drops_section_header_rows():
    df = pd.DataFrame({
        "BillNo": ["IP Bill Counter - 1", 1, 2, "Radiology Bill Counter", 3],
        "TotalAmt": [None, 100, 200, None, 300],
        "DiscAmt": [None, 10, 20, None, 30],
    })
    cleaned, dropped = strip_junk_rows(df, ["TotalAmt", "DiscAmt"])
    assert dropped == 2
    assert list(cleaned["BillNo"]) == [1, 2, 3]


def test_strip_junk_rows_keeps_rows_with_zero_amounts():
    df = pd.DataFrame({
        "TotalAmt": [0, None],
        "DiscAmt": [0, None],
    })
    cleaned, dropped = strip_junk_rows(df, ["TotalAmt", "DiscAmt"])
    assert dropped == 1
    assert len(cleaned) == 1


def test_strip_junk_rows_single_required_column():
    df = pd.DataFrame({
        "Category": ["NURSERY header", "GNL", "TPA"],
        "Beds Occupied": [None, 5, 3],
    })
    cleaned, dropped = strip_junk_rows(df, ["Beds Occupied"])
    assert dropped == 1
    assert list(cleaned["Beds Occupied"]) == [5, 3]


def _op_encounters_df():
    rows = [
        ["Speciality", "Cardiology", None],
        [1, "PATIENT A", None],
        [2, "PATIENT B", None],
        ["Total Encounters", None, 2],
        ["Speciality", "Radiology", None],
        [1, "PATIENT C", None],
        ["Total Encounters", None, 1],
        ["Speciality", "General Medicine", None],
        [1, "PATIENT D", None],
        [2, "PATIENT E", None],
        [3, "PATIENT F", None],
        ["Total Encounters", None, 3],
    ]
    return pd.DataFrame(rows, columns=["Col0", "Col1", "Col2"])


def test_extract_op_encounter_subtotals_sums_non_excluded_groups():
    df = _op_encounters_df()
    total = extract_op_encounter_subtotals(df, EXCLUDE_LIST)
    # Cardiology (2) + General Medicine (3), Radiology excluded
    assert total == 5


def test_extract_op_encounter_subtotals_excludes_case_and_space_insensitive():
    rows = [
        ["Speciality", "  amrita labs ", None],
        [1, "X", None],
        ["Total Encounters", None, 99],
    ]
    df = pd.DataFrame(rows, columns=["Col0", "Col1", "Col2"])
    total = extract_op_encounter_subtotals(df, EXCLUDE_LIST)
    assert total == 0


def test_extract_op_encounter_subtotals_skips_group_start_without_end():
    rows = [
        ["Speciality", "Orphaned Group", None],
        [1, "X", None],
        ["Speciality", "Valid Group", None],
        [1, "Y", None],
        ["Total Encounters", None, 7],
    ]
    df = pd.DataFrame(rows, columns=["Col0", "Col1", "Col2"])
    total = extract_op_encounter_subtotals(df, EXCLUDE_LIST)
    assert total == 7


def test_extract_op_encounter_subtotals_skips_trailing_unmatched_group():
    rows = [
        ["Speciality", "Valid Group", None],
        [1, "Y", None],
        ["Total Encounters", None, 4],
        ["Speciality", "Trailing Orphan", None],
        [1, "Z", None],
    ]
    df = pd.DataFrame(rows, columns=["Col0", "Col1", "Col2"])
    total = extract_op_encounter_subtotals(df, EXCLUDE_LIST)
    assert total == 4
