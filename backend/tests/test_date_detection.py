import datetime

import pandas as pd

from backend.stages.date_detection import detect_report_date


def test_detect_report_date_picks_the_most_common_date():
    rows = [
        ["Mrd Number", "Registration Date"],
        [1, datetime.datetime(2026, 6, 18)],
        [2, datetime.datetime(2026, 6, 18)],
        [3, datetime.datetime(2026, 6, 18)],
        [4, datetime.datetime(2026, 6, 17)],  # stray outlier
    ]
    result = detect_report_date([(0, rows)])
    assert result == "2026-06-18"


def test_detect_report_date_combines_multiple_sheets():
    sheet_a = [
        ["Mrd Number", "Registration Date"],
        [1, datetime.datetime(2026, 6, 18)],
    ]
    sheet_b = [
        ["Bill No", "Bill Date"],
        [1, datetime.datetime(2026, 6, 18)],
        [2, datetime.datetime(2026, 6, 18)],
    ]
    result = detect_report_date([(0, sheet_a), (0, sheet_b)])
    assert result == "2026-06-18"


def test_detect_report_date_returns_none_when_no_date_columns():
    rows = [
        ["Category", "Beds Occupied"],
        ["General", 25],
    ]
    result = detect_report_date([(0, rows)])
    assert result is None


def test_detect_report_date_skips_unparseable_values():
    rows = [
        ["Name", "Some Date"],
        ["A", "not a date"],
        ["B", datetime.datetime(2026, 6, 18)],
    ]
    result = detect_report_date([(0, rows)])
    assert result == "2026-06-18"


def test_detect_report_date_from_real_sample_workbook():
    xls = pd.ExcelFile("Daily report to automate.xlsx")
    sheets_to_scan = [
        "7.OP new registration",
        "8.OP encounters",
        "Billing INR OP 30",
    ]
    sheets = []
    for sheet_name in sheets_to_scan:
        preview = xls.parse(sheet_name=sheet_name, header=None, nrows=20)
        sheets.append((0, preview.values.tolist()))

    result = detect_report_date(sheets)
    assert result == "2026-06-18"
