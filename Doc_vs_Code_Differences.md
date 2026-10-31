# Documentation vs Code — Differences & Recommendations

Compared the *Daily Report Automation Documentation* (Sections 1–9) against the code and against two real samples:
- **20-07-2026**: `reference_files/Test 20-07-26` vs `Final Output - 20-07-2026 Check.xlsx` (col H)
- **18-06-2026**: source sheets embedded in `config/final_output_template.xlsx` vs its col F

Legend: ✅ code now follows the doc · 🔧 fixed in this change · ⚠️ code deliberately differs from the doc (doc should be updated) · ❓ unresolved, needs a human decision or data

---

## 1. Fixed in this change (the code was wrong)

| # | Doc section | What the code did | What it does now | Evidence |
|---|---|---|---|---|
| 1 | §4 IP Admission, §6 IP Discharges, Long Stay | Counted every day-care row (doc has no exclusion rule). | **Rows with Ward "Admission Ward" are dropped** (`cat_dependent_counts.drop_admission_ward`), in every bucket; also applied to Long Stay. Other day-care wards (Daycare Lounge / "DL") still count. Decided to follow the Oct MIS (see Q1). | 08-Oct: 321 / 349 → **190 / 215 = MIS** (General 104 / 132 = MIS). 09-Oct: Admission Ward rows 118 adm / 114 dis. Long Stay unchanged (Admission Ward stays ≤ 2 days). Note: 20-07 manual (337 / 319) included them — the doc should be updated. |
| 2 | §5 Admission Analysis | Walk-in = IP Admission Total − Emergency − Planned | Reads **"Total admission from OP"** directly (doc rule) | 20-07: 47 → **188** (manual 188); 18-Jun: 17 → **158** (manual 158); 08-Oct: **181 = MIS** |
| 3 | §3 Category mapping | Any code with a trailing year was auto-mapped by stripping digits (`CPR 26` → CPR). The map also had 3 codes not in the doc: `CPR 26`, `CPR-SAARC`, `labcpr25op.1`. | Only codes listed in the doc map automatically. Anything else goes to **Category Review with a suggested bucket** (fuzzy threshold 90 → 80, so year variants still get a suggestion). Once confirmed, a value is saved as a learned override. | 20-07: `CPR 26` (₹113,357 IP + 2 discharges) and `labcpr25op.1` (₹282,270 OP, 23 bills) now show as suggestions → CPR |
| 4b | §7–8 Billing rows | Some bill-counter blocks (e.g. "Cardiology(AFC)Bill Counter") are exported with an extra blank cell before Category, so the row had no readable amount and was dropped. | Shifted rows are moved back one column before filtering (`billing._realign_shifted_rows`). | 08-Oct OP: 11,050,188.56 → **11,053,828.56 = MIS exactly**. 09-Oct OP +₹2,100. 12-Oct: the 3 "blank category" OP rows were these. |
| 4 | §7–9 Billing totals | Rows with an unmapped category were counted in **OP / IP / Total Billing** but dropped from **Domestic / International / Cash / Credit**, so rows 34 ≠ 39 ≠ 57. That inconsistency was then written permanently into the Daily Average / MTD history. | OP/IP totals now count only classified rows, so **rows 32+33 = 37+38 = 44+45+48+54 = 34 = 39 = 57** always hold. While any billing category is unreviewed, **export is blocked** (HTTP 409 with the list of values) and **the day isn't recorded into MTD history**. | 20-07 after review: all three totals = ₹32,304,763.13 |

**Reviewer's "OP + IP ≠ Total" / "Domestic + International ≠ Total" report:** this is fix #4. In the 20-07 check file, the Daily Average column has row 34 = 29,873,018 but row 39 = 29,816,339, because an earlier July day was recorded while some billing rows were unmapped. **That July history already contains a bad day.** Re-process those July days (or clear July in `config/daily_history.json` on that machine) to clean the averages.

---

## 2. Deliberate differences from the doc (update the doc)

