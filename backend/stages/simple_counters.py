"""Stage 3: simple, independent counters.

Each function is pure: takes a DataFrame, returns a value, no file I/O.
"""
import re

import pandas as pd

from backend.stages.columns import find_column as _find_column
from backend.stages.row_cleaning import strip_junk_rows, extract_op_encounter_subtotals

EXCLUDE_SPECIALITIES = [
    "Radiology",
    "Njarakkal Health Center",
    "Amrita Urban Health Centre Kaloor",
    "Amrita Labs",
    "Amrita Lab Trivandrum",
    "Amrita Health Centre Palluruthy",
    "Amrita Centre For Advanced Dental Care",
]

BED_OCCUPANCY_EXCLUDED_CATEGORIES = {
    "nursery", "operationtheatre", "labour", "daycasea", "daycasebed", "emunit",
    # the sheet's own grand-total row -- summing every category already gives
    # this figure, so including the row too silently doubles the count
    "total",
}

BED_STRENGTH = 1000


def _normalize_header(name) -> str:
    if not isinstance(name, str):
        return ""
    return re.sub(r"\s+", "", name.strip().lower())


def process_op_new_registration(df: pd.DataFrame) -> int:
    col = _find_column(df, "MRD Number")
    # Count only genuine (numeric) MRD numbers. Raw HIS exports leave a
    # trailing note row in the MRD column (e.g. "a) Take the count of MRD
    # number - 382"); a plain notna() count treats that text cell as a
    # registration and overcounts by one. The pre-cleaned/edited files have
    # the note stripped, so both formats now agree on the real count.
    return int(pd.to_numeric(df[col], errors="coerce").notna().sum())


def process_op_encounters(df: pd.DataFrame) -> int:
    return extract_op_encounter_subtotals(df, EXCLUDE_SPECIALITIES)


def process_admission_analysis(df: pd.DataFrame) -> dict:
    emergency_col = _find_column(df, "Total Emergency Admission")
    planned_col = _find_column(df, "Total Planned Admission")
    walkin_col = _find_column(df, "Total admission from OP (walk-in)")
    speciality_col = df.columns[0]

    total_row = df[df[speciality_col].astype(str).str.strip().str.lower() == "total"]
    if total_row.empty:
        raise ValueError("Admission Analysis sheet has no 'Total' row")
    row = total_row.iloc[0]

    return {
        "Emergency Admission": int(row[emergency_col]),
        "Planned Admission": int(row[planned_col]),
        "Admission from OP (walk-in)": int(row[walkin_col]),
    }


def process_bed_occupancy(df: pd.DataFrame) -> dict:
    category_col = _find_column(df, "Category")
    beds_occupied_col = _find_column(df, "Beds Occupied")

    # The sheet's own grand-total row doesn't always carry the text "Total"
    # -- some exports leave the Category cell blank for it instead. A blank
    # category is never a real bed category, so treat it the same as the
    # named "total" exclusion; otherwise that row's count gets summed in
    # alongside every other row, silently doubling the figure.
    is_blank_category = df[category_col].isna() | (df[category_col].astype(str).str.strip() == "")
    normalized_category = df[category_col].astype(str).map(_normalize_header)
    df = df.loc[~(normalized_category.isin(BED_OCCUPANCY_EXCLUDED_CATEGORIES) | is_blank_category)]

    cleaned, _dropped = strip_junk_rows(df, [beds_occupied_col])

    beds_occupied = int(pd.to_numeric(cleaned[beds_occupied_col], errors="coerce").sum())
    return {
        "bed_strength": BED_STRENGTH,
        "beds_occupied": beds_occupied,
        "occupancy_pct": beds_occupied / BED_STRENGTH,
    }
