"""Stage 4: CAT-dependent counts for IP Admission and IP Discharges."""

import pandas as pd

from backend.stages.columns import find_column as _find_column
from backend.stages.category_mapping import resolve_category
from backend.stages.category_review import review_dataframe

BUCKET_TO_OUTPUT_KEY = {
    "General": "General",
    "TPA": "TPA",
    "ECHS": "ECHS",
    "P CARD FUND": "P.Card.Fund",
    "CPR": "Corporates",
}

def drop_admission_ward(df: pd.DataFrame) -> pd.DataFrame:
    """Day-care patients sit in Ward "Admission Ward" (Bed Type "Day Case A").
    The hospital's MIS leaves them out of IP Admission / IP Discharges (08-Oct:
    321 -> 190, matches exactly), so drop them. Other day-care wards (e.g.
    Daycare Lounge, "DL") stay counted -- the MIS counts those."""
    ward_col = _find_column(df, "Ward", required=False)
    if ward_col is None:
        return df
    return df.loc[df[ward_col].astype(str).str.strip().str.lower() != "admission ward"]


def _process_cat_counts(df: pd.DataFrame, source_file: str = None, overrides: dict = None) -> dict:
    category_col = _find_column(df, "Category")
    # footer/total rows have no Category -- not patients, keep them out of counts and review.
    df = drop_admission_ward(df.loc[df[category_col].notna()]).copy()
    df["CAT"] = df[category_col].map(lambda v: resolve_category(v, overrides))

    result = {}
    for bucket, output_key in BUCKET_TO_OUTPUT_KEY.items():
        result[output_key] = int((df["CAT"] == bucket).sum())

    result["Total"] = sum(result.values())
    result["category_review"] = review_dataframe(df, category_col, source_file, overrides)
    return result


def process_ip_admission(df, source_file=None, overrides=None):
    return _process_cat_counts(df, source_file, overrides)


def process_ip_discharges(df, source_file=None, overrides=None):
    return _process_cat_counts(df, source_file, overrides)
