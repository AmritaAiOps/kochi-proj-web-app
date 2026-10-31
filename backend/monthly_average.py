"""Month-level averaging over whatever days were actually recorded.

Rule: average/MTD are computed from however many days this month have a
recorded snapshot -- 5 days in means sum-of-5 / 5, not sum / 30 and not
blank just because day 1 was missed (e.g. tracking started mid-month).
Only a month with zero recorded days at all has nothing to show.
"""
import calendar

from backend.stages.daily_history import get_month_records
from backend.stages.mtd import AVERAGE_KEYS, CONSTANT_KEYS


def compute_month_column(report_date, metric_key: str = "Total Billing"):
    """Running numbers for the current 3-col block for one metric.
    Returns {"asOf", "dailyAverage", "mtdProjected"} or None when this month
    has no recorded days at all (or the metric has no data)."""
    year, month = report_date.year, report_date.month
    values = {
        rec["day"]: rec["values"][metric_key]
        for rec in get_month_records(year, month)
        if rec["day"] <= report_date.day and metric_key in rec["values"]
    }
    if not values:
        return None
    as_of = values.get(report_date.day)
    if metric_key in CONSTANT_KEYS:
        avg = proj = as_of
    elif metric_key in AVERAGE_KEYS:
        avg = sum(values.values()) / len(values)
        proj = avg  # snapshot metric: projecting a point-in-time reading is meaningless
    else:
        avg = sum(values.values()) / len(values)
        proj = avg * calendar.monthrange(year, month)[1]
    return {"asOf": as_of, "dailyAverage": avg, "mtdProjected": proj}


def finalize_month(year: int, month: int):
    """Static 2-col figures for a completed month:
    {metric_key: {"daily_avg", "mtd"}}, or None when no days were recorded
    at all this month."""
    records = get_month_records(year, month)
    if not records:
        return None
    per_metric = {}
    for rec in records:
        for key, value in rec["values"].items():
            per_metric.setdefault(key, []).append(value)
    out = {}
    for key, vals in per_metric.items():
        if key in CONSTANT_KEYS:
            out[key] = {"daily_avg": vals[-1], "mtd": vals[-1]}
        elif key in AVERAGE_KEYS:
            avg = sum(vals) / len(vals)
            out[key] = {"daily_avg": avg, "mtd": avg}
        else:
            total = sum(vals)
            out[key] = {"daily_avg": total / len(vals), "mtd": total}
    return out
