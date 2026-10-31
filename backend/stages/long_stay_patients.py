"""Stage 9 (partial): Long Stay Patients, computed from the same IP
Discharges DataFrame Stage 4 already loaded -- no separate upload needed.

"Days" in the IP Discharges export is already a precomputed length-of-stay
number (confirmed against the real sheet), not a date to diff ourselves.
"""
import logging

import pandas as pd

from backend.stages.columns import find_column as _find_column
from backend.stages.category_mapping import resolve_category
from backend.stages.category_review import review_dataframe
from backend.stages.cat_dependent_counts import BUCKET_TO_OUTPUT_KEY, drop_admission_ward

logger = logging.getLogger(__name__)

LONG_STAY_THRESHOLD_DAYS = 10

def process_long_stay_patients(df: pd.DataFrame, source_file: str = None, overrides: dict = None) -> dict:
    days_col = _find_column(df, "Days")
    category_col = _find_column(df, "Category")

    # same day-care rule as IP Discharges (no effect in practice: day-care stays are 1-2 days)
    df = drop_admission_ward(df).copy()
    days_numeric = pd.to_numeric(df[days_col], errors="coerce")

    unparseable_mask = df[days_col].notna() & days_numeric.isna()
    unparseable = int(unparseable_mask.sum())
    if unparseable > 0:
        logger.warning(
            "Long Stay Patients: %d row(s) had a non-numeric Days value; excluded rather than crashing or "
            "silently counting as 0.",
            unparseable,
        )

    long_stay = df.loc[days_numeric > LONG_STAY_THRESHOLD_DAYS].copy()
    long_stay["CAT"] = long_stay[category_col].map(lambda v: resolve_category(v, overrides))

    result = {}
    for bucket, output_key in BUCKET_TO_OUTPUT_KEY.items():
        result[output_key] = int((long_stay["CAT"] == bucket).sum())

    result["Total"] = sum(result.values())
    result["category_review"] = review_dataframe(long_stay, category_col, source_file, overrides)
    return result
