import datetime

from backend.stages.mtd import compute_mtd_columns, CUMULATIVE_KEYS, AVERAGE_KEYS, CONSTANT_KEYS


def test_cumulative_metric_uses_true_mtd_sum_divided_by_day():
    report_date = datetime.date(2026, 6, 18)
    history = {
        "2026-06": {
            "OP Encounters": {str(d): 200 for d in range(1, 18)},  # days 1-17
        }
    }
    values = {"OP Encounters": 3744}  # today's (day 18) figure
    # get_month_series only includes days already in history for days<=18;
    # day 18 itself isn't in history yet at call time, so seed it via values
    # through record_day in real usage -- here we test the raw math directly
    # by injecting day 18 into history to mirror what main.py does.
    history["2026-06"]["OP Encounters"]["18"] = 3744

    result = compute_mtd_columns(report_date, values, history)
    mtd_actual = 200 * 17 + 3744
    assert result["OP Encounters"]["daily_avg"] == mtd_actual / 18
    assert result["OP Encounters"]["mtd_proj"] == (mtd_actual / 18) * 30


def test_average_metric_averages_days_not_sums():
    report_date = datetime.date(2026, 6, 3)
    history = {
        "2026-06": {
            "Beds Occupied": {"1": 900, "2": 950, "3": 1028},
        }
    }
    values = {"Beds Occupied": 1028}
    result = compute_mtd_columns(report_date, values, history)
    expected_avg = (900 + 950 + 1028) / 3
    assert result["Beds Occupied"]["daily_avg"] == expected_avg
    assert result["Beds Occupied"]["mtd_proj"] == expected_avg  # no *days_in_month scaling


def test_month_without_day_one_still_averages_recorded_days():
    # Automation joined mid-month: day 1 never recorded, but days 18-20 were
    # -> average over those 3 recorded days, not blank.
    report_date = datetime.date(2026, 5, 20)
    history = {"2026-05": {"OP Encounters": {"18": 100, "19": 110, "20": 120}}}
    result = compute_mtd_columns(report_date, {"OP Encounters": 120}, history)
    expected_avg = (100 + 110 + 120) / 3
    assert result["OP Encounters"]["daily_avg"] == expected_avg
    assert result["OP Encounters"]["mtd_proj"] == expected_avg * 31


def test_month_with_no_recorded_days_returns_none():
    report_date = datetime.date(2026, 5, 20)
    history = {}
    assert compute_mtd_columns(report_date, {"OP Encounters": 120}, history) is None


def test_skipped_day_does_not_drag_average():
    # Days 1 and 3 recorded, day 2 skipped -> mean of the 2 recorded days.
    report_date = datetime.date(2026, 6, 3)
    history = {"2026-06": {"OP Encounters": {"1": 100, "3": 300}}}
    result = compute_mtd_columns(report_date, {"OP Encounters": 300}, history)
    assert result["OP Encounters"]["daily_avg"] == 200
    assert result["OP Encounters"]["mtd_proj"] == 200 * 30


def test_constant_metric_carries_value_forward_unchanged():
    report_date = datetime.date(2026, 6, 18)
    values = {"Bed Strength": 1000}
    history = {"2026-06": {"Bed Strength": {"1": 1000}}}
    result = compute_mtd_columns(report_date, values, history)
    assert result["Bed Strength"] == {"daily_avg": 1000, "mtd_proj": 1000}


def test_hospital_revenue_derived_from_row57_minus_aepl_in_every_column():
    # Row 63 = row 57 (grand "Total Billing") minus row 60 (AEPL Billing).
    report_date = datetime.date(2026, 6, 18)
    history = {
        "2026-06": {
            "Total Billing": {"1": 8742193.15, "18": 8742193.15},
            "AEPL Billing": {"1": 9667188.25, "18": 9667188.25},
        }
    }
    values = {
        "Total Billing": 8742193.15,
        "AEPL Billing": 9667188.25,
        "Hospital Revenue (Net of AEPL)": 8742193.15 - 9667188.25,
    }
    result = compute_mtd_columns(report_date, values, history)

    expected_daily_avg = result["Total Billing"]["daily_avg"] - result["AEPL Billing"]["daily_avg"]
    expected_mtd_proj = result["Total Billing"]["mtd_proj"] - result["AEPL Billing"]["mtd_proj"]
    assert result["Hospital Revenue (Net of AEPL)"]["daily_avg"] == expected_daily_avg
    assert result["Hospital Revenue (Net of AEPL)"]["mtd_proj"] == expected_mtd_proj


def test_missing_value_key_is_skipped_not_crashed():
    report_date = datetime.date(2026, 6, 18)
    history = {"2026-06": {"OP Encounters": {"1": 100}}}
    result = compute_mtd_columns(report_date, values={}, history=history)
    assert result == {}


def test_row_map_keys_fully_partitioned_no_overlap():
    overlap = (CUMULATIVE_KEYS & AVERAGE_KEYS) | (CUMULATIVE_KEYS & CONSTANT_KEYS) | (AVERAGE_KEYS & CONSTANT_KEYS)
    assert overlap == set()
