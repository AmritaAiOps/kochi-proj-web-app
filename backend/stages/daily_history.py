"""Persists each day's Final output values so MTD (month-to-date) and Daily
Average can be computed for the current month.

This app processes one day at a time and has no other memory of past days,
so true MTD (a running sum from the 1st of the month) requires remembering
every day already processed this month. That's what this store is for --
distinct from config/category_map.json and config/learned_overrides.json,
which are about category mapping, not daily figures.

Note: MTD/Daily Average will only reflect days actually processed through
this app. A month that started before this tool was in use will show a
partial MTD (missing the days before tracking began), not the true
month-to-date total -- there's no way to backfill days we never received.
"""
import calendar
import json
from pathlib import Path

from backend.runtime_paths import CONFIG_DIR

HISTORY_PATH = CONFIG_DIR / "daily_history.json"


def load_history() -> dict:
    if not HISTORY_PATH.exists():
        return {}
    return json.loads(HISTORY_PATH.read_text())


def save_history(history: dict) -> None:
    HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    HISTORY_PATH.write_text(json.dumps(history, indent=2, sort_keys=True))


def month_key(report_date) -> str:
    return report_date.strftime("%Y-%m")


def _is_valid_day_for_month(month: str, day) -> bool:
    """True only if `day` is a real calendar day for the "YYYY-MM" string
    `month` -- i.e. this entry is actually self-consistent, not just nested
    under a month key by coincidence.

    Storage nests day-of-month under a month key (history[month][metric][day]),
    but that nesting is just dict structure -- nothing about it guarantees the
    day is a real day of that month. A single record_day() call can't produce
    a mismatch (both pieces come from the same `date` object), but nothing
    stops a future caller, a hand-edit of daily_history.json, or a merge/
    migration from inserting a day under the wrong month bucket (e.g. day 30
    under a February, or a day meant for one month landing under another).
    Without this check, get_month_series/get_month_records would sum such an
    entry into that month's MTD/Daily Average with no warning at all. Both the
    write path (record_day) and the read path (get_month_series,
    get_month_records) enforce this so a mis-filed entry is
    rejected/excluded instead of silently corrupting a figure.
    """
    try:
        year, mon = (int(part) for part in month.split("-"))
        day = int(day)
    except (ValueError, AttributeError, TypeError):
        return False
    return 1 <= day <= calendar.monthrange(year, mon)[1]


def record_day(report_date, values: dict, metric_keys: list) -> dict:
    """Stores today's value for each of metric_keys under this month, keyed
    by day-of-month. Re-processing the same date overwrites that day's entry
    rather than double-counting it. Returns the updated history.

    Raises ValueError if the (month, day) pair being written isn't a real
    calendar date -- this should never trip given a real `date` object, but
    turns the month/day relationship into an enforced invariant rather than
    an accident of always being called correctly.
    """
    history = load_history()
    month = month_key(report_date)
    day = str(report_date.day)
    if not _is_valid_day_for_month(month, day):
        raise ValueError(f"Refusing to record day {day!r} under month {month!r}: not a valid calendar date.")

    month_history = history.setdefault(month, {})
    for key in metric_keys:
        if key not in values:
            continue
        metric_series = month_history.setdefault(key, {})
        metric_series[day] = values[key]

    save_history(history)
    return history


def get_month_series(history: dict, report_date, metric_key: str) -> dict:
    """{day_of_month (int) -> value} for every day from the 1st through
    report_date that has a recorded value for metric_key. Missing days are
    simply absent (not assumed to be zero for display, but contribute
    nothing to a sum).

    Entries whose day isn't actually a valid calendar day for this month
    (e.g. a mis-filed or corrupted entry) are excluded rather than trusted,
    so they can never silently inflate/deflate the MTD sum or Daily Average.
    """
    month = month_key(report_date)
    metric_series = history.get(month, {}).get(metric_key, {})
    return {
        int(day): value
        for day, value in metric_series.items()
        if _is_valid_day_for_month(month, day) and int(day) <= report_date.day
    }


def get_month_records(year: int, month: int) -> list:
    """One dict per recorded day: {"day": int, "values": {metric_key: value}}.
    Mis-filed days (see _is_valid_day_for_month) are excluded."""
    month_str = f"{year:04d}-{month:02d}"
    month_data = load_history().get(month_str, {})
    days = sorted({int(d) for series in month_data.values() for d in series if _is_valid_day_for_month(month_str, d)})
    return [
        {"day": day, "values": {k: s[str(day)] for k, s in month_data.items() if str(day) in s}}
        for day in days
    ]
