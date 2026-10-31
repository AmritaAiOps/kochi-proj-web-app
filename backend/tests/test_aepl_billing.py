import pandas as pd

from backend.stages.aepl_billing import process_aepl_billing


def test_process_aepl_billing_excludes_nn_and_np_and_computes_debit_minus_credit():
    df = pd.DataFrame({
        "AEPL Bill No": [
            "IPF/IPB_BC01/26/580",
            "IPF/NNBC01/26/581",
            "IPF/NPBC01/26/582",
            "OPD/IPB_BC01/26/915",
        ],
        "Posted Debit Amt": [1000, 5000, 3000, 500],
        "Posted Credit Amt": [200, 100, 50, 300],
    })
    result = process_aepl_billing(df)
    # Only rows 1 and 4 survive: debit (1000+500) - credit (200+300)
    assert result == 1000.0


def test_process_aepl_billing_case_insensitive_nn_np_match():
    df = pd.DataFrame({
        "AEPL Bill No": ["ipf/nnbc01/26/1", "ipf/npbc01/26/2", "ipf/ipb_bc01/26/3"],
        "Posted Debit Amt": [100, 200, 300],
        "Posted Credit Amt": [0, 0, 0],
    })
    result = process_aepl_billing(df)
    assert result == 300.0


def test_process_aepl_billing_returns_float_type():
    df = pd.DataFrame({
        "AEPL Bill No": ["IPF/IPB_BC01/26/580"],
        "Posted Debit Amt": [100],
        "Posted Credit Amt": [10],
    })
    result = process_aepl_billing(df)
    assert isinstance(result, float)
    assert result == 90.0


def test_process_aepl_billing_handles_real_column_name_variant():
    # Real sheet header is "Posted Debit Amount" / "Posted Credit Amount", not "Amt"
    df = pd.DataFrame({
        "AEPL Bill No": ["IPF/IPB_BC01/26/580", "IPF/NNBC01/26/581"],
        "Posted Debit Amount": [1000, 9999],
        "Posted Credit Amount": [100, 9999],
    })
    result = process_aepl_billing(df)
    assert result == 900.0
