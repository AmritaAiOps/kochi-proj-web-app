# Final Output: Logic Prompt for Every Row

One self-contained logic prompt for each row the automation writes into the **"Final output"** sheet (`config/final_output_template.xlsx`).
You can hand any single prompt to a developer, a reviewer or an AI and they will have the full rule for that row: the source report, the columns, filters, classification, formula, edge cases and how it rolls into Daily Average / MTD.

The rules describe what the code does today: `backend/stages/*`, with `final_output.ROW_MAP` as the row contract.

---

## 0. Shared rules (every prompt below assumes these)

**G1. Report detection.** Each uploaded sheet is matched to one of 9 report types. The first check is the sheet name, normalised to lowercase alphanumerics:

| Report type | Sheet-name hint | Column-signature fallback (all required) |
|---|---|---|
| Bed Occupancy | `bedoccupancy` | Bed Strength, Beds Occupied |
| OP New Registration | `opnewregistration` / `newregistration` | MRD Number, Registration Date |
| OP Encounters | `opencounters` | Token Number, Login ID |
| IP Admission | `ipadmission` | Admit Date, Bed Type, Patient Status |
| Admission Analysis | `admissionanalysis` | Total Emergency Admission, Total Planned Admission |
| IP Discharges | `ipdischarge` | Discharge Status, Send For Billing Time |
| Billing INR OP | `billinginrop` | Bill Type + TotalAmt + DiscAmt (one sheet can serve both OP and IP) |
| Billing INR IP | `billinginrip` | same as above |
| AEPL Billing | `aepl` | AIMS Bill Number, Posted Debit, Posted Credit |

**G2. Column lookup** (`columns.find_column`). Header matching ignores case and whitespace. Billing columns use **prefix** matching and AEPL columns use **contains** matching, with all punctuation ignored, so `TotalAmt (Inc.Tax)` matches `TotalAmt`. A missing required column raises `ValueError("Column matching 'X' not found…")`. It never raises a `KeyError`. The pipeline wraps the error with the report label (`StageProcessingError`).

**G3. Category → CAT bucket + Region** (`category_mapping.py`, `config/category_map.json`).
- Normalise the raw Category to lowercase alphanumerics only (`"CPR - 25"` → `cpr25`).
- Precedence: run override (from Category Review) → learned override → exact lookup in `category_map.json`. There is **no** year-stripping fallback.
- Buckets: `General`, `TPA`, `ECHS`, `P CARD FUND`, `CPR` (shown as "Corporates"). Region: `Domestic` / `International`.
- When an override gives a bucket but the raw value has no map entry, the region is **International** if the key contains one of `afroasian, oman, saarc, maldives, aasandha, aasantha, westernersandmideasterners, middleeast`, otherwise **Domestic**.
- An override of `__EXCLUDED__` resolves to no bucket and no region. The value is counted nowhere and is treated as already reviewed.
- An unmapped value resolves to no bucket. It is **not** counted in any bucket and goes to Category Review, with a suggestion when the fuzzy score is ≥ 80.

**G4. Cash / Credit.** `Cash` if CAT bucket = `General`, otherwise `Credit`. The rule uses the bucket, not the raw Category text.

**G5. Net amount** (billing rows only). `Net = TotalAmt − DiscAmt`, with both coerced to numeric.

**G6. Junk-row strip** (`strip_junk_rows`). A row is dropped when **all** of the listed numeric columns are blank or non-numeric. This removes section headers such as "IP Bill Counter - 1".

**G7. Writing.**
- The value goes into the "As on dd Mon yyyy" column.
- Numbers are rounded to whole numbers, **half-up** (Excel style, so 4208.5 → 4209). The exception is `Occupancy %`, which is written as a fraction (0.967).
- A key that is missing from `values` leaves its cell untouched and logs a warning.

**G8. Daily Average / MTD (Proj)** (`mtd.py`). The calculation is per row class:
- **Cumulative** (all counts and amounts): Daily Average = mean of the days recorded this month. MTD (Proj) = Daily Average × days in the month.
- **Average / snapshot** (`Beds Occupied`, `Occupancy %`): Daily Average = mean of the recorded days. MTD (Proj) = the same mean, with no projection.
- **Constant** (`Bed Strength`): both columns = today's value.
- **Derived** (`Hospital Revenue`): row 57 − row 60 in each column.
- A month with zero recorded days shows `—`.
- When a month is complete it is frozen as a 2-column pair ("Daily Average <Month>", "MTD <Month>") left of "Particulars". For cumulative rows, MTD = the real **sum** of the recorded days; average and constant rows follow the same rules as above.