| # | Doc section | Doc says | Code does | Why the code is right |
|---|---|---|---|---|
| 5 | §3 Domestic list | `Study faculty` → **General** | Not counted until confirmed: shows in **Category Review with General suggested** | Decided on 16-Oct-2026 to review it by hand: the 20-07 manual sheet counted one Study-faculty patient under ECHS, so the bucket isn't certain. |
| 6 | §9 Credit table | "Grand total of all Credit rows → Total Billing" | Row 57 = **overall** Total Billing (Cash + Credit) = row 34 | **Confirmed by the reviewer.** Every manual sheet has row 57 = row 34 = row 39. The doc wording is wrong. |
| 7 | §7 step 19 | "if **Category** = General → Cash" | If **CAT bucket** = General → Cash (so DEP, FDM, GNL-Aasandha, Dental PG … are Cash) | The raw Category is never literally "General". Using the bucket reproduces Cash International exactly (₹464,204.98 on 20-07). The doc should say "CAT = General". |
| 8 | §1 OP New Registration | Count non-blank MRD Number rows | Counts **numeric** MRD numbers only | Raw exports have a trailing note row in that column ("a) Take the count of MRD number - 382"); counting non-blank cells overcounts by 1. 20-07: 595 = manual. |
| 9 | §2 OP Encounters | Keep 4 columns, delete excluded rows, count | Sums each speciality's "Total Encounters" subtotal, skipping the excluded list | Same result without the column-shift risk the doc itself warns about. 20-07: 4673 = manual. |
| 10 | §7 step 16 / §8 step 23 | Filter the "**Bill** column" | Filters the **Bill Type** column | The files have both "Bill No." and "Bill Type"; O_B / IP_D / IP_F values are only in Bill Type. |

---

## 3. Doc gaps — category codes seen in real data but not in the doc

Status as of 16-Oct-2026. Codes marked **Review** are not counted until someone confirms them in Category Review. Once confirmed, the app remembers them. **Add them all to the doc's Category Codes list**:

| Raw value in export | Seen in | Status | Note |
|---|---|---|---|
| `labcpr25op.1` | OP billing (20-07, 18-Jun, 12-Oct) | **Counted** as CPR (Domestic) | Decided 16-Oct. Doc has `labcprop.1`, `LABCPROP25`, `LABCPR 26` but not this spelling |
| `labcpr26op.1` | OP billing (12-Oct) | **Counted** as CPR (Domestic) | Decided 16-Oct. Same spelling gap as above |
| `CPR 26` | IP billing, IP Discharges (20-07, 12-Oct) | **Review**, CPR (Domestic) suggested | Doc lists CPR 24/25 only. Expect `ECHS 2026` etc. next fiscal year. |
| `TPA 26` | IP Admission, IP Discharges, OP and IP bills (12-Oct) | **Review**, TPA suggested by fuzzy match | Removed from the map on 16-Oct; doc lists TPA / TPA 24 only |
| `CPR-SAARC` | OP billing (non-O_B rows, 20-07) | **Review**, no suggestion | Doc has `CPR- Saarc - Self` only |
| `DEP-Middle East` | IP Admission (12-Oct) | **Review**, no suggestion | Not in the doc |
| `TPA AASANTHA 25` | billing | TPA (International) | Doc spells it `TPA - AASANTHA 25`; matches after punctuation is ignored, so no action needed |
| `P.Card.Fund` | OP billing | P CARD FUND | Matches `P CARD FUND` after punctuation is ignored, so no action needed |

---

## 4. Not implemented (doc steps the app skips on purpose)

| Doc step | Status |
|---|---|
| §7 step 22, §8 step 30: save "Total Bill Wise dd-mm-yyyy" / "Discharge Wise dd-mm-yyyy" | Not written; the figures are computed in memory. Add this if auditors need the intermediate files. |
| §9 step 31: combined sheet with a yellow separator row | Not written; OP and IP are combined in memory for the sums. Same as above. |
| §8 step 27: remove the Time column | Done, but it has no effect on any figure. |

