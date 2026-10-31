from backend.api import _pending_billing_values


def test_pending_billing_values_only_blocks_on_resolvable_billing_entries():
    review = {
        "possible_matches": [{"raw_value": "CPR 26", "source_file": "Billing INR IP", "frequency": 2}],
        "unmatched": [
            {"raw_value": None, "source_file": "Billing INR OP", "frequency": 5},
            {"raw_value": "Weird", "source_file": "IP Admission", "frequency": 1},
        ],
    }
    assert _pending_billing_values(review) == ["CPR 26"]
    assert _pending_billing_values({"possible_matches": [], "unmatched": []}) == []
