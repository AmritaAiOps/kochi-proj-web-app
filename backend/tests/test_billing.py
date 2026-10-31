import pandas as pd

from backend.stages.billing import process_billing_op, process_billing_ip


def _op_df():
    return pd.DataFrame({
        "Bill\nType": ["IP Bill Counter - 1", "O_B", "O_B", "IP_F"],
        "TotalAmt\n(Inc.Tax)": [None, 1000, 5000, 2000],
        "Disc\nAmt": [None, 100, 500, 200],
        "Category": [None, "GNL", "TPA - AASANTHA 25", "GNL"],
        "Time": [None, "10:00", "11:00", "12:00"],
    })


def test_process_billing_op_filters_and_enriches():
    enriched, total, _review = process_billing_op(_op_df())
    # Junk header row dropped, IP_F row filtered out, only 2 O_B rows remain
    assert len(enriched) == 2
    assert total == 900 + 4500  # Net = TotalAmt - DiscAmt

    cash_row = enriched[enriched["Category"] == "GNL"].iloc[0]
    assert cash_row["CAT"] == "General"
    assert cash_row["Cash_Credit"] == "Cash"
    assert cash_row["Region"] == "Domestic"

    credit_row = enriched[enriched["Category"] == "TPA - AASANTHA 25"].iloc[0]
    assert credit_row["CAT"] == "TPA"
    assert credit_row["Cash_Credit"] == "Credit"
    assert credit_row["Region"] == "International"


def _ip_df():
    return pd.DataFrame({
        "Bill\nType": ["IP Bill Counter - 1", "IP_F", "IP_D", "O_B"],
        "Total Amt\n(Inc. Tax)": [None, 20000, 8000, 3000],
        "Disc\nAmt": [None, 3000, 800, 300],
        "Cate- gory": [None, "GNL", "CPR - Oman", "GNL"],
        "Discharge\nDate": [None, "2026-06-18", "2026-06-19", "2026-06-20"],
    })


def test_process_billing_ip_filters_and_enriches():
    enriched, total, _review = process_billing_ip(_ip_df())
    # Junk header dropped, O_B row filtered out, IP_F + IP_D remain
    assert len(enriched) == 2
    assert total == 17000 + 7200

    cash_row = enriched[enriched["Cate- gory"] == "GNL"].iloc[0]
    assert cash_row["CAT"] == "General"
    assert cash_row["Cash_Credit"] == "Cash"
    assert cash_row["Region"] == "Domestic"

    credit_row = enriched[enriched["Cate- gory"] == "CPR - Oman"].iloc[0]
    assert credit_row["CAT"] == "CPR"
    assert credit_row["Cash_Credit"] == "Credit"
    assert credit_row["Region"] == "International"


def test_process_billing_ip_drops_time_column_if_present():
    df = _ip_df()
    df["Time"] = ["", "10:00", "11:00", "12:00"]
    enriched, _total, _review = process_billing_ip(df)
    assert "Time" not in enriched.columns


def test_process_billing_ip_ok_without_time_column():
    enriched, _total, _review = process_billing_ip(_ip_df())
    assert "Time" not in enriched.columns


def test_unclassified_rows_stay_out_of_total_so_op_ip_matches_domestic_international():
    df = _op_df()
    df.loc[2, "Category"] = "Unknown Code"
    enriched, total, _review = process_billing_op(df)
    assert total == 900  # the unmapped O_B row has no Region, so it isn't counted
    assert total == enriched.loc[enriched["Region"].notna(), "Net"].sum()


def test_row_shifted_one_column_right_is_realigned_not_dropped():
    # Real 09-Oct AFC row: extra blank before Category pushes every value right
    df = pd.DataFrame({
        "Bill\nType": ["O_B", "O_B"],
        "Patient Name": ["A", "SANAL. G"],
        "Category": ["GNL", None],
        "TotalAmt\n(Inc.Tax)": [750, "GNL"],
        "Credit\n Amt": [0, 2630],
        "Disc\nAmt": [150, 0],
        "Write off  Amt": [0, 530],
        "Unnamed: 5": [None, 0],
    })
    enriched, total, _review = process_billing_op(df)
    assert total == 600 + 2100
    assert enriched["Category"].tolist() == ["GNL", "GNL"]
