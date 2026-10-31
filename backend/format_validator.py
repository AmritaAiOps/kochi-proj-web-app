"""Stage 0: schema/format validation, runs on the confirmed upload mapping
BEFORE the processing pipeline.

Each report category has a baseline header list in
backend/data/schema_baselines.json. First run for a category: the actual
file's headers are validated against the built-in reference headers (seeded
from the confirmed sample workbook), then stored as the baseline ("baseline
created"). Later runs diff against the stored baseline:
  - baseline column missing from the file -> HARD FAIL (SCHEMA_MISMATCH)
  - extra or reordered columns -> warning only, logged, never blocks
Sheet location itself is not re-done here -- by the time /process runs, the
user has already confirmed the sheet mapping via the detection/manual-assign
flow, which is this app's existing "unmatched review" path.
"""
import io
import json
import logging
from pathlib import Path

import pandas as pd

from backend.stages.detection import find_header_row, normalize_alnum
from backend.stages.loading import parse_candidate_id

logger = logging.getLogger(__name__)

from backend.runtime_paths import DATA_DIR

BASELINE_PATH = DATA_DIR / "schema_baselines.json"

# Confirmed from the real sample workbook -- used only to validate the very
# first upload of each category, before its actual headers become the baseline.
REFERENCE_HEADERS = {
    "OP New Registration": ["Mrd Number", "Patient Name", "Speciality", "Fee Paid?", "Amount",
                            "Registration Date", "Remarks", "Created By"],
    "OP Encounters": ["S.No.", "VisitDate", "Mrd No", "Patient Name", "TokenNumber", "Visit Id",
                      "Doctor", "Remarks", "Login Id"],
    "Admission Analysis": ["Speciality", "Total Emergency Admission", "Total Planned Admission",
                           "Total admission from OP (walk-in)", "Total"],
    "IP Admission": ["Sl.No.", "MRD No", "SpecialityName", "Patient Name", "District", "Age", "Gender",
                     "ConsultingDoctor", "Admit Date", "Disch Date", "Disch.Approved Date", "Ward",
                     "Visit code", "Category", "Days", "Bill Created?", "Bed Type", "Patient Status"],
    "IP Discharges": ["S.No.", "MrdNo", "SpecialityName", "PatientName", "ConsultingDoctor",
                      "Admitted Date", "Discharge Date", "Disch Date Approved", "Disch MarkedTime",
                      "Send For Billing Time", "Ward", "Visit Code", "Category", "Discharge status",
                      "Discharge Summary Approved Time", "Days"],
    "Billing INR OP": ["Sl.No.", "Bill No.", "User Name", "Date", "Time", "MRD No.", "Visit Code",
                       "Bill Type", "Patient Name", "Category", "TotalAmt(Inc.Tax)", "Credit Amt",
                       "Disc Amt", "Write off Amt", "Net Amt", "Paid Amt", "Payment Due",
                       "RefundedAmt", "BillWiseDiscount", "ItemWiseDiscount"],
    "Billing INR IP": ["Sl.No.", "Bill No.", "User Name", "Discharge Date", "MRD No.", "Visit Code",
                       "Bill Type", "Patient Name", "Category", "Total Amt(Inc.Tax)", "Credit Amt",
                       "Disc Amt", "Write off Amt", "Net Amt", "Paid Amt", "Payment Due",
                       "RefundedAmt", "Tax", "Pay Status", "Bill Status"],
    "AEPL Billing": ["SL.NO", "AEPL Bill No", "Posted Date", "MRD", "Patient Name",
                     "Posted Debit Amount", "Posted Credit Amount", "Bill type", "Aims Bill Number",
                     "Status", "Confirmed Date", "Account Head", "Patient Category"],
    "Bed Occupancy": ["Category", "Bed Strength", "Beds Available for Admission", "Beds Occupied",
                      "Percentage of Utilisation(%)"],
}


def load_baselines() -> dict:
    if not BASELINE_PATH.exists():
        return {}
    return json.loads(BASELINE_PATH.read_text())