---

## 5. Remaining mismatches vs the manual sheet (❓ need the manual's intermediate files)

20-07, after accepting the suggested categories:

| Row | Manual | Code | Diff | Likely cause |
|---|---|---|---|---|
| 11–27 IP Admission / Discharges | 337 / 319 | 337 / 319 | 0 / 0 | Admissions General/ECHS 264/36 vs manual 263/37: one Study-faculty patient, General per the doc (manual put it in ECHS). |
| 32 OP Billing | 12,665,376.20 | 12,642,949.68 | −22,426.52 | No category or bill type in the raw file explains this. It needs the manual's filtered "Total Bill Wise" sheet. |
| 33 IP Billing | 19,636,328.22 | 19,661,813.45 | +25,485.23 | Same; needs the manual's "Discharge Wise" sheet. |
| 49 Credit ECHS | 2,929,328.92 | 2,924,006.49 | −5,322.43 | Possibly one OP INHS bill counted manually |
| 51 Credit TPA / 55 TPA Aasantha | 8,098,667.54 / 705,109.09 | 8,089,074.94 / 708,612.83 | ≈ ±3.5–9.6k | Possibly a TPA Aasantha bill classified as Domestic TPA manually |
| 56 Corporates (International) | blank | 0 | — | Cosmetic: the manual leaves it blank and the code writes 0. |

