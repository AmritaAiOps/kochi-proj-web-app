"""Shared column lookup for the report stages: HIS exports vary header whitespace,
punctuation and suffixes ("TotalAmt" vs "Total Amt\n(Inc. Tax)"), so match loosely."""
import re

import pandas as pd


def _norm(name, match) -> str:
    if not isinstance(name, str):
        return ""
    # exact: ignore whitespace/case only; prefix/contains: ignore all punctuation too
    pattern = r"\s+" if match == "exact" else r"[^a-z0-9]"
    return re.sub(pattern, "", name.lower())


def find_column(df: pd.DataFrame, expected_name: str, match: str = "exact", required: bool = True):
    """match: "exact" (whitespace/case-insensitive equality), "prefix" or "contains"
    (both alphanumeric-only). Raises ValueError (never KeyError) when required."""
    target = _norm(expected_name, match)
    for col in df.columns:
        c = _norm(str(col), match)
        hit = {"exact": c == target, "prefix": c.startswith(target), "contains": target in c}[match]
        if hit:
            return col
    if required:
        raise ValueError(f"Column matching {expected_name!r} not found. Available: {list(df.columns)}")
    return None
