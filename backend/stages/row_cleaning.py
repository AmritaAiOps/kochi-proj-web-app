"""Stage 2: row-cleaning utilities.

Raw HIS exports mix non-data rows into transaction data:
- Billing sheets: "section header" rows (e.g. "IP Bill Counter - 1") where
  only column A has text and the amount columns are blank.
- OP Encounters: grouped by speciality, with a "Speciality" header row
  starting a group and a "Total Encounters" row (holding the subtotal)
  ending it.
"""
import logging
import re
from typing import Optional

import pandas as pd

logger = logging.getLogger(__name__)

GROUP_START_LABEL = "Speciality"
GROUP_END_LABEL = "Total Encounters"


def strip_junk_rows(df: pd.DataFrame, required_columns: list) -> tuple:
    """Drops rows where ALL required_columns are blank/NaN/non-numeric.

    Returns (cleaned_df, dropped_count).
    """
    numeric = df[required_columns].apply(pd.to_numeric, errors="coerce")
    is_junk = numeric.isna().all(axis=1)
    cleaned = df.loc[~is_junk].copy()
    dropped_count = int(is_junk.sum())
    return cleaned, dropped_count


def _normalize(value: str) -> str:
    return re.sub(r"\s+", "", value.strip().lower())


def extract_op_encounter_subtotals(df: pd.DataFrame, exclude_specialities: list) -> int:
    """Sums per-speciality subtotals from the OP Encounters sheet, skipping excluded groups.

    Expects the sheet's first column to hold row labels ("Speciality" /
    "Total Encounters"), the second column to hold the speciality name on a
    group-start row, and the third column to hold the numeric subtotal on a
    group-end row.
    """
    excluded_normalized = {_normalize(name) for name in exclude_specialities}
    rows = df.to_numpy()

    total = 0
    pending_speciality: Optional[str] = None
    pending_row_idx: Optional[int] = None

    for idx, row in enumerate(rows):
        label = row[0]
        if isinstance(label, str) and label.strip() == GROUP_START_LABEL:
            if pending_speciality is not None:
                logger.warning(
                    "OP Encounters: group start for %r at row %d had no matching "
                    "'Total Encounters' before next group start; skipping.",
                    pending_speciality, pending_row_idx,
                )
            pending_speciality = row[1] if len(row) > 1 else None
            pending_row_idx = idx
            continue

        if isinstance(label, str) and label.strip() == GROUP_END_LABEL:
            if pending_speciality is None:
                logger.warning(
                    "OP Encounters: 'Total Encounters' at row %d with no preceding "
                    "group start; skipping.", idx,
                )
                continue
            subtotal = row[2] if len(row) > 2 else None
            speciality_name = pending_speciality
            pending_speciality = None
            pending_row_idx = None

            if not isinstance(speciality_name, str):
                logger.warning(
                    "OP Encounters: group ending at row %d has no speciality name; skipping.", idx,
                )
                continue
            if _normalize(speciality_name) in excluded_normalized:
                continue

            try:
                total += int(subtotal)
            except (TypeError, ValueError):
                logger.warning(
                    "OP Encounters: group %r ending at row %d has non-numeric subtotal %r; skipping.",
                    speciality_name, idx, subtotal,
                )

    if pending_speciality is not None:
        logger.warning(
            "OP Encounters: group start for %r at row %d had no matching "
            "'Total Encounters' before end of sheet; skipping.",
            pending_speciality, pending_row_idx,
        )

    return total
