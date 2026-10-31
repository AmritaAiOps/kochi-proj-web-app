# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-office desktop tool that automates a hospital's daily HIS (Hospital Information System) report. Staff upload ~9 raw Excel exports (bed occupancy, OP/IP admissions & discharges, billing, AEPL credit postings, etc.), the tool detects which file is which report, computes every figure the "Final output" workbook needs, and writes/exports that workbook. Deployed on **Cloudflare Pages**: the React frontend is static, the Python backend runs **in the browser via Pyodide**, and shared state lives in **Cloudflare KV** behind one Pages Function. Deployment steps: `DEPLOY.md`.

## Commands

Setup (from repo root):
```
npm run setup   # npm install (root, gets wrangler) + npm install (frontend)
pip install -r requirements.txt   # only for running the backend tests
```

Build / run locally / deploy:
```
npm run build    # scripts/build_pyapp.py -> frontend/public/pyapp.zip, then vite build -> frontend/dist
npm run dev      # build, then `wrangler pages dev` on http://127.0.0.1:8788 with a local KV (state in .wrangler/)
npm run deploy   # build, then `wrangler pages deploy`
```
After changing any Python file, re-run `npm run build`: the browser loads the backend from `pyapp.zip`, not from source.

Backend tests (pytest, no config file — run from repo root so `backend.*` imports resolve):
```
npm test         # = python -m pytest backend/tests
pytest backend/tests
pytest backend/tests/test_billing.py
pytest backend/tests/test_billing.py::test_process_billing_op_filters_o_b_only   # single test
```
Note: some tests (`test_date_detection.py`, `test_detection.py::test_detects_all_9_reports_from_real_sample_workbook`, `test_loading.py`, `test_long_stay_patients.py`) depend on a real sample workbook (`Daily report to automate.xlsx`) that isn't checked into the repo — they fail with `FileNotFoundError` unless that file is present locally. That's expected, not a regression.

Frontend lint (from `frontend/`): `npm run lint` (oxlint). The plain Vite dev server (`npm run dev` inside `frontend/`) has no `/api/state` function — use the root `npm run dev` instead.

## Architecture

**In-browser backend** (`frontend/src/pyApi.js` → `frontend/src/py.worker.js` → `backend/api.py`): `pyApi.js` wraps `window.fetch` so the app's API URLs (`/detect`, `/process`, `/download/{id}`, `/category-review[/resolve]`, `/api/monthly-average`, `/api/verification-report`, `/api/schema-baseline/reset`) go to a Web Worker instead of the network and come back as normal `Response` objects — `App.jsx` and the components are unaware. The worker loads Pyodide (pinned `v314.0.7` from jsDelivr, with pandas; openpyxl/et-xmlfile pinned via micropip), unpacks `pyapp.zip` to `/app`, and calls `backend.api.handle()`. `backend/api.py` is the old FastAPI `main.py` with only the framework glue swapped (files are `[(name, bytes)]`, `ApiError` instead of `HTTPException`, `dumps()` instead of FastAPI's JSON encoder) — endpoint logic is unchanged. `RUN_STATE` lives in the worker, so it's per browser tab. Requests are processed one at a time.

**rapidfuzz shim** (`web/pyshim/rapidfuzz/`): rapidfuzz has no Pyodide build, so the browser bundle ships a pure-Python `fuzz.ratio` (the only function used). `backend/tests/test_rapidfuzz_shim.py` asserts it equals the real rapidfuzz bit-for-bit; tests and local Python keep using the real package.

**Shared state** (`functions/api/state/[name].js`, KV binding `STATE`): the 4 files the backend persists — `config/daily_history.json`, `config/learned_overrides.json`, `backend/data/verification_history.json`, `backend/data/schema_baselines.json` — are pulled from KV into Pyodide's filesystem before every request and pushed back if changed (a 404 keeps the shipped seed; any other error aborts so the seed can never overwrite shared history). Last write wins per file. Only these allow-listed names are accepted, bodies must be JSON ≤ 5 MB. KV holds totals/category codes/column names only — uploaded patient files never leave the browser. A new persistent file must be added to `STATE_FILES` in `py.worker.js` **and** `NAMES` in the function, or it will silently reset on every request.

