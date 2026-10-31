import datetime

import pytest

import backend.stages.daily_history as dh


def test_load_history_returns_empty_dict_when_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(dh, "HISTORY_PATH", tmp_path / "missing.json")
    assert dh.load_history() == {}


def test_record_day_then_get_month_series(tmp_path, monkeypatch):
    monkeypatch.setattr(dh, "HISTORY_PATH", tmp_path / "history.json")

    d1 = datetime.date(2026, 6, 1)
    d2 = datetime.date(2026, 6, 2)
    dh.record_day(d1, {"OP Encounters": 100}, ["OP Encounters"])
    dh.record_day(d2, {"OP Encounters": 150}, ["OP Encounters"])

    history = dh.load_history()
    series = dh.get_month_series(history, d2, "OP Encounters")
    assert series == {1: 100, 2: 150}


def test_record_day_overwrites_same_day_not_double_counts(tmp_path, monkeypatch):
    monkeypatch.setattr(dh, "HISTORY_PATH", tmp_path / "history.json")

    d = datetime.date(2026, 6, 5)
    dh.record_day(d, {"OP Encounters": 100}, ["OP Encounters"])
    dh.record_day(d, {"OP Encounters": 999}, ["OP Encounters"])  # re-processed, corrected

    history = dh.load_history()
    series = dh.get_month_series(history, d, "OP Encounters")
    assert series == {5: 999}


def test_get_month_series_excludes_days_after_report_date(tmp_path, monkeypatch):
    monkeypatch.setattr(dh, "HISTORY_PATH", tmp_path / "history.json")

    dh.record_day(datetime.date(2026, 6, 1), {"X": 1}, ["X"])
    dh.record_day(datetime.date(2026, 6, 20), {"X": 99}, ["X"])

    history = dh.load_history()
    series = dh.get_month_series(history, datetime.date(2026, 6, 10), "X")
    assert series == {1: 1}  # day 20 is in the future relative to day 10


def test_get_month_series_scoped_to_month():
    history = {
        "2026-05": {"OP Encounters": {"31": 500}},
        "2026-06": {"OP Encounters": {"1": 100}},
    }
    series = dh.get_month_series(history, datetime.date(2026, 6, 1), "OP Encounters")
    assert series == {1: 100}


def test_record_day_ignores_keys_missing_from_values(tmp_path, monkeypatch):
    monkeypatch.setattr(dh, "HISTORY_PATH", tmp_path / "history.json")

    d = datetime.date(2026, 6, 1)
    dh.record_day(d, {"OP Encounters": 100}, ["OP Encounters", "Nonexistent Key"])

    history = dh.load_history()
    assert "Nonexistent Key" not in history["2026-06"]


def test_record_day_accumulates_when_recorded_out_of_order(tmp_path, monkeypatch):
    monkeypatch.setattr(dh, "HISTORY_PATH", tmp_path / "history.json")

    # Backfilled/reprocessed out of calendar order -- day 20 before day 5,
    # day 1 last. Storage keys by day-of-month, not insertion order, so the
    # resulting series and MTD sum must not depend on write order.
    dh.record_day(datetime.date(2026, 6, 20), {"OP Encounters": 50}, ["OP Encounters"])
    dh.record_day(datetime.date(2026, 6, 5), {"OP Encounters": 20}, ["OP Encounters"])
    dh.record_day(datetime.date(2026, 6, 1), {"OP Encounters": 10}, ["OP Encounters"])

    history = dh.load_history()
    series = dh.get_month_series(history, datetime.date(2026, 6, 20), "OP Encounters")
    assert series == {1: 10, 5: 20, 20: 50}
    assert sum(series.values()) == 80


def test_is_valid_day_for_month():
    assert dh._is_valid_day_for_month("2026-06", "1") is True
    assert dh._is_valid_day_for_month("2026-06", "30") is True
    assert dh._is_valid_day_for_month("2026-06", "31") is False  # June has 30 days
    assert dh._is_valid_day_for_month("2026-02", "29") is False  # 2026 is not a leap year
    assert dh._is_valid_day_for_month("2024-02", "29") is True  # 2024 is a leap year
    assert dh._is_valid_day_for_month("2026-06", "0") is False
    assert dh._is_valid_day_for_month("2026-06", "not-a-day") is False


def test_record_day_rejects_a_day_not_valid_for_its_month(tmp_path, monkeypatch):
    monkeypatch.setattr(dh, "HISTORY_PATH", tmp_path / "history.json")

    # A real date.day is always valid for its own month, so this can only be
    # triggered by calling record_day with a mismatched (month, day) pair --
    # confirms the invariant is actually enforced, not just documented.
    fake_date = type("FakeDate", (), {"day": 31, "strftime": lambda self, fmt: "2026-02"})()
    with pytest.raises(ValueError, match="not a valid calendar date"):
        dh.record_day(fake_date, {"OP Encounters": 100}, ["OP Encounters"])


def test_get_month_series_excludes_entry_mis_filed_under_wrong_month(tmp_path, monkeypatch):
    monkeypatch.setattr(dh, "HISTORY_PATH", tmp_path / "history.json")

    # Simulates corruption/mis-filing that record_day itself can no longer
    # produce (e.g. a hand-edited daily_history.json, or an entry inserted by
    # a future code path that bypasses record_day): day 30 stored under
    # February, which has no 30th. This must never leak into February's MTD
    # sum or Daily Average.
    history = {
        "2026-02": {
            "OP Encounters": {"1": 100, "15": 200, "30": 99999},
        },
    }
    series = dh.get_month_series(history, datetime.date(2026, 2, 28), "OP Encounters")
    assert series == {1: 100, 15: 200}
    assert 99999 not in series.values()
    assert sum(series.values()) == 300
