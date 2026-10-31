import pandas as pd
import pytest

from backend.stages.loading import build_dataframes, make_candidate_id, parse_candidate_id


def test_make_and_parse_candidate_id_roundtrip():
    candidate_id = make_candidate_id("report.xlsx", "Sheet1")
    assert candidate_id == "report.xlsx::Sheet1"
    assert parse_candidate_id(candidate_id) == ("report.xlsx", "Sheet1")


def test_parse_candidate_id_rejects_malformed_input():
    with pytest.raises(ValueError):
        parse_candidate_id("no-separator-here")


def test_build_dataframes_missing_file_raises_value_error():
    with pytest.raises(ValueError, match="was not uploaded"):
        build_dataframes({"Bed Occupancy": "missing.xlsx::Sheet1"}, {})


def test_build_dataframes_missing_sheet_raises_value_error(tmp_path):
    import openpyxl

    wb = openpyxl.Workbook()
    wb.active.title = "OnlySheet"
    path = tmp_path / "f.xlsx"
    wb.save(path)
    with open(path, "rb") as f:
        content = f.read()

    with pytest.raises(ValueError, match="not found"):
        build_dataframes({"Bed Occupancy": "f.xlsx::WrongSheet"}, {"f.xlsx": content})


def test_build_dataframes_loads_real_sample_workbook_end_to_end():
    with open("Daily report to automate.xlsx", "rb") as f:
        content = f.read()

    filename = "Daily report to automate.xlsx"
    mapping = {
        "Bed Occupancy": make_candidate_id(filename, "3.Bed occupancy"),
        "OP New Registration": make_candidate_id(filename, "7.OP new registration"),
        "OP Encounters": make_candidate_id(filename, "8.OP encounters"),
        "Admission Analysis": make_candidate_id(filename, "16,17,18 Admission Analysis"),
        "IP Discharges": make_candidate_id(filename, "IP Discharges 20,21,22,23,24,25"),
        "IP Admission": make_candidate_id(filename, "IP Admission 9,10,11,12,13,14"),
        "Billing INR OP": make_candidate_id(filename, "Billing INR OP 30"),
        "Billing INR IP": make_candidate_id(filename, "Billing INR IP 31"),
        "AEPL Billing": make_candidate_id(filename, "AEPL Billing 58"),
    }

    dataframes = build_dataframes(mapping, {filename: content})

    assert set(dataframes.keys()) == set(mapping.keys())
    # Bed Occupancy header row correctly skips the title row -- real columns, not "Unnamed: 0"
    assert "Category" in dataframes["Bed Occupancy"].columns
    assert "Beds Occupied" in dataframes["Bed Occupancy"].columns
    # OP Encounters stays raw/positional (no named header) for Stage 2's extractor
    assert dataframes["OP Encounters"].columns[0] == 0
