"""Daily Average / MTD (Proj) columns for the current reporting month.

Two distinct things, per row:
  - True MTD = actual cumulative sum, 1st of month through today (not
    written anywhere on its own in the Final output template -- only its
    derivatives are).
  - Daily Average = true MTD actual / day-of-month-today.
  - MTD (Proj) = Daily Average * days_in_month -- a full-month forecast at
    today's pace, NOT the true MTD-so-far sum.

Not every row is a additive daily flow. Applying sum-then-average blindly to
a snapshot metric (bed occupancy, a percentage) or a fixed constant (Bed
Strength) produces a meaningless number, so each row is classified first.
"""
import calendar

from backend.stages.daily_history import get_month_series
from backend.stages.final_output import ROW_MAP

# Snapshot-style metrics: each day's value is a point-in-time reading, not an
# additive daily flow. Averaging them over the month-so-far is meaningful;
# summing them (and then projecting by *days_in_month) is not.
AVERAGE_KEYS = {"Beds Occupied", "Occupancy %"}

# Truly fixed values -- "average so far this month" is just the constant.
CONSTANT_KEYS = {"Bed Strength"}

# Computed from other rows' own Daily Average / MTD Proj, not accumulated
# directly -- same subtraction applied in every column, not just "as on".
# Row 63 = row 57 (grand Total Billing) - row 60 (AEPL Billing).
DERIVED_KEYS = {
    "Hospital Revenue (Net of AEPL)": ("Total Billing", "AEPL Billing"),
}

# Every other row in ROW_MAP that isn't one of the above is treated as a
# cumulative daily flow (counts, billing amounts) -- true MTD sum / day, then
# projected by days_in_month.
CUMULATIVE_KEYS = {
    key for key in ROW_MAP.values()
    if key not in AVERAGE_KEYS and key not in CONSTANT_KEYS and key not in DERIVED_KEYS
}


def compute_mtd_columns(report_date, values: dict, history: dict):
    """Returns {metric_key: {"daily_avg": ..., "mtd_proj": ...}} for every
    row this month, using history (see daily_history.load_history()) plus
    today's own `values` for the running total.

    Returns None only when this month has no recorded days at all yet
    (nothing to average). Otherwise averages over however many days of this
    month are actually on record -- 5 days in means sum-of-5 / 5, not
    sum / 30 -- so a month the automation joined mid-way through (no day 1
    snapshot) still gets a real average instead of staying blank forever.
    """
    month = report_date.strftime("%Y-%m")
    if not history.get(month):
        return None

    days_in_month = calendar.monthrange(report_date.year, report_date.month)[1]
    result = {}

    for key in CUMULATIVE_KEYS:
        if key not in values:
            continue
        series = get_month_series(history, report_date, key)
        if not series:
            continue
        # Running Daily Average = mean of the days actually recorded so far,
        # not sum / day-of-month, so a skipped day doesn't drag the average.
        daily_avg = sum(series.values()) / len(series)
        result[key] = {"daily_avg": daily_avg, "mtd_proj": daily_avg * days_in_month}

    for key in AVERAGE_KEYS:
        if key not in values:
            continue
        series = get_month_series(history, report_date, key)
        daily_avg = sum(series.values()) / len(series) if series else values[key]
        result[key] = {"daily_avg": daily_avg, "mtd_proj": daily_avg}

    for key in CONSTANT_KEYS:
        if key not in values:
            continue
        result[key] = {"daily_avg": values[key], "mtd_proj": values[key]}

    for derived_key, (positive_key, negative_key) in DERIVED_KEYS.items():
        if positive_key in result and negative_key in result:
            result[derived_key] = {
                "daily_avg": result[positive_key]["daily_avg"] - result[negative_key]["daily_avg"],
                "mtd_proj": result[positive_key]["mtd_proj"] - result[negative_key]["mtd_proj"],
            }

    return result