**G9. History / export gate.**
- Each processed day is stored in `config/daily_history.json` (month → metric → day).
- While **any billing** Category value (OP or IP) is still pending review:
  - export is blocked with HTTP 409;
  - the day is **not** recorded into history.
- Pending values in the non-billing reports only produce warnings.

---

## 1. Bed Occupancy block

### Row 4: Bed Strength
> **Prompt:** Write the hospital's fixed bed strength into row 4. Use the constant `BED_STRENGTH = 1000` (`simple_counters.py`). Do not read it from the Bed Occupancy file. The file has a Bed Strength column, but it is used only for report detection.
> - **Source:** constant.
> - **Edge cases:** none. If the hospital's licensed bed count changes, edit the constant. Never derive it from the data.
> - **MTD class:** Constant. Daily Average = MTD = 1000.

### Row 5: Beds Occupied
> **Prompt:** From the **Bed Occupancy** report, compute the total number of occupied beds:
> 1. Find the `Category` and `Beds Occupied` columns (exact match, G2).
> 2. Normalise each Category (lowercase, no whitespace). Drop rows whose category is one of `nursery, operationtheatre, labour, daycasea, daycasebed, emunit, total`.
> 3. Also drop rows with a **blank** Category. Some exports leave the grand-total row unlabelled, and counting it would double the total.
> 4. Strip junk rows where `Beds Occupied` is non-numeric (G6).
> 5. Sum `Beds Occupied` as numbers and cast to int.
> - **Edge cases:** if the grand-total row is not removed, the figure doubles. Nursery, OT, labour, day-case and emergency-unit beds are excluded by policy.
> - **MTD class:** Average/snapshot. Daily Average = mean of the recorded days. MTD (Proj) = the same mean.

### Row 6: Occupancy %
> **Prompt:** Occupancy % = row 5 ÷ row 4 (`beds_occupied / 1000`). Write it as a **fraction** (0.967, shown as 97% by the cell format). Never round it to a whole number.
> - **MTD class:** Average/snapshot. Mean of the daily fractions, no projection.
> - **Check:** row 6 × 1000 should equal row 5 for the same column.

---

## 2. Outpatient block

### Row 9: OP New Registration
> **Prompt:** From the **OP New Registration** report, count the registrations:
> 1. Find the `MRD Number` column.
> 2. Coerce it to numeric and count the non-null results. Count **numeric** MRD numbers only.
> - **Why numeric only:** raw HIS exports add a trailing note in the same column (for example "a) Take the count of MRD number - 382"). Counting non-blank cells would overcount by one.
> - **MTD class:** Cumulative.

### Row 10: OP Encounters
> **Prompt:** From the **OP Encounters** report, which is grouped by speciality, add up the per-speciality subtotals:
> 1. Walk the rows top to bottom. A row whose first column is exactly `Speciality` opens a group, and the speciality name is in column 2.
> 2. The next row whose first column is exactly `Total Encounters` closes the group, and the subtotal is in column 3.
> 3. Skip a group when its speciality (lowercase, no whitespace) is one of: Radiology, Njarakkal Health Center, Amrita Urban Health Centre Kaloor, Amrita Labs, Amrita Lab Trivandrum, Amrita Health Centre Palluruthy, Amrita Centre For Advanced Dental Care.
> 4. Sum the subtotals as ints.
> - **Edge cases:**
>   - A group with no closing row, a closing row with no opener, a missing speciality name or a non-numeric subtotal is logged and skipped. It never crashes the run.
>   - This rule follows the column layout, not the doc's "keep 4 columns and count" approach. The result is the same without the column-shift risk.
> - **MTD class:** Cumulative.

---

## 3. IP Admission block (category counts)

Common logic for rows 11–16:
> **Prompt:** From the **IP Admission** report:
> 1. Find the `Category` column.
> 2. Drop rows where Category is null. These are footer and total rows, not patients.
> 3. **Drop day-care rows where `Ward` is "Admission Ward"** (trimmed, case-insensitive; Bed Type "Day Case A"). The hospital MIS leaves them out (08-Oct: 321 → 190, exact match). Other day-care wards (e.g. Daycare Lounge / "DL") are still counted. If there is no `Ward` column, nothing is dropped.
> 4. Resolve each row's CAT bucket (G3, overrides included).
> 5. Count the rows per bucket. Unmapped and excluded rows go into **no** bucket, and their values are sent to Category Review.

