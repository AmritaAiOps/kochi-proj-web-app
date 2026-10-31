"""Loads a specific sheet out of a specific uploaded file into the DataFrame
shape each Stage 1-7 function expects, using the same header-row detection
Stage 0.5 uses -- so a title row above the real header (e.g. Bed Occupancy)
doesn't need a hardcoded offset.
"""
import io

import pandas as pd

from backend.stages.detection import find_header_row

CANDIDATE_ID_SEPARATOR = "::"


def make_candidate_id(source_file: str, sheet_name: str) -> str:
    return f"{source_file}{CANDIDATE_ID_SEPARATOR}{sheet_name}"


def parse_candidate_id(candidate_id: str):
    if CANDIDATE_ID_SEPARATOR not in candidate_id:
        raise ValueError(f"Malformed candidate id: {candidate_id!r}")
    source_file, sheet_name = candidate_id.split(CANDIDATE_ID_SEPARATOR, 1)
    return source_file, sheet_name


def load_report_dataframe(excel_file: pd.ExcelFile, sheet_name: str, report_type: str) -> pd.DataFrame:
    """OP Encounters is loaded raw (header=None): its processing logic
    (Stage 2's subtotal extractor) walks rows positionally, including the
    'Speciality'/'Total Encounters' label rows a normal header parse would
    otherwise consume. Every other report uses its detected header row.
    """
    if report_type == "OP Encounters":  # scanned row-by-row positionally, so no header offset
        return excel_file.parse(sheet_name=sheet_name, header=None)

    preview = excel_file.parse(sheet_name=sheet_name, header=None, nrows=10)
    header_row_idx, _ = find_header_row(preview.values.tolist())
    return excel_file.parse(sheet_name=sheet_name, header=header_row_idx)


def build_dataframes(mapping: dict, file_bytes: dict) -> dict:
    """mapping: report_type -> candidate_id ("filename::sheetname").
    file_bytes: filename -> raw bytes of the uploaded file.
    Returns report_type -> DataFrame. Raises KeyError/ValueError with a
    plain-language message the caller can surface per report type.
    """
    excel_files = {}  # filename -> cached pd.ExcelFile
    dataframes = {}

    for report_type, candidate_id in mapping.items():
        source_file, sheet_name = parse_candidate_id(candidate_id)

        if source_file not in file_bytes:
            raise ValueError(f"File {source_file!r} referenced in the report mapping was not uploaded.")

        if source_file not in excel_files:
            excel_files[source_file] = pd.ExcelFile(io.BytesIO(file_bytes[source_file]))
        excel_file = excel_files[source_file]

        if sheet_name not in excel_file.sheet_names:
            raise ValueError(f"Sheet {sheet_name!r} not found in {source_file!r}.")

        dataframes[report_type] = load_report_dataframe(excel_file, sheet_name, report_type)

    return dataframes
