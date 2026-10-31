from backend.stages import category_mapping as cm


def test_domestic_cpr():
    assert cm.map_category("CPR") == "CPR"
    assert cm.map_region("CPR") == "Domestic"


def test_domestic_general_variant_case_and_space_insensitive():
    assert cm.map_category("  gnl ") == "General"
    assert cm.map_region("GNL") == "Domestic"


def test_domestic_echs():
    assert cm.map_category("ECHS 2025") == "ECHS"
    assert cm.map_region("echs2025") == "Domestic"


def test_domestic_tpa():
    assert cm.map_category("TPA 24") == "TPA"
    assert cm.map_region("TPA 24") == "Domestic"


def test_domestic_p_card_fund():
    assert cm.map_category("P CARD FUND") == "P CARD FUND"
    assert cm.map_region("P CARD FUND") == "Domestic"


def test_international_cpr():
    assert cm.map_category("CPR - Oman") == "CPR"
    assert cm.map_region("CPR - Oman") == "International"


def test_international_general():
    assert cm.map_category("GNL - Oman") == "General"
    assert cm.map_region("GNL - Oman") == "International"


def test_international_tpa():
    assert cm.map_category("TPA-AASANDHA") == "TPA"
    assert cm.map_region("TPA-AASANDHA") == "International"


def test_unmapped_value_returns_none():
    assert cm.map_category("Totally Unknown Category XYZ") is None
    assert cm.map_region("Totally Unknown Category XYZ") is None


def test_display_label_cpr_shows_as_corporates():
    assert cm.display_label("CPR") == "Corporates"
    assert cm.display_label("General") == "General"


def test_normalize_loose_strips_all_punctuation():
    assert cm.normalize_loose("CPR - 25") == "cpr25"


def test_resolve_region_uses_override_bucket_not_config():
    overrides = {cm.normalize_loose("Some Weird Corp"): "TPA"}
    assert cm.resolve_region("Some Weird Corp", overrides) == "Domestic"


def test_resolve_region_excluded_override_returns_none():
    overrides = {cm.normalize_loose("Junk Value"): cm.EXCLUDED}
    assert cm.resolve_region("Junk Value", overrides) is None


def test_resolve_region_falls_back_to_map_region_without_override():
    assert cm.resolve_region("CPR - Oman", overrides=None) == "International"
    assert cm.resolve_region("CPR - Oman", overrides={}) == "International"
    assert cm.normalize_loose("CPR25.") == "cpr25"
    assert cm.normalize_loose(None) == ""


def test_resolve_category_falls_back_to_map_category_without_overrides():
    assert cm.resolve_category("CPR") == "CPR"
    assert cm.resolve_category("Totally Unknown") is None


def test_resolve_category_uses_override_when_present():
    overrides = {cm.normalize_loose("Weird ESI Variant"): "ECHS"}
    assert cm.resolve_category("Weird ESI Variant", overrides) == "ECHS"
    # override key matching is loose-normalized, so punctuation/case differences still match
    assert cm.resolve_category("weird-esi variant!", overrides) == "ECHS"


def test_resolve_category_override_does_not_affect_other_values():
    overrides = {cm.normalize_loose("Weird ESI Variant"): "ECHS"}
    assert cm.resolve_category("CPR", overrides) == "CPR"
    assert cm.resolve_category("Still Unknown", overrides) is None


def test_resolve_category_excluded_sentinel_resolves_to_none():
    overrides = {cm.normalize_loose("Junk Value"): cm.EXCLUDED}
    assert cm.resolve_category("Junk Value", overrides) is None


def test_is_overridden_true_for_bucket_and_excluded_false_otherwise():
    overrides = {
        cm.normalize_loose("Weird ESI Variant"): "ECHS",
        cm.normalize_loose("Junk Value"): cm.EXCLUDED,
    }
    assert cm.is_overridden("Weird ESI Variant", overrides) is True
    assert cm.is_overridden("Junk Value", overrides) is True
    assert cm.is_overridden("Never Touched", overrides) is False
    assert cm.is_overridden("Weird ESI Variant", None) is False


def test_undocumented_year_variant_is_not_silently_mapped_but_suggested():
    from backend.stages.category_review import fuzzy_best_match
    assert cm.map_category("CPR 27") is None
    assert fuzzy_best_match("CPR 27")["bucket"] == "CPR"


def test_unconfirmed_codes_go_to_review_with_suggestion_until_confirmed():
    from backend.stages.category_review import fuzzy_best_match
    assert cm.map_category("TPA 26") is None and cm.map_region("TPA 26") is None
    assert fuzzy_best_match("TPA 26")["bucket"] == "TPA"
    for raw in ("labcpr25op.1", "labcpr26op.1"):
        assert cm.map_category(raw) == "CPR" and cm.map_region(raw) == "Domestic"
    for raw in ("INHS 2025", "INHS GNL"):
        assert cm.map_category(raw) == "General" and cm.map_region(raw) == "Domestic"
    overrides = {cm.normalize_loose("TPA 26"): "TPA"}
    assert cm.resolve_category("TPA 26", overrides) == "TPA"
    assert cm.resolve_region("TPA 26", overrides) == "Domestic"
