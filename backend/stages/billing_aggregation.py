"""Stage 6: combined billing aggregation across OP + IP."""
import logging

import pandas as pd

logger = logging.getLogger(__name__)

DOMESTIC_CREDIT_BUCKETS = {
    "ECHS": "ECHS",
    "P CARD FUND": "P.Card.Fund",
    "TPA": "TPA",
    "CPR": "Corporates",
}

INTERNATIONAL_CREDIT_BUCKETS = {
    "TPA": "TPA Aasantha",
    "CPR": "Corporates (International)",
}


def _net_sum(df: pd.DataFrame, mask: pd.Series) -> float:
    return df.loc[mask, "Net"].sum()


def aggregate_billing(billing_op_df: pd.DataFrame, billing_ip_df: pd.DataFrame, op_total: float, ip_total: float) -> dict:
    op_tagged = billing_op_df.copy()
    op_tagged["Source"] = "OP"
    ip_tagged = billing_ip_df.copy()
    ip_tagged["Source"] = "IP"
    combined = pd.concat([op_tagged, ip_tagged], ignore_index=True)

    domestic_mask = combined["Region"] == "Domestic"
    international_mask = combined["Region"] == "International"
    cash_mask = combined["Cash_Credit"] == "Cash"
    credit_mask = combined["Cash_Credit"] == "Credit"

    domestic_billing = _net_sum(combined, domestic_mask)
    international_billing = _net_sum(combined, international_mask)
    total_billing = domestic_billing + international_billing

    cash_domestic = _net_sum(combined, cash_mask & domestic_mask)
    cash_international = _net_sum(combined, cash_mask & international_mask)

    credit_domestic_total = _net_sum(combined, credit_mask & domestic_mask)
    credit_international_total = _net_sum(combined, credit_mask & international_mask)
    credit_total_billing = credit_domestic_total + credit_international_total

    result = {
        "Billing Domestic": domestic_billing,
        "Billing International": international_billing,
        "Billing Total": total_billing,
        "Cash Domestic": cash_domestic,
        "Cash International": cash_international,
        "Credit Domestic Total": credit_domestic_total,
        "Credit International Total": credit_international_total,
        "Credit Total Billing": credit_total_billing,
    }

    for cat, key in DOMESTIC_CREDIT_BUCKETS.items():
        result[f"Credit Domestic {key}"] = _net_sum(
            combined, credit_mask & domestic_mask & (combined["CAT"] == cat)
        )

    for cat, key in INTERNATIONAL_CREDIT_BUCKETS.items():
        result[f"Credit International {key}"] = _net_sum(
            combined, credit_mask & international_mask & (combined["CAT"] == cat)
        )

    expected_total = op_total + ip_total
    if not _isclose(total_billing, expected_total):
        logger.warning(
            "Billing Total Billing (%.2f) != Stage5 OP total + IP total (%.2f). "
            "Likely caused by rows with unmapped Category (Region=None) excluded from Domestic/International sums.",
            total_billing, expected_total,
        )

    cash_plus_credit = cash_domestic + cash_international + credit_total_billing
    if not _isclose(cash_plus_credit, total_billing):
        logger.warning(
            "Credit total + Cash total (%.2f) != Billing Total Billing (%.2f).",
            cash_plus_credit, total_billing,
        )

    result["_combined_df"] = combined
    return result


def _isclose(a: float, b: float, tol: float = 0.01) -> bool:
    return abs(a - b) <= tol
