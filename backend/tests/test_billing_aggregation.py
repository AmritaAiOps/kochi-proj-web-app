import logging

import pandas as pd

from backend.stages.billing_aggregation import aggregate_billing


def _row(net, cat, cash_credit, region):
    return {"Net": net, "CAT": cat, "Cash_Credit": cash_credit, "Region": region}


def test_aggregate_billing_computes_all_buckets():
    op_df = pd.DataFrame([
        _row(1000, "General", "Cash", "Domestic"),
        _row(500, "TPA", "Credit", "Domestic"),
        _row(200, "CPR", "Credit", "International"),
    ])
    ip_df = pd.DataFrame([
        _row(2000, "General", "Cash", "Domestic"),
        _row(300, "ECHS", "Credit", "Domestic"),
        _row(150, "TPA", "Credit", "International"),
    ])
    op_total = op_df["Net"].sum()
    ip_total = ip_df["Net"].sum()

    result = aggregate_billing(op_df, ip_df, op_total, ip_total)

    assert result["Billing Domestic"] == 1000 + 500 + 2000 + 300
    assert result["Billing International"] == 200 + 150
    assert result["Billing Total"] == result["Billing Domestic"] + result["Billing International"]

    assert result["Cash Domestic"] == 1000 + 2000
    assert result["Cash International"] == 0

    assert result["Credit Domestic TPA"] == 500
    assert result["Credit Domestic ECHS"] == 300
    assert result["Credit Domestic P.Card.Fund"] == 0
    assert result["Credit Domestic Corporates"] == 0
    assert result["Credit Domestic Total"] == 500 + 300

    assert result["Credit International TPA Aasantha"] == 150
    assert result["Credit International Corporates (International)"] == 200
    assert result["Credit International Total"] == 150 + 200

    assert result["Credit Total Billing"] == result["Credit Domestic Total"] + result["Credit International Total"]

    combined = result["_combined_df"]
    assert set(combined["Source"]) == {"OP", "IP"}
    assert len(combined) == 6


def test_aggregate_billing_tags_source_column():
    op_df = pd.DataFrame([_row(100, "General", "Cash", "Domestic")])
    ip_df = pd.DataFrame([_row(200, "General", "Cash", "Domestic")])
    result = aggregate_billing(op_df, ip_df, 100, 200)
    combined = result["_combined_df"]
    assert combined.loc[combined["Net"] == 100, "Source"].iloc[0] == "OP"
    assert combined.loc[combined["Net"] == 200, "Source"].iloc[0] == "IP"


def test_aggregate_billing_matches_stage5_totals_when_fully_mapped():
    op_df = pd.DataFrame([_row(100, "General", "Cash", "Domestic")])
    ip_df = pd.DataFrame([_row(200, "TPA", "Credit", "International")])
    result = aggregate_billing(op_df, ip_df, 100, 200)
    assert result["Billing Total"] == 300


def test_aggregate_billing_warns_but_does_not_crash_on_unmapped_rows(caplog):
    # Unmapped rows have CAT=None, Region=None, Cash_Credit="Credit" (since CAT != "General")
    op_df = pd.DataFrame([
        _row(100, "General", "Cash", "Domestic"),
        _row(50, None, "Credit", None),  # unmapped
    ])
    ip_df = pd.DataFrame([_row(200, "TPA", "Credit", "International")])
    op_total = 150  # includes the unmapped row's Net
    ip_total = 200

    with caplog.at_level(logging.WARNING):
        result = aggregate_billing(op_df, ip_df, op_total, ip_total)

    # Unmapped row excluded from Domestic/International sums -> Billing Total is short by 50
    assert result["Billing Total"] == 300
    assert any("Billing Total Billing" in record.message for record in caplog.records)
    # Cash + Credit still reconciles against the (excluding-unmapped) Billing Total
    assert not any("Credit total + Cash total" in record.message for record in caplog.records)
