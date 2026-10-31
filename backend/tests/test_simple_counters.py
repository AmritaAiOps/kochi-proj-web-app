import pandas as pd

from backend.stages.simple_counters import (
    process_op_new_registration,
    process_op_encounters,
    process_admission_analysis,
    process_bed_occupancy,
)


def test_process_op_new_registration_counts_non_blank_mrd():
    df = pd.DataFrame({
        "Mrd Number": [123, 456, None, 789],
        "Patient Name": ["A", "B", "C", "D"],
    })
    assert process_op_new_registration(df) == 3


def test_process_op_new_registration_ignores_trailing_note_row():
    # Raw HIS exports leave a note in the MRD column below the data; it must
    # not be counted as a registration (a plain notna() count would return 4).
    df = pd.DataFrame({
        "Mrd Number": [123, 456, 789, "a) Take the count of MRD number - 3 "],
        "Patient Name": ["A", "B", "C", None],
    })
    assert process_op_new_registration(df) == 3


def test_process_op_encounters_delegates_to_subtotal_extractor():
    rows = [
        ["Speciality", "Cardiology", None],
        [1, "PATIENT A", None],
        ["Total Encounters", None, 5],
        ["Speciality", "Radiology", None],
        [1, "PATIENT B", None],
        ["Total Encounters", None, 3],
    ]
    df = pd.DataFrame(rows, columns=["Col0", "Col1", "Col2"])
    assert process_op_encounters(df) == 5  # Radiology excluded


def test_process_admission_analysis_reads_total_row():
    df = pd.DataFrame({
        "Speciality": ["Cardiology", "General Medicine", "Total"],
        "Total Emergency Admission": [7, 17, 24],
        "Total Planned\nAdmission": [1, 1, 2],
        "Total admission from OP \n(walk-in)": [1, 15, 16],
        "Total": [9, 33, 42],
    })
    result = process_admission_analysis(df)
    assert result == {
        "Emergency Admission": 24,
        "Planned Admission": 2,
        "Admission from OP (walk-in)": 16,
    }


def test_process_admission_analysis_missing_total_row_raises():
    df = pd.DataFrame({
        "Speciality": ["Cardiology"],
        "Total Emergency Admission": [7],
        "Total Planned\nAdmission": [1],
        "Total admission from OP \n(walk-in)": [1],
    })
    try:
        process_admission_analysis(df)
        assert False, "expected ValueError"
    except ValueError:
        pass


def test_process_bed_occupancy_excludes_categories_and_junk_rows():
    df = pd.DataFrame({
        "Category": ["3 Bed Ward", "Day Case A", "Nursery", "Bed Occupancy header", "ICU"],
        "Beds Occupied": [25, 4, 10, None, 15],
    })
    result = process_bed_occupancy(df)
    # "Day Case A" and "Nursery" excluded by category; header row dropped by junk-strip
    assert result == {
        "bed_strength": 1000,
        "beds_occupied": 40,
        "occupancy_pct": 40 / 1000,
    }


def test_process_bed_occupancy_case_insensitive_exclusion():
    df = pd.DataFrame({
        "Category": ["operation theatre", "EM UNIT", "3 Bed Ward"],
        "Beds Occupied": [5, 2, 20],
    })
    result = process_bed_occupancy(df)
    assert result["beds_occupied"] == 20


def test_process_bed_occupancy_excludes_the_sheets_own_total_row():
    # The real sheet has a "Total" row summing every category -- including
    # it in our own sum double-counts everything under it.
    df = pd.DataFrame({
        "Category": ["3 Bed Ward", "ICU", "Total"],
        "Beds Occupied": [25, 157, 182],
    })
    result = process_bed_occupancy(df)
    assert result["beds_occupied"] == 182