**08-Oct / 09-Oct vs the hospital MIS (billing):** IP Billing matches exactly on both days. After the shifted-row fix (#4b), **08-Oct OP matches the MIS exactly**. So the app's method (O_B only, Total − Discount) is the MIS method.

09-Oct OP is still **₹50,461.24 low**. By bucket (app − MIS): TPA −50,559.24, ECHS +9,820.00, Cash Domestic −1,955.28, Cash International −7,766.72; Corporates and TPA Aasantha match exactly. Checked and ruled out: other bill types (M_B, IP_D), refunds, negative or duplicate rows, blank categories, a truncated export (the last bill is at 23:13, and bill-number gaps look the same as on 08-Oct), and any single bill or pair of bills equal to the gap. The amounts move between buckets in **both** directions while the total only goes up. That looks like the MIS was built from a **later re-export** of Total Bill Wise, after some open (OPN/PD) bills were re-categorised or amended, not from a different rule. Only the MIS preparer's own Total Bill Wise file for 09-Oct can confirm this.

20-07 (manual sheet, not MIS): OP −22,426.52 / IP +25,485.23. There are no shifted O_B rows that day, so the fix doesn't change it; the same checks found no cause in the raw files.

The 18-Jun sample shows larger, similar unexplained billing gaps (OP −₹75.6k, Corporates International −₹162k). Because the code's internal totals now always reconcile, a manual-vs-code difference that remains is in the row selection (which bills were filtered in), not in the classification.

---

## 6. 12-Oct-2026 reports (`MIS_12TH_OCT_REPORTS`): why every run has an issue

**Formats are not changing.** All 9 files are detected correctly, and every report has all of its baseline columns. The only drift is two new Bed Occupancy columns (`Blocked`, `Housekeeping/ Repair`), which raise a warning only and don't change Beds Occupied.

**What changes daily is the category codes.** HIS has started issuing FY-26 codes, and the main TPA code itself has moved:

| New raw value | Where (row counts) | Suggested |
|---|---|---|
| `TPA 26` | IP Admission 37, IP Discharges 60, OP bills 28, IP bills 62 | TPA |
| `CPR 26` | IP Discharges 2, IP bills 2 | CPR |
| `labcpr26op.1` / `labcpr25op.1` | OP bills 7 / 10 | CPR |
| `DEP-Middle East` | IP Admission 1 | General, International (no fuzzy match; "Middle East" is now recognised as International when confirmed) |

As of 16-Oct-2026 the map follows the doc's §3 list, with two exceptions: `labcpr25op.1` and `labcpr26op.1` are counted as CPR (Domestic), and `Study faculty` goes to review (see §2 #5). `CPR 26` and `Study faculty` are in `config/category_map.json` with `"confirm": true`, so they show in Category Review with their bucket suggested and are **not counted** until confirmed. `TPA 26`, `CPR-SAARC` and `DEP-Middle East` aren't in the map at all, so they also go to review (only `TPA 26` gets a fuzzy suggestion). The real fix is still to **add the FY-26 codes to the Category Codes sheet / doc**.

Before this change, these codes were silently auto-mapped by stripping the year. Values looked fine but were never checked, and anything without a digit suffix (like `DEP-Middle East`) dropped out of the totals.

---

## 7. Questions for the reviewer

1. **Day-care — decided: follow the Oct MIS.** The app now drops Ward "Admission Ward" rows (Bed Type "Day Case A") from IP Admission, IP Discharges and Long Stay. On 08-Oct that matches the MIS exactly (190 / 215). In the data every Admission Ward row is General, so "General only vs every category" makes no difference. Daycare Lounge ("DL") rows are still counted, as the MIS does. Please confirm with the report owner and update the documentation; the 20-07 manual sheet (337 / 319) had included them.
2. **Admission from OP (walk-in) — resolved.** The 08-Oct MIS shows **181**, the same as the app's direct read of "Total admission from OP". The earlier "MIS = IP Admission − Emergency − Planned (54)" reading was wrong. No change.
3. **New category codes.** Please confirm the bucket and Domestic/International, and add them to the Category Codes sheet:
   - `labcpr25op.1`, `labcpr26op.1` → Corporates, Domestic (applied: counted automatically)
   - `CPR 26` → Corporates, Domestic? (in review)
   - `TPA 26` → TPA, Domestic? (in review)
   - `CPR-SAARC` → Corporates, International? (in review)
   - `DEP-Middle East` → General, International? (in review)
4. **Study faculty.** The documentation puts it under General; the 20-07 manual sheet counted one under ECHS. Which is correct? (Until answered, it shows in Category Review with General suggested.)
6. **09-Oct OP billing.** The method now matches the MIS to the paisa on 08-Oct. On 09-Oct, ₹50,461.24 is still missing, mostly in TPA (see §5). Was the 09-Oct "Total Bill Wise" re-exported later than the copy we were given? Please share the exact file the MIS was made from. Same for 20-07 (OP −₹22,427 / IP +₹25,485).
7. **12-Oct MIS.** We have the raw files for 12-Oct but not the MIS sheet. Could you share it so we can check that day too?

Resolved: **INHS GNL / INHS 2025** go under General (Domestic) per the documentation (16-Oct-2026). The MIS counts them under ECHS, so expect the ECHS rows to come out lower than the MIS and the General rows higher (20-07: 1 discharge, ₹111,827 IP billing). **Row 57** is the overall Total Billing (= row 34 = row 39).

---

## 8. Deployment note

The packaged exe copies `config/category_map.json` into `%APPDATA%\HospitalReportAutomation\config` **only on first launch**. Existing installs keep the old map. To pick up these changes there, delete that file so it's re-seeded. Saved corrections in `learned_overrides.json` there skip review entirely, so remove any for codes that should be reviewed (e.g. `tpa26`, `studyfaculty`).

On the dev machine (16-Oct-2026), the installed config was cleaned by hand: `cpr26`, `cprsaarc` and `studyfaculty` removed from its map, and the `tpa26` and `studyfaculty` saved corrections removed. Backups are next to the originals as `.bak`. The exe still needs a rebuild (`build.bat`) to run the current code.

Also, `scripts/build_category_map.py` regenerates the map from the Category Codes sheet, which would discard the manual changes above (`"confirm"` flags, the two labcpr OP codes, INHS → General if the sheet differs). Update the sheet too, or re-apply these changes after regenerating.
