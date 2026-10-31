"""Stage 0.5: auto-detects which of the 9 required reports a given sheet is,
so staff can drop one combined workbook, 9 separate files, or any mix.

Detection order (highest confidence first), per the spec:
  1. Sheet name keyword match -- if exactly one report type's keywords appear
     in the (normalized) sheet name, that's a high-confidence match.
  2. Column-signature fallback -- if the sheet name is ambiguous or matches
     nothing, check the detected header row's columns against a known
     required/excluded keyword set per report type.
  3. Otherwise: undetected. Never silently guess -- surfaced to the frontend
     for manual assignment instead.

A single workbook can carry more than one sheet that matches the same report
type at equal confidence -- e.g. a raw export sheet alongside a staff-curated
copy with Domestic/International and Cash/Credit already tagged per row. When
that happens, backend.main breaks the tie using is_curated_billing_sheet()
below rather than picking whichever sheet happened to come first.
"""
import re

from backend.stages.reports import REPORT_TYPES

# report_type -> list of substrings; a sheet name normalized to alnum-lowercase
# matching ANY of these is considered a hit for that report type.
SHEET_NAME_KEYWORDS = {
    "Bed Occupancy": ["bedoccupancy"],
    "OP New Registration": ["opnewregistration", "newregistration"],
    "OP Encounters": ["opencounters"],
    "IP Admission": ["ipadmission"],
    "Admission Analysis": ["admissionanalysis"],
    "IP Discharges": ["ipdischarge"],
    "Billing INR OP": ["billinginrop"],
    "Billing INR IP": ["billinginrip"],
    "AEPL Billing": ["aepl"],
}

# report_type -> {"require": [...], "exclude": [...]}. All "require" keywords
# must appear as a substring of some normalized column name; none of the
# "exclude" keywords may appear in any column, to disambiguate near-identical
# sheets. Billing INR OP/IP are handled separately in _match_by_columns
# (below) since one sheet can legitimately serve as the source for both --
# see that function's docstring.
COLUMN_SIGNATURES = {
    "Bed Occupancy": {"require": ["bedstrength", "bedsoccupied"]},
    "OP New Registration": {"require": ["mrdnumber", "registrationdate"]},
    "OP Encounters": {"require": ["tokennumber", "loginid"]},
    "IP Admission": {"require": ["admitdate", "bedtype", "patientstatus"]},
    "Admission Analysis": {"require": ["totalemergencyadmission", "totalplannedadmission"]},
    "IP Discharges": {"require": ["dischargestatus", "sendforbillingtime"]},
    "AEPL Billing": {"require": ["aimsbillnumber", "posteddebit", "postedcredit"]},
}


def normalize_alnum(value) -> str:
    if not isinstance(value, str):
        return ""
    return re.sub(r"[^a-z0-9]", "", value.lower())


def find_header_row(rows, max_scan: int = 10):
    """Picks the row (within the first max_scan rows) most likely to be a
    header: the one with the most non-blank string cells. Title rows (a
    single merged text cell) and data rows (numbers/dates) score lower."""
    best_idx, best_score = 0, -1
    scanned = list(rows)[:max_scan]
    for idx, row in enumerate(scanned):
        score = sum(1 for cell in row if isinstance(cell, str) and cell.strip())
        if score > best_score:
            best_score = score
            best_idx = idx
    header_row = scanned[best_idx] if scanned else []
    return best_idx, header_row


def _match_by_sheet_name(sheet_name: str):
    normalized = normalize_alnum(sheet_name)
    hits = [
        report_type
        for report_type, keywords in SHEET_NAME_KEYWORDS.items()
        if any(kw in normalized for kw in keywords)
    ]
    if len(hits) == 1:
        return hits[0]
    return None


# Columns that mark a sheet as already-reconciled by staff rather than a raw
# HIS export -- e.g. a bill list with Domestic/International and Cash/Credit
# already assigned per row. Presence of BOTH is the tie-breaker signal, not a
# report-type match on its own: plenty of correctly-detected sheets (Bed
# Occupancy, IP Admission, ...) will never have these columns at all.
CURATED_TAG_KEYWORDS = ["domint", "dominternational"]
CASH_CREDIT_TAG_KEYWORDS = ["cashcredit"]


def is_curated_billing_sheet(header_row) -> bool:
    """True if the header row has both a Domestic/International tag column
    and a Cash/Credit tag column -- i.e. this sheet's rows were already
    reviewed and classified by hand, as opposed to a raw, unclassified
    export. Used only to break ties between multiple same-report-type sheet
    candidates in the same workbook; never used to assign a report type."""
    normalized_columns = [normalize_alnum(str(cell)) for cell in header_row if cell]
    has_region_tag = any(
        any(kw in col for kw in CURATED_TAG_KEYWORDS) for col in normalized_columns
    )
    has_cash_credit_tag = any(
        any(kw in col for kw in CASH_CREDIT_TAG_KEYWORDS) for col in normalized_columns
    )
    return has_region_tag and has_cash_credit_tag


