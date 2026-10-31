"""Stage 13: post-pipeline verification of Final Output values.

Three layers, all soft (flag, never block -- same pattern as unmatched
categories):
  1. Independent recomputes from the raw source DataFrames -- deliberately
     different code paths than the pipeline (e.g. OP Encounters is recounted
     from detail rows, while the pipeline reads the per-speciality subtotal
     rows), so a pipeline bug and its check can't share the same mistake.
  2. Internal reconciliation of the Final Output row formulas.
  3. Sanity bounds (no negative money rows, occupancy in [0, 1.5]).

A crash inside any single check becomes that check failing with an error
note -- it never raises, so verification can't mask or fake a pipeline error.
"""
import json
import logging
from pathlib import Path

import pandas as pd

from functools import partial

from backend.stages.columns import find_column
from backend.stages.detection import normalize_alnum
from backend.stages.row_cleaning import GROUP_START_LABEL, GROUP_END_LABEL, _normalize
from backend.stages.simple_counters import EXCLUDE_SPECIALITIES

logger = logging.getLogger(__name__)

from backend.runtime_paths import DATA_DIR

_find_column = partial(find_column, match="prefix")

VERIFICATION_HISTORY_PATH = DATA_DIR / "verification_history.json"

TOLERANCE = 0.01  # float rounding slack on money sums

# (name, target_key, [addend keys]) -- the 7 confirmed reconciliation formulas.
RECONCILIATIONS = [
    ("Row 11 IP Admission total == sum of rows 12-16",
     "IP Admission Total", ["IP Admission General", "IP Admission TPA", "IP Admission ECHS",
                            "IP Admission P.Card.Fund", "IP Admission Corporates"]),
    ("Row 22 IP Discharges total == sum of rows 23-27",
     "IP Discharges Total", ["IP Discharges General", "IP Discharges TPA", "IP Discharges ECHS",
                             "IP Discharges P.Card.Fund", "IP Discharges Corporates"]),
    ("Row 34 Total Billing == row 32 + row 33", "Total Billing", ["OP Billing", "IP Billing"]),
    ("Row 39 Billing total == row 37 + row 38", "Billing Total", ["Billing Domestic", "Billing International"]),
    ("Row 48 Credit-Domestic == sum of rows 49-52",
     "Credit Domestic Total", ["Credit Domestic ECHS", "Credit Domestic P.Card.Fund",
                               "Credit Domestic TPA", "Credit Domestic Corporates"]),
    ("Row 54 Credit-International == sum of rows 55-56",
     "Credit International Total", ["Credit International TPA Aasantha",
                                    "Credit International Corporates (International)"]),
    ("Row 57 Total Billing == rows 44+45+48+54",
     "Total Billing", ["Cash Domestic", "Cash International",
                       "Credit Domestic Total", "Credit International Total"]),
]

NON_NEGATIVE_KEYS = [
    "OP Billing", "IP Billing", "Total Billing", "Billing Domestic", "Billing International",
    "Billing Total", "Cash Domestic", "Cash International", "Credit Domestic Total",
    "Credit International Total", "Credit Total Billing", "AEPL Billing",
]


def _check(name, expected, actual):
    delta = None
    ok = False
    if expected is not None and actual is not None:
        delta = float(actual) - float(expected)
        ok = abs(delta) <= TOLERANCE
    return {"name": name, "expected": expected, "actual": actual, "delta": delta, "pass": ok}


def _guarded(name, expected, compute):
    try:
        return _check(name, expected, compute())
    except Exception as exc:  # noqa: BLE001 - a broken check must not kill the run
        logger.warning("verification: check %r errored: %s", name, exc)
        return {"name": f"{name} (check errored: {exc})", "expected": expected,
                "actual": None, "delta": None, "pass": False}


def _recount_op_new_registration(df):
    col = _find_column(df, "Mrd Number")
    return int(df[col].astype(str).str.strip().replace({"nan": "", "None": ""}).ne("").sum())


