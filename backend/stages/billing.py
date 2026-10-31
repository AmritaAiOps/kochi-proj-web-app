"""Stage 5: Billing OP + IP processing."""

from functools import partial

import pandas as pd

from backend.stages.columns import find_column
from backend.stages.category_mapping import resolve_category, resolve_region
from backend.stages.category_review import review_dataframe
from backend.stages.row_cleaning import strip_junk_rows

# real headers append suffixes like "(Inc.Tax)" onto "TotalAmt"
_find_column = partial(find_column, match="prefix")


def _realign_shifted_rows(df: pd.DataFrame) -> pd.DataFrame:
    """HIS exports some bill-counter blocks (e.g. "Cardiology(AFC)Bill Counter")
    with an extra blank cell before Category, so Category is empty, TotalAmt
    holds the category code and every later value sits one column right. Those
    rows read as amount-less and were silently dropped (08-Oct: Rs 3,640 of OP).
    Shift them back one column left."""
    category_col = _find_column(df, "Category")
    total_amt_col = _find_column(df, "TotalAmt")
    shifted = (
        df[category_col].isna()
        & df[total_amt_col].map(lambda v: isinstance(v, str) and v.strip() != "")
        & pd.to_numeric(df[total_amt_col], errors="coerce").isna()
    )
    if not shifted.any():
        return df
    start = df.columns.get_loc(category_col)
    tail = df.iloc[:, start:].to_numpy(dtype=object)
    mask = shifted.to_numpy()
    tail[mask, :-1] = tail[mask, 1:]
    tail[mask, -1] = None
    return pd.concat([df.iloc[:, :start], pd.DataFrame(tail, index=df.index, columns=df.columns[start:])], axis=1)


def _enrich(df: pd.DataFrame, overrides: dict = None) -> pd.DataFrame:
    total_amt_col = _find_column(df, "TotalAmt")
    disc_amt_col = _find_column(df, "DiscAmt")
    category_col = _find_column(df, "Category")

    df = df.copy()
    df["Net"] = pd.to_numeric(df[total_amt_col], errors="coerce") - pd.to_numeric(df[disc_amt_col], errors="coerce")
    df["CAT"] = df[category_col].map(lambda v: resolve_category(v, overrides))
    df["Cash_Credit"] = df["CAT"].map(lambda cat: "Cash" if cat == "General" else "Credit")
    df["Region"] = df[category_col].map(lambda v: resolve_region(v, overrides))
    return df, category_col


def _classified_net(df: pd.DataFrame) -> float:
    # Only rows with a region (mapped or reviewed) count, so OP + IP always equals
    # Domestic + International. Unreviewed rows block export (main.py) instead of
    # silently landing in one total but not the other.
    return df.loc[df["Region"].notna(), "Net"].sum()


def process_billing_op(df: pd.DataFrame, source_file: str = None, overrides: dict = None) -> tuple:
    df = _realign_shifted_rows(df)
    total_amt_col = _find_column(df, "TotalAmt")
    disc_amt_col = _find_column(df, "DiscAmt")
    bill_type_col = _find_column(df, "BillType")

    cleaned, _dropped = strip_junk_rows(df, [total_amt_col, disc_amt_col])
    cleaned = cleaned.loc[cleaned[bill_type_col] == "O_B"]

    enriched, category_col = _enrich(cleaned, overrides)
    category_review = review_dataframe(enriched, category_col, source_file, overrides)
    return enriched, _classified_net(enriched), category_review


def process_billing_ip(df: pd.DataFrame, source_file: str = None, overrides: dict = None) -> tuple:
    df = _realign_shifted_rows(df)
    total_amt_col = _find_column(df, "TotalAmt")
    disc_amt_col = _find_column(df, "DiscAmt")
    bill_type_col = _find_column(df, "BillType")

    cleaned, _dropped = strip_junk_rows(df, [total_amt_col, disc_amt_col])
    cleaned = cleaned.loc[cleaned[bill_type_col].isin(["IP_D", "IP_F"])]

    enriched, category_col = _enrich(cleaned, overrides)
    category_review = review_dataframe(enriched, category_col, source_file, overrides)

    time_col = _find_column(enriched, "Time", required=False)
    if time_col is not None:
        enriched = enriched.drop(columns=[time_col])

    return enriched, _classified_net(enriched), category_review