def _match_by_columns(header_row) -> list:
    """Returns every report type this header row's columns qualify for --
    almost always at most one, except billing.

    A raw bill-listing sheet (Bill Type + TotalAmt + DiscAmt columns) is a
    valid source for BOTH "Billing INR OP" and "Billing INR IP": the actual
    OP/IP split happens per-row downstream (backend.stages.billing filters
    each BillType value out of the SAME sheet), not by which file/sheet the
    rows came from. Forcing a sheet to match only one of the two meant a
    combined sheet with every bill type in it could only ever auto-fill one
    of the two report-type slots, leaving the other stuck on "needs manual
    assignment" even though the very same sheet was the right answer for it
    too. A sheet that additionally carries a "No of days Admitted" column
    has no OP equivalent, so that one signals a dedicated IP-only export --
    offered as IP only, not also as OP.
    """
    normalized_columns = [normalize_alnum(str(cell)) for cell in header_row if cell]

    def has(keyword: str) -> bool:
        return any(keyword in col for col in normalized_columns)

    matches = []
    if has("totalamt") and has("discamt") and has("billtype"):
        if has("noofdaysadmitted"):
            matches.append("Billing INR IP")
        else:
            matches.append("Billing INR OP")
            matches.append("Billing INR IP")

    for report_type, signature in COLUMN_SIGNATURES.items():
        required = signature.get("require", [])
        excluded = signature.get("exclude", [])
        if not all(any(req in col for col in normalized_columns) for req in required):
            continue
        if any(any(exc in col for col in normalized_columns) for exc in excluded):
            continue
        matches.append(report_type)

    return matches


def refine_billing_type_evidence(rows, header_row_idx: int, header_row) -> dict:
    """Scans the Bill Type column's actual values (not just its header) to
    tell whether a generic combined bill-list sheet -- one _match_by_columns
    flagged as a candidate for BOTH "Billing INR OP" and "Billing INR IP"
    because it has no "No of days Admitted" column to tell them apart --
    truly contains O_B rows, IP_D/IP_F rows, or both.

    Needed because a short header-only preview can't distinguish a
    dedicated OP-only export from a combined sheet that stacks OP rows
    first and IP rows much further down (a documented convention: "Total
    Bill Wise rows first, then a separator row, then Discharge Wise IP
    rows") -- callers should pass the FULL sheet's rows here, not a capped
    preview, or IP rows stacked below the preview window will look absent.
    Returns {"op": bool, "ip": bool}; both False means the Bill Type column
    wasn't found or had no recognizable values, i.e. inconclusive.
    """
    normalized_columns = [normalize_alnum(str(cell)) for cell in header_row]
    billtype_idx = next((i for i, col in enumerate(normalized_columns) if "billtype" in col), None)
    if billtype_idx is None:
        return {"op": False, "ip": False}

    op_seen = ip_seen = False
    for row in rows[header_row_idx + 1:]:
        if billtype_idx >= len(row) or not isinstance(row[billtype_idx], str):
            continue
        value = normalize_alnum(row[billtype_idx])
        if value == "ob":
            op_seen = True
        elif value in ("ipd", "ipf"):
            ip_seen = True
        if op_seen and ip_seen:
            break
    return {"op": op_seen, "ip": ip_seen}


def detect_report_type(sheet_name: str, rows) -> dict:
    """rows: the sheet's raw values (list of row tuples/lists), header=None,
    at least the first ~10 rows. Returns
    {report_type, report_types, confidence, matched_via, header_row, curated}.

    "report_type" is the single primary match (back-compat for callers that
    only care about one); "report_types" is every report type this sheet
    qualifies for -- almost always the same singleton, except a combined
    billing sheet, which can legitimately match both "Billing INR OP" and
    "Billing INR IP" at once (see _match_by_columns). "curated" is only ever
    a tie-breaking signal (see is_curated_billing_sheet) -- it never
    influences report_type(s) or confidence themselves.
    """
    header_row_idx, header_row = find_header_row(rows)
    curated = is_curated_billing_sheet(header_row)

    sheet_match = _match_by_sheet_name(sheet_name)
    column_matches = _match_by_columns(header_row)
    # Name says one report but the columns clearly say another: trust the rows,
    # and report the disagreement so the caller can mention it (non-blocking).
    if sheet_match and column_matches and sheet_match not in column_matches:
        return {
            "report_type": column_matches[0],
            "report_types": column_matches,
            "confidence": "medium",
            "matched_via": "columns",
            "header_row": header_row_idx,
            "curated": curated,
            "name_conflict": sheet_match,
        }
    if sheet_match:
        return {
            "report_type": sheet_match,
            "report_types": [sheet_match],
            "confidence": "high",
            "matched_via": "sheet_name",
            "header_row": header_row_idx,
            "curated": curated,
        }

    if column_matches:
        return {
            "report_type": column_matches[0],
            "report_types": column_matches,
            "confidence": "medium",
            "matched_via": "columns",
            "header_row": header_row_idx,
            "curated": curated,
        }

    return {
        "report_type": None,
        "report_types": [],
        "confidence": "none",
        "matched_via": None,
        "header_row": header_row_idx,
        "curated": curated,
    }
