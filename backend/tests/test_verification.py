import pandas as pd

from backend.verification import run_verification, _recount_op_encounters


GOOD_VALUES = {
    "Bed Strength": 1000, "Beds Occupied": 900, "Occupancy %": 0.9,
    "OP Billing": 100.0, "IP Billing": 200.0, "Total Billing": 300.0,
    "Billing Domestic": 250.0, "Billing International": 50.0, "Billing Total": 300.0,
    "Cash Domestic": 100.0, "Cash International": 20.0,
    "Credit Domestic ECHS": 40.0, "Credit Domestic P.Card.Fund": 30.0,
    "Credit Domestic TPA": 60.0, "Credit Domestic Corporates": 20.0,
    "Credit Domestic Total": 150.0,
    "Credit International TPA Aasantha": 20.0,
    "Credit International Corporates (International)": 10.0,
    "Credit International Total": 30.0,
    "Credit Total Billing": 300.0, "AEPL Billing": 10.0,
    "IP Admission Total": 10, "IP Admission General": 4, "IP Admission TPA": 3,
    "IP Admission ECHS": 1, "IP Admission P.Card.Fund": 1, "IP Admission Corporates": 1,
    "IP Discharges Total": 5, "IP Discharges General": 2, "IP Discharges TPA": 1,
    "IP Discharges ECHS": 1, "IP Discharges P.Card.Fund": 1, "IP Discharges Corporates": 0,
}


def test_clean_values_all_pass():
    report = run_verification(GOOD_VALUES, source_data={})
    assert report["allPassed"], [c for c in report["checks"] if not c["pass"]]
    for check in report["checks"]:
        if check["delta"] is not None:
            assert abs(check["delta"]) <= 0.01


def test_broken_reconciliation_fails_that_check_only():
    values = dict(GOOD_VALUES, **{"Total Billing": 999.0, "Billing Total": 999.0,
                                  "Credit Total Billing": 999.0})
    report = run_verification(values, source_data={})
    failed = {c["name"] for c in report["checks"] if not c["pass"]}
    assert "Row 34 Total Billing == row 32 + row 33" in failed
    assert not report["allPassed"]


def test_negative_billing_flagged():
    values = dict(GOOD_VALUES, **{"AEPL Billing": -5.0})
    report = run_verification(values, source_data={})
    check = next(c for c in report["checks"] if c["name"] == "AEPL Billing is not negative")
    assert not check["pass"]


def test_billing_recompute_matches_pipeline_semantics():
    op = pd.DataFrame({
        "Bill Type": ["O_B", "O_B", "IP_D", None],
        "TotalAmt(Inc.Tax)": [100.0, 50.0, 999.0, None],
        "Disc Amt": [10.0, 0.0, 0.0, None],
    })
    ip = pd.DataFrame({
        "Bill Type": ["IP_D", "IP_F", "O_B"],
        "Total Amt(Inc.Tax)": [200.0, 100.0, 999.0],
        "Disc Amt": [50.0, 0.0, 0.0],
    })
    values = dict(GOOD_VALUES, **{"OP Billing": 140.0, "IP Billing": 250.0, "Total Billing": 390.0,
                                  "Billing Total": 390.0, "Credit Total Billing": 390.0,
                                  "Billing Domestic": 340.0, "Cash Domestic": 190.0})
    report = run_verification(values, {"Billing INR OP": op, "Billing INR IP": ip})
    check = next(c for c in report["checks"] if c["name"].startswith("Row 34 Total Billing recompute"))
    assert check["pass"], check  # 90 + 50 + 150 + 100 == 390


def test_recount_op_encounters_counts_detail_rows_with_exclusions():
    rows = [
        ["S.No.", "VisitDate", "Mrd No", "Patient Name"],
        ["Speciality", "Cardiology", None, None],
        [1, "d", "M1", "A"], [2, "d", "M2", "B"],
        ["Total Encounters", None, 2, None],
        ["Speciality", "Radiology", None, None],  # excluded
        [1, "d", "M3", "C"],
        ["Total Encounters", None, 1, None],
    ]
    df = pd.DataFrame(rows)
    assert _recount_op_encounters(df) == 2


def test_check_crash_becomes_failed_check_not_exception():
    # OP New Registration df with no Mrd column -> the check errors but the
    # report still comes back (pipeline result is never masked).
    report = run_verification(GOOD_VALUES | {"OP New Registration": 5},
                              {"OP New Registration": pd.DataFrame({"X": [1]})})
    errored = [c for c in report["checks"] if "check errored" in c["name"]]
    assert errored and not errored[0]["pass"]
