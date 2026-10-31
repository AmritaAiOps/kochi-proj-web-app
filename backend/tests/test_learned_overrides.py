import json

import backend.stages.learned_overrides as lo


def test_load_returns_empty_dict_when_file_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(lo, "LEARNED_OVERRIDES_PATH", tmp_path / "missing.json")
    assert lo.load_learned_overrides() == {}


def test_save_then_load_roundtrips(tmp_path, monkeypatch):
    path = tmp_path / "learned_overrides.json"
    monkeypatch.setattr(lo, "LEARNED_OVERRIDES_PATH", path)

    lo.save_learned_overrides({"esi2025": "ECHS"})
    assert lo.load_learned_overrides() == {"esi2025": "ECHS"}
    assert json.loads(path.read_text()) == {"esi2025": "ECHS"}


def test_add_learned_overrides_merges_with_existing(tmp_path, monkeypatch):
    path = tmp_path / "learned_overrides.json"
    monkeypatch.setattr(lo, "LEARNED_OVERRIDES_PATH", path)

    lo.save_learned_overrides({"esi2025": "ECHS"})
    result = lo.add_learned_overrides({"weirdcustomvalue": "TPA"})

    assert result == {"esi2025": "ECHS", "weirdcustomvalue": "TPA"}
    assert lo.load_learned_overrides() == {"esi2025": "ECHS", "weirdcustomvalue": "TPA"}


def test_add_learned_overrides_overwrites_same_key(tmp_path, monkeypatch):
    path = tmp_path / "learned_overrides.json"
    monkeypatch.setattr(lo, "LEARNED_OVERRIDES_PATH", path)

    lo.save_learned_overrides({"esi2025": "ECHS"})
    result = lo.add_learned_overrides({"esi2025": "General"})

    assert result == {"esi2025": "General"}