**Runtime paths** (`backend/runtime_paths.py`): config/data paths are relative to the repo root (`/app` inside Pyodide); generated workbooks are written to `data/outputs/<Month YYYY>/` in the in-memory filesystem and handed to the user as a browser download. Any new persistent file must be wired through this module, not hardcoded.

**Report pipeline** (`backend/stages/`): each of the 9 report types is one pipeline stage — a pure function taking an already-loaded pandas DataFrame and returning computed values, no file I/O. `backend/stages/pipeline.py::run_pipeline()` wires all stages together into one flat `values` dict keyed to match `final_output.ROW_MAP`. `backend/stages/detection.py` figures out which uploaded file/sheet is which report type (by sheet name + column-signature matching); `backend/stages/loading.py` turns the detected mapping into the DataFrames the pipeline consumes. `backend/main.py`'s `/detect` and `/process` endpoints are the two-step flow the frontend drives: detect first (so the user can confirm/override auto-matched files), then process.

**Category mapping** (`backend/stages/category_mapping.py` + `config/category_map.json`): raw "Category" values from HIS exports (CPR, ECHS, TPA, etc., with year-suffixed variants like "CPR 26") get normalized and mapped to a fixed bucket + Domestic/International region. Values with no match go to `backend/stages/category_review.py`'s review queue instead of silently miscounting; the frontend's Category Review panel lets staff resolve them, and resolutions are `overrides` (run-scoped, keyed by `normalize_loose(raw_value)`) threaded through nearly every stage function — never written back to the master `category_map.json`. Confirmed overrides can be persisted separately as "learned overrides" (`backend/stages/learned_overrides.py`, `config/learned_overrides.json`) so the same correction doesn't need reconfirming every day.

**Final output workbook** (`backend/stages/final_output.py`): `ROW_MAP` is the single source of truth mapping each Final-output sheet row number to the metric key the pipeline produces — this is the contract between `run_pipeline()`'s output and the spreadsheet layout. `write_final_output()` loads `config/final_output_template.xlsx`, writes today's values into a caller-specified date column, and (via `backend/monthly_average.py` + `backend/stages/mtd.py`) computes/writes the Daily Average and MTD (Proj) columns next to it. Rows not in `ROW_MAP` are never touched by code — e.g. the manually-filled "Collection (INR)" section exists only as template layout, not as computed output.

**Daily history / MTD** (`backend/stages/daily_history.py`, `config/daily_history.json`, `backend/history_store.py`): the app processes one day at a time and has no other memory of past days, so true month-to-date figures require persisting each day's values as they're computed (`record_day`, keyed by month → metric → day-of-month). Metrics are classified in `mtd.py` as cumulative (sum/average over recorded days, then projected across the full month), average-style/snapshot (e.g. Occupancy %, averaged not summed — projecting a point-in-time reading is meaningless), or constant (Bed Strength). A completed month rolls over from the live 3-column block into a static 2-column pair (`finalize_month()` in `monthly_average.py`) inserted just left of the "Particulars" column, using however many days were actually recorded that month (not the calendar length) — a month the automation joined mid-way still gets a real average instead of staying blank.

**Verification** (`backend/verification.py`): an independent, best-effort recompute of key figures (e.g. Total Billing) directly from the raw source DataFrames, run after the main pipeline purely as a diagnostic cross-check. It must never turn a successful pipeline run into a hard error — failures are logged and swallowed (`_run_verification_safely` in main.py).

**Format validation** (`backend/format_validator.py`): before processing, uploaded files are checked against `backend/data/schema_baselines.json` (expected column names per report type). A genuine schema mismatch blocks the run with a specific "which report, which missing column" error rather than a downstream KeyError; baselines can be reset per-category if the HIS export format has legitimately changed.

**Error surfacing**: stage functions raise `ValueError` (never bare `KeyError`) for "expected column not found" — `KeyError.__str__()` wraps its message in extra stray quotes, which used to leak as garbled text into the frontend's error banner. `backend/stages/pipeline.py`'s `StageProcessingError` wraps whatever a stage raises with which report label failed, so `/process` can tell the user which specific uploaded file was the problem instead of a generic failure.
