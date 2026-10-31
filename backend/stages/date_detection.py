"""Auto-detects the report date from uploaded sheets, so staff don't have to
type it in by hand every day (they can still override it if it's wrong).

Primary source: the HIS export filenames (e.g. "OP Report 12-07-2026.xlsx").
Fallback: scans every column whose header contains "date" across all
uploaded sheets, parses whatever values are there, and returns the single
most common date -- a daily HIS export is overwhelmingly one day's data, so
the mode is a safe bet even when a handful of stray dates (e.g. IP admit
dates from prior days) are mixed in.
"""
import re
from collections import Counter
from datetime import date as date_type

import pandas as pd

from backend.stages.detection import normalize_alnum

# dd-mm-yyyy, dd.mm.yyyy, dd_mm_yyyy (day/month first, matching the HIS
# export naming convention) and yyyy-mm-dd, each with any of -._ as separator.
_FILENAME_DATE_PATTERNS = [
    (re.compile(r"(?<!\d)(\d{4})[-._](\d{1,2})[-._](\d{1,2})(?!\d)"), lambda m: (int(m[1]), int(m[2]), int(m[3]))),
    (re.compile(r"(?<!\d)(\d{1,2})[-._](\d{1,2})[-._](\d{4})(?!\d)"), lambda m: (int(m[3]), int(m[2]), int(m[1]))),
]


def parse_date_from_filename(filename: str) -> str:
    """Returns an ISO date string parsed from the filename, or None if no
    recognizable date pattern is present or the numbers don't form a real
    date (e.g. an invoice number that happens to look date-shaped)."""
    for pattern, to_ymd in _FILENAME_DATE_PATTERNS:
        for match in pattern.finditer(filename):
            try:
                year, month, day = to_ymd(match)
                return date_type(year, month, day).isoformat()
            except ValueError:
                continue
    return None


def detect_dates_from_filenames(filenames: list) -> dict:
    """Parses every filename and reports whether they agree.

    Returns {"date": iso_or_None, "conflict": bool, "found": {filename: iso, ...}}.
    "date" is the common date when every filename that yielded one agrees
    (or None found at all); "conflict" is True when two filenames disagree,
    in which case the caller must surface this to the user rather than
    silently picking one.
    """
    found = {f: parse_date_from_filename(f) for f in filenames}
    distinct = {d for d in found.values() if d is not None}
    if not distinct:
        return {"date": None, "conflict": False, "found": found}
    if len(distinct) > 1:
        return {"date": None, "conflict": True, "found": found}
    return {"date": next(iter(distinct)), "conflict": False, "found": found}


def detect_report_date(sheets: list) -> str:
    """sheets: list of (header_row_idx, rows) -- rows is the sheet's raw
    values (header=None), header_row_idx is the row index detect_report_type
    identified as the header. Returns an ISO date string, or None if no date
    could be found anywhere.
    """
    found_dates = []

    for header_row_idx, rows in sheets:
        if not rows or header_row_idx >= len(rows):
            continue
        header = rows[header_row_idx]
        date_col_indices = [i for i, cell in enumerate(header) if "date" in normalize_alnum(str(cell))]
        if not date_col_indices:
            continue

        for row in rows[header_row_idx + 1:]:
            for idx in date_col_indices:
                if idx >= len(row):
                    continue
                parsed = pd.to_datetime(row[idx], errors="coerce")
                if pd.notna(parsed):
                    found_dates.append(parsed.date())

    if not found_dates:
        return None

    most_common_date, _ = Counter(found_dates).most_common(1)[0]
    return most_common_date.isoformat()