| Row | Label | Rule |
|---|---|---|
| 11 | IP Admission Total | Sum of rows 12–16. This is **not** the raw row count, so unmapped rows are left out until they are reviewed. |
| 12 | IP Admission General | Count where CAT = `General` (GNL, DEP, FDM, Dental PG/Student/Faculty, ASK, international General variants, …) |
| 13 | IP Admission TPA | Count where CAT = `TPA` (includes EMP / EMP TPA and TPA Aasantha) |
| 14 | IP Admission ECHS | Count where CAT = `ECHS` (ECHS, ESI, CHSS, Ex-servicemen, CIAL, INHS, ISRO) |
| 15 | IP Admission P.Card.Fund | Count where CAT = `P CARD FUND` |
| 16 | IP Admission Corporates | Count where CAT = `CPR` (all CPR variants, Domestic and International) |

- **Region** is not used in this block. Admissions are counted by bucket only.
- **Check:** 12+13+14+15+16 = 11. When there are no pending review items, row 11 should equal the number of patient rows in the file.
- **MTD class:** Cumulative, for every row.

---

## 4. Admission Analysis block

Common logic for rows 18–20:
> **Prompt:** From the **Admission Analysis** report, find the row whose **first column** (trimmed, lowercase) is exactly `total`. If there is no such row, raise `ValueError("Admission Analysis sheet has no 'Total' row")`. Read the three figures below from that row as ints. Do not sum the speciality rows yourself.

| Row | Label | Column read from the Total row |
|---|---|---|
| 18 | Emergency Admission | `Total Emergency Admission` |
| 19 | Planned Admission | `Total Planned Admission` |
| 20 | Admission from OP (walk-in) | `Total admission from OP (walk-in)`, read **directly**. Never derive it as Total − Emergency − Planned (an old bug gave 47 instead of 188). Confirmed against the 08-Oct MIS: 181 = 181. The Admission Ward exclusion does not apply (this report has no Ward column). |

- **MTD class:** Cumulative.
- **Note:** 18+19+20 is not guaranteed to equal row 11. The two figures come from different HIS reports.

---

## 5. IP Discharges block (category counts)

Common logic for rows 22–27:
> **Prompt:** Apply exactly the same logic as the IP Admission block (section 3), but use the **IP Discharges** report: drop null-Category rows, drop "Admission Ward" rows, map to CAT buckets (G3) and count per bucket.

| Row | Label | Rule |
|---|---|---|
| 22 | IP Discharges Total | Sum of rows 23–27 |
| 23 | IP Discharges General | Count where CAT = `General` |
| 24 | IP Discharges TPA | Count where CAT = `TPA` |
| 25 | IP Discharges ECHS | Count where CAT = `ECHS` |
| 26 | IP Discharges P.Card.Fund | Count where CAT = `P CARD FUND` |
| 27 | IP Discharges Corporates | Count where CAT = `CPR` |

- **Check:** 08-Oct gives 349 − 134 Admission Ward rows = **215 = MIS** (General 132 = MIS). See `Doc_vs_Code_Differences.md` Q1.
- **MTD class:** Cumulative.

---

## 6. Long Stay Patients

### Row 29: Long Stay Patients
> **Prompt:** Reuse the **IP Discharges** report (no separate upload):
> 1. Find the `Days` column. It is already a length-of-stay number, so do not compute it from dates.
> 2. Drop "Admission Ward" rows, same rule as IP Discharges (no effect in practice: those stays are 1–2 days).
> 3. Coerce `Days` to numeric. Rows with non-numeric values are logged and excluded.
> 4. Keep the rows where `Days > 10`. The comparison is strict, so exactly 10 days is not long stay.
> 5. Map those rows to CAT buckets (G3) and count the ones that land in any of the 5 buckets.
> 6. Write the **total** only. The per-bucket breakdown is shown on the dashboard and not written to the sheet.
> - **Edge cases:** a long-stay patient with an unmapped Category is not counted until it is reviewed.
> - **MTD class:** Cumulative.

---

## 7. Billing (INR) block

Common billing preparation, used by rows 32–57:
> **Prompt:**
> 1. **OP:** from **Billing INR OP**, strip junk rows (G6, on TotalAmt and DiscAmt). Keep rows where `Bill Type` = `O_B`.
> 2. **IP:** from **Billing INR IP**, strip junk rows. Keep rows where `Bill Type` ∈ {`IP_D`, `IP_F`}. Drop the `Time` column if it is present; this has no effect on the figures.
> 3. On every kept row, compute `Net` (G5), `CAT` (G3), `Cash_Credit` (G4) and `Region` (G3).
> 4. A row counts toward **any** billing figure only when its Region is not null, which means it is mapped or reviewed. This guarantees that every billing total below reconciles.
> 5. Any billing Category value still pending review **blocks export and history recording** (G9).
> - Filter on the **Bill Type** column, not on Bill No.