def _recount_op_encounters(df):
    """Counts detail rows (non-blank Mrd No) inside non-excluded speciality
    groups -- independent of the subtotal rows the pipeline sums."""
    excluded = {_normalize(s) for s in EXCLUDE_SPECIALITIES}
    rows = df.to_numpy()
    # locate the real header row to find the Mrd No column index
    mrd_idx, header_row_idx = None, None
    for idx, row in enumerate(rows[:15]):
        for col_idx, cell in enumerate(row):
            if isinstance(cell, str) and normalize_alnum(cell) == "mrdno":
                mrd_idx, header_row_idx = col_idx, idx
                break
        if mrd_idx is not None:
            break
    if mrd_idx is None:
        raise ValueError("OP Encounters: no 'Mrd No' column found.")

    # Count only rows strictly INSIDE an open group ("Speciality" start ->
    # "Total Encounters" end). Rows outside any group -- grand-total/footer
    # rows after the last group, repeated header rows -- have values in the
    # Mrd No column position but are not encounters.
    count, in_group, group_excluded = 0, False, False
    for row in rows[header_row_idx + 1:]:
        label = row[0]
        if isinstance(label, str) and label.strip() == GROUP_START_LABEL:
            name = row[1] if len(row) > 1 else None
            in_group = True
            group_excluded = isinstance(name, str) and _normalize(name) in excluded
            continue
        if isinstance(label, str) and label.strip() == GROUP_END_LABEL:
            in_group = False
            continue
        if not in_group or group_excluded:
            continue
        mrd = row[mrd_idx]
        if mrd is not None and str(mrd).strip() not in ("", "nan"):
            count += 1
    return count


def _recompute_total_billing(op_df, ip_df):
    total = 0.0
    for df, bill_types in ((op_df, {"O_B"}), (ip_df, {"IP_D", "IP_F"})):
        total_amt = pd.to_numeric(df[_find_column(df, "TotalAmt")], errors="coerce")
        disc_amt = pd.to_numeric(df[_find_column(df, "DiscAmt")], errors="coerce")
        is_data = ~(total_amt.isna() & disc_amt.isna())
        in_scope = df[_find_column(df, "BillType")].isin(bill_types) & is_data
        # NaN propagates through the subtraction and is skipped by sum(),
        # mirroring the pipeline's Net semantics exactly.
        total += float((total_amt[in_scope] - disc_amt[in_scope]).sum())
    return total


def run_verification(final_output_values: dict, source_data: dict) -> dict:
    """source_data: report_type -> raw DataFrame (same dict the pipeline ran on)."""
    values = final_output_values
    checks = []

    # 1. Independent recomputes from raw source
    if "OP New Registration" in source_data:
        checks.append(_guarded("Row 9 OP New Registration recount (non-blank Mrd Number)",
                               values.get("OP New Registration"),
                               lambda: _recount_op_new_registration(source_data["OP New Registration"])))
    if "OP Encounters" in source_data:
        checks.append(_guarded("Row 10 OP Encounters recount (detail rows, exclusions applied)",
                               values.get("OP Encounters"),
                               lambda: _recount_op_encounters(source_data["OP Encounters"])))
    if "Billing INR OP" in source_data and "Billing INR IP" in source_data:
        checks.append(_guarded("Row 34 Total Billing recompute (sum of Net across billing sheets)",
                               values.get("Total Billing"),
                               lambda: _recompute_total_billing(source_data["Billing INR OP"],
                                                                source_data["Billing INR IP"])))

    # 2. Internal reconciliation formulas
    for name, target_key, addend_keys in RECONCILIATIONS:
        checks.append(_guarded(name, values.get(target_key),
                               lambda keys=addend_keys: sum(float(values[k]) for k in keys)))
    # Row 57 == Row 34 needs no separate check: both rows are written from the
    # same "Total Billing" value, and the 44+45+48+54 reconciliation above
    # covers the cash/credit split adding up to it.
    checks.append(_guarded("Row 39 == Row 34 (both billing totals agree)",
                           values.get("Total Billing"), lambda: float(values["Billing Total"])))
    checks.append(_guarded("Row 6 Occupancy % == row 5 / row 4",
                           values.get("Occupancy %"),
                           lambda: float(values["Beds Occupied"]) / float(values["Bed Strength"])))

    # 3. Sanity checks
    for key in NON_NEGATIVE_KEYS:
        if key in values:
            checks.append({"name": f"{key} is not negative", "expected": ">= 0",
                           "actual": values[key], "delta": None,
                           "pass": float(values[key]) >= 0})
    if "Occupancy %" in values:
        occ = float(values["Occupancy %"])
        checks.append({"name": "Occupancy % within [0, 1.5]", "expected": "0 to 1.5",
                       "actual": occ, "delta": None, "pass": 0 <= occ <= 1.5})

    return {"checks": checks, "allPassed": all(c["pass"] for c in checks)}


def save_verification(report_date, report: dict) -> None:
    VERIFICATION_HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    history = load_verification_history()
    history[report_date.isoformat()] = report
    VERIFICATION_HISTORY_PATH.write_text(json.dumps(history, indent=2))


def load_verification_history() -> dict:
    if not VERIFICATION_HISTORY_PATH.exists():
        return {}
    return json.loads(VERIFICATION_HISTORY_PATH.read_text())
