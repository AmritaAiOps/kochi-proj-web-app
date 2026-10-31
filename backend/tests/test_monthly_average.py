import datetime

import pytest

from backend.monthly_average import compute_month_column, finalize_month
from backend.stages import daily_history


@pytest.fixture(autouse=True)
def isolated_history(tmp_path, monkeypatch):
    monkeypatch.setattr(daily_history, "HISTORY_PATH", tmp_path / "daily_history.json")


def _save(y, m, d, total_billing):
    daily_history.record_day(datetime.date(y, m, d), {"Total Billing": total_billing}, ["Total Billing"])


def test_snapshot_round_trip():
    _save(2026, 6, 1, 500.0)
    records = daily_history.get_month_records(2026, 6)
    assert records == [{"day": 1, "values": {"Total Billing": 500.0}}]
    assert daily_history.get_month_records(2026, 5) == []


def test_month_without_day_one_still_averages_recorded_days():
    _save(2026, 5, 18, 100.0)
    _save(2026, 5, 19, 100.0)
    col = compute_month_column(datetime.date(2026, 5, 19))
    assert col == {"asOf": 100.0, "dailyAverage": 100.0, "mtdProjected": 100.0 * 31}

    fin = finalize_month(2026, 5)
    assert fin["Total Billing"] == {"daily_avg": 200.0 / 2, "mtd": 200.0}


def test_month_with_no_recorded_days_returns_none():
    assert compute_month_column(datetime.date(2026, 5, 19)) is None
    assert finalize_month(2026, 5) is None


def test_running_average_and_projection():
    _save(2026, 6, 1, 100.0)
    col = compute_month_column(datetime.date(2026, 6, 1))
    assert col == {"asOf": 100.0, "dailyAverage": 100.0, "mtdProjected": 3000.0}

    _save(2026, 6, 2, 200.0)
    col = compute_month_column(datetime.date(2026, 6, 2))
    assert col["asOf"] == 200.0
    assert col["dailyAverage"] == 150.0
    assert col["mtdProjected"] == 150.0 * 30


def test_finalize_month_divides_sum_by_recorded_days_not_days_in_month():
    _save(2026, 6, 1, 100.0)
    _save(2026, 6, 2, 200.0)
    fin = finalize_month(2026, 6)
    assert fin["Total Billing"] == {"daily_avg": 300.0 / 2, "mtd": 300.0}


def test_finalize_month_excludes_entry_mis_filed_under_wrong_month(tmp_path, monkeypatch):
    # Simulates a corrupted/mis-filed daily_history.json entry: day 30 has no
    # meaning under February, so a value stored there must never contaminate
    # February's finalized MTD sum / Daily Average, even though it's nested
    # under the "2026-02" key.
    _save(2026, 2, 1, 100.0)
    _save(2026, 2, 15, 200.0)
    history = daily_history.load_history()
    history["2026-02"]["Total Billing"]["30"] = 99999.0
    daily_history.save_history(history)

    records = daily_history.get_month_records(2026, 2)
    assert records == [
        {"day": 1, "values": {"Total Billing": 100.0}},
        {"day": 15, "values": {"Total Billing": 200.0}},
    ]

    fin = finalize_month(2026, 2)
    assert fin["Total Billing"] == {"daily_avg": 300.0 / 2, "mtd": 300.0}