### Row 32: OP Billing
> Sum of `Net` over the kept OP rows where Region is not null.
> - **Known issue:** in "Total Bill Wise", the Cardiology (AFC) bill-counter rows are shifted one column to the right and are currently skipped. This caused the ₹3,640 gap on 08-Oct.

### Row 33: IP Billing
> Sum of `Net` over the kept IP rows where Region is not null.

### Row 34: Total Billing
> Row 32 + row 33.

### Row 37: Billing Domestic
> Combine the OP and IP rows. Sum `Net` where Region = `Domestic`.

### Row 38: Billing International
> Combine the OP and IP rows. Sum `Net` where Region = `International`.

### Row 39: Billing Total
> Row 37 + row 38. It must equal row 34, and a mismatch larger than ₹0.01 is logged as a warning.

**MTD class:** Cumulative for rows 32–39.

---

## 8. Cash / Credit block

All rows in this block use the combined OP + IP rows from section 7, summing `Net`.

| Row | Label | Filter |
|---|---|---|
| 44 | Cash Domestic | Cash_Credit = Cash (CAT = General) **and** Region = Domestic |
| 45 | Cash International | Cash_Credit = Cash **and** Region = International (for example GNL-Aasandha, DEP Maldives, GNL Oman/SAARC) |
| 48 | Credit Domestic Total | Cash_Credit = Credit **and** Region = Domestic |
| 49 | Credit Domestic ECHS | Credit, Domestic, CAT = `ECHS` |
| 50 | Credit Domestic P.Card.Fund | Credit, Domestic, CAT = `P CARD FUND` |
| 51 | Credit Domestic TPA | Credit, Domestic, CAT = `TPA` |
| 52 | Credit Domestic Corporates | Credit, Domestic, CAT = `CPR` |
| 54 | Credit International Total | Cash_Credit = Credit **and** Region = International |
| 55 | Credit International TPA Aasantha | Credit, International, CAT = `TPA` |
| 56 | Credit International Corporates (International) | Credit, International, CAT = `CPR` (Afro-Asian, Oman, SAARC-Self, …). The value is written as 0 when empty; the manual sheet leaves it blank. |
| 57 | Total Billing | **Grand total** = 44 + 45 + 48 + 54. This must equal row 34 and row 39. It is **not** a credit-only total, despite the doc wording. |

**Prompt for this block:** Compute each row by applying the filter in the table to the combined, classified OP + IP billing rows and summing `Net`. Then check these identities:
- 49+50+51+52 = 48
- 55+56 = 54
- 44+45+48+54 = 57 = 34 = 39

The pipeline logs only two checks: Cash + Credit = Billing Total, and Billing Total = OP + IP. The subtotal identities hold by construction, because ECHS, TPA and P CARD FUND exist only as Domestic codes in the map. If a future International ECHS or P.Card code appears, it would land in row 54 but not in row 55 or 56; flag it if that happens.

**MTD class:** Cumulative.

---

## 9. AEPL and Hospital Revenue

### Row 60: AEPL Billing
> **Prompt:** From the **AEPL Billing** report:
> 1. Find these columns by contains-match: `AEPL Bill No`, `Posted Debit` and `Posted Credit`. The header suffix varies, for example "Amt" vs "Amount".
> 2. Uppercase the bill number. Drop rows whose bill number contains `NN` or `NP`.
> 3. AEPL Billing = Σ Posted Debit − Σ Posted Credit, over the remaining rows, with both coerced to numeric.
> - **Edge cases:** blank or non-numeric amounts count as 0 in the sums. A net credit position gives a negative value, which is allowed.
> - **MTD class:** Cumulative.

### Row 63: Hospital Revenue (Net of AEPL)
> **Prompt:** Write this row as a **live Excel formula** (`=<col>57-<col>60`), not a number. Use the same formula in the As-on, Daily Average and MTD (Proj) columns, each pointing at its own column's rows 57 and 60.
> - When the month has no history, the Daily Average and MTD cells show `—`.
> - Frozen month columns get the computed value (Total Billing − AEPL).
> - **MTD class:** Derived.

---

## 10. Rows the code never touches
Every row that is not listed above (headers, blank spacers, and the manually filled **"Collection (INR)"** section) exists only as template layout. The code must not write to them.

## 11. Quick reconciliation checklist (run on every output)
- 12+13+14+15+16 = 11
- 23+24+25+26+27 = 22
- 32+33 = 34
- 37+38 = 39
- 34 = 39 = 57
- 44+45+48+54 = 57
- 49+50+51+52 = 48
- 55+56 = 54
- 63 = 57 − 60
- 6 = 5 / 4
