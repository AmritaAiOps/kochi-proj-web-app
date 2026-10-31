import pytest

from backend import format_validator
from backend.format_validator import diff_headers, reset_baseline, validate_upload


@pytest.fixture(autouse=True)
def isolated_baselines(tmp_path, monkeypatch):
    monkeypatch.setattr(format_validator, "BASELINE_PATH", tmp_path / "schema_baselines.json")


def _xlsx_bytes(headers, rows=()):
    import io
    import pandas as pd
    buf = io.BytesIO()
    pd.DataFrame(list(rows), columns=headers).to_excel(buf, index=False, sheet_name="Bed Occupancy")
    return buf.getvalue()


BED_OCC_HEADERS = ["Category", "Bed Strength", "Beds Available for Admission",
                   "Beds Occupied", "Percentage of Utilisation(%)"]
MAPPING = {"Bed Occupancy": "f.xlsx::Bed Occupancy"}


def test_first_run_creates_baseline_and_passes():
    error, warnings = validate_upload(MAPPING, {"f.xlsx": _xlsx_bytes(BED_OCC_HEADERS)})
    assert error is None and warnings == []
    assert format_validator.load_baselines()["Bed Occupancy"] == BED_OCC_HEADERS


def test_missing_baseline_column_hard_fails_with_spec_shape():
    validate_upload(MAPPING, {"f.xlsx": _xlsx_bytes(BED_OCC_HEADERS)})  # establish baseline
    renamed = ["Category", "Bed Capacity"] + BED_OCC_HEADERS[2:]  # "Bed Strength" renamed
    error, _ = validate_upload(MAPPING, {"f.xlsx": _xlsx_bytes(renamed)})
    assert error == {"code": "SCHEMA_MISMATCH", "category": "Bed Occupancy",
                     "missingColumns": ["Bed Strength"]}


def test_reordered_columns_warn_but_pass():
    validate_upload(MAPPING, {"f.xlsx": _xlsx_bytes(BED_OCC_HEADERS)})
    reordered = list(reversed(BED_OCC_HEADERS))
    error, warnings = validate_upload(MAPPING, {"f.xlsx": _xlsx_bytes(reordered)})
    assert error is None
    assert any("reordered" in w for w in warnings)


def test_extra_column_warns_but_passes():
    validate_upload(MAPPING, {"f.xlsx": _xlsx_bytes(BED_OCC_HEADERS)})
    error, warnings = validate_upload(MAPPING, {"f.xlsx": _xlsx_bytes(BED_OCC_HEADERS + ["New Col"])})
    assert error is None
    assert any("extra column" in w.lower() for w in warnings)


def test_reset_baseline_allows_new_format():
    validate_upload(MAPPING, {"f.xlsx": _xlsx_bytes(BED_OCC_HEADERS)})
    renamed = ["Category", "Bed Capacity"] + BED_OCC_HEADERS[2:]
    assert validate_upload(MAPPING, {"f.xlsx": _xlsx_bytes(renamed)})[0] is not None
    assert reset_baseline("Bed Occupancy")
    error, _ = validate_upload(MAPPING, {"f.xlsx": _xlsx_bytes(renamed)})
    assert error is None  # renamed layout is now the baseline


def test_diff_headers_normalizes_punctuation_and_case():
    result = diff_headers("X", ["MRD  no."], ["Mrd No"])
    assert result["missing"] == []
