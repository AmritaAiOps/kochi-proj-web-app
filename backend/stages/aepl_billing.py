"""Stage 7: AEPL Billing."""
from functools import partial

import pandas as pd

from backend.stages.columns import find_column

# headers vary the suffix, e.g. "Posted Debit Amt" vs "Posted Debit Amount"
_find_column = partial(find_column, match="contains")


def process_aepl_billing(df: pd.DataFrame) -> float:
    bill_number_col = _find_column(df, "AEPL Bill No")
    debit_col = _find_column(df, "Posted Debit")
    credit_col = _find_column(df, "Posted Credit")

    bill_number = df[bill_number_col].astype(str).str.upper()
    excluded = bill_number.str.contains("NN") | bill_number.str.contains("NP")
    cleaned = df.loc[~excluded]

    debit_sum = pd.to_numeric(cleaned[debit_col], errors="coerce").sum()
    credit_sum = pd.to_numeric(cleaned[credit_col], errors="coerce").sum()
    return float(debit_sum - credit_sum)