def save_baselines(baselines: dict) -> None:
    BASELINE_PATH.parent.mkdir(parents=True, exist_ok=True)
    BASELINE_PATH.write_text(json.dumps(baselines, indent=2, sort_keys=True))


def reset_baseline(category: str) -> bool:
    """Drops the stored baseline; the next upload's headers become the new
    baseline. Returns True if there was one to drop."""
    baselines = load_baselines()
    if category not in baselines:
        return False
    del baselines[category]
    save_baselines(baselines)
    logger.info("format_validator: baseline for %r reset; next upload re-creates it.", category)
    return True


def extract_headers(file_content: bytes, sheet_name: str) -> list:
    """Actual header row of a sheet, using the same header-row detection the
    rest of the app uses (which already outranks interleaved section-header
    rows like OP Encounters' 'Speciality' group rows -- they have far fewer
    text cells than the real header)."""
    excel_file = pd.ExcelFile(io.BytesIO(file_content))
    preview = excel_file.parse(sheet_name=sheet_name, header=None, nrows=15)
    _, header_row = find_header_row(preview.values.tolist())
    return [str(cell).strip() for cell in header_row if isinstance(cell, str) and cell.strip()]


def diff_headers(category: str, actual_headers: list, baseline_headers: list) -> dict:
    """Compares on normalized names so whitespace/punctuation drift doesn't
    false-fail. Missing baseline columns -> hard fail; extra/reordered -> warn."""
    actual_normalized = {normalize_alnum(h) for h in actual_headers}
    missing = [h for h in baseline_headers if normalize_alnum(h) not in actual_normalized]
    baseline_normalized = {normalize_alnum(h) for h in baseline_headers}
    extra = [h for h in actual_headers if normalize_alnum(h) not in baseline_normalized]

    warnings = []
    if extra:
        warnings.append(f"{category}: extra column(s) not in baseline: {', '.join(extra)}")
    elif not missing and [normalize_alnum(h) for h in actual_headers] != [normalize_alnum(h) for h in baseline_headers]:
        warnings.append(f"{category}: columns reordered vs baseline (all present).")
    return {"missing": missing, "warnings": warnings}


def validate_upload(mapping: dict, file_bytes: dict):
    """mapping: report_type -> "filename::sheetname" (already user-confirmed).
    Returns (error, warnings): error is the spec'd SCHEMA_MISMATCH dict for
    the first hard-failing category (blocks the run), or None; warnings is a
    list of non-blocking messages (also logged).
    """
    baselines = load_baselines()
    all_warnings = []
    changed = False

    for category, candidate_id in mapping.items():
        source_file, sheet_name = parse_candidate_id(candidate_id)
        if source_file not in file_bytes:
            continue  # loading.build_dataframes reports this with its own message
        try:
            actual = extract_headers(file_bytes[source_file], sheet_name)
        except Exception:  # unreadable sheet -> let the existing loading error surface it
            continue

        first_run = category not in baselines
        baseline = baselines.get(category) or REFERENCE_HEADERS.get(category, [])
        result = diff_headers(category, actual, baseline)

        if result["missing"] and first_run:
            # Seeded reference is advisory only: the first real file becomes
            # the baseline, so a drift vs the sample workbook just warns.
            warning = f"{category}: differs from reference headers ({', '.join(result['missing'])} absent); adopting actual headers as baseline."
            logger.warning("format_validator: %s", warning)
            all_warnings.append(warning)
            result["missing"] = []

        if result["missing"]:
            logger.error("format_validator: %s missing baseline columns: %s", category, result["missing"])
            return {
                "code": "SCHEMA_MISMATCH",
                "category": category,
                "missingColumns": result["missing"],
            }, all_warnings

        for warning in result["warnings"]:
            logger.warning("format_validator: %s", warning)
        all_warnings.extend(result["warnings"])

        if first_run:
            baselines[category] = actual
            changed = True
            logger.info("format_validator: baseline created for %r from %s::%s", category, source_file, sheet_name)

    if changed:
        save_baselines(baselines)
    return None, all_warnings
