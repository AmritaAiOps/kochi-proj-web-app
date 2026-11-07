# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-office desktop tool that automates a hospital's daily HIS (Hospital Information System) report. Staff upload ~9 raw Excel exports (bed occupancy, OP/IP admissions & discharges, billing, AEPL credit postings, etc.), the tool detects which file is which report, computes every figure the "Final output" workbook needs, and writes/exports that workbook. Deployed on **Cloudflare Pages**: everything is JavaScript — the React frontend and the report engine (`frontend/src/engine/`) run in the browser, and shared state lives in **Cloudflare KV** behind one Pages Function. There is no server-side backend. Deployment steps: `DEPLOY.docx`.

## Commands

Setup (from repo root):
```
npm run setup   # npm install (root, gets wrangler) + npm install (frontend)
```

Build / run locally / deploy / test:
```
npm run build    # vite build -> frontend/dist
npm run dev      # build, then `wrangler pages dev` on http://127.0.0.1:8788 with a local KV (state in .wrangler/)
npm run deploy   # build, then `wrangler pages deploy`
npm test         # node --test on frontend/src/engine/*.test.js (engine unit tests, no browser needed)
```
Single test: `cd frontend && node --test --test-name-pattern "<name>" "src/engine/*.test.js"`.

Frontend lint (from `frontend/`): `npm run lint` (oxlint). The plain Vite dev server (`npm run dev` inside `frontend/`) has no `/api/state` function — use the root `npm run dev` instead.

Real sample HIS exports live in `reference_files/` (git-ignored, local only) — use them to sanity-check engine changes end to end.

## Architecture

**In-browser engine** (`frontend/src/api.js` → `frontend/src/engine.worker.js` → `frontend/src/engine/api.js`): `api.js` wraps `window.fetch` so the app's API URLs (`/detect`, `/process`, `/download/{id}`, `/category-review[/resolve]`, `/api/monthly-average`, `/api/verification-report`, `/api/schema-baseline/reset`) go to a Web Worker instead of the network and come back as normal `Response` objects — `App.jsx` and the components are unaware. `engine/api.js::handle()` routes them. `RUN_STATE` lives in the worker, so it's per browser tab. Requests are processed one at a time. Everything under `engine/` is plain ES modules with no DOM use, so it also runs under Node for tests.

**Excel I/O**: uploads are read with SheetJS (`xlsx`, installed from cdn.sheetjs.com) in `engine/excel.js`, which deliberately reproduces the old pandas/openpyxl cell semantics (rows from A1, pandas NA strings like "NA"/"None" → `null`, numeric-column inference only in header mode) — stage logic depends on it. A "frame" is `{ columns, rows }` with rows as arrays. The Final output workbook is written with ExcelJS (keeps template styles) in `engine/finalOutput.js`.

**Shared state** (`functions/api/state/[name].js`, KV binding `STATE`): the 4 files the engine persists — `daily_history.json`, `learned_overrides.json`, `verification_history.json`, `schema_baselines.json` — live as JSON text in `engine/api.js`'s `store` (seeded from `engine/data/`). The worker pulls them from KV before every request and pushes back any that changed (a 404 keeps the shipped seed; any other error aborts so the seed can never overwrite shared history). Last write wins per file. Only allow-listed names are accepted, bodies must be JSON ≤ 5 MB. KV holds totals/category codes/column names only — uploaded patient files never leave the browser. A new persistent file must be added to `store` **and** `NAMES` in the function.

**Report pipeline** (`engine/stages.js`): each of the 9 report types is one pure function taking a frame and returning computed values, no I/O. `runPipeline()` wires them into one flat `values` object keyed to match `finalOutput.ROW_MAP`. `engine/detection.js` figures out which uploaded file/sheet is which report type (sheet name + column-signature matching), detects the report date, and turns the confirmed mapping into frames. `/detect` then `/process` is the two-step flow the frontend drives: detect first (so the user can confirm/override auto-matched files), then process.

**Category mapping** (`stages.js` + `engine/data/category_map.json`): raw "Category" values from HIS exports (CPR, ECHS, TPA, etc., with year-suffixed variants like "CPR 26") get normalized and mapped to a fixed bucket + Domestic/International region. Values with no match go to the review queue (fuzzy suggestion via an Indel `ratio`) instead of silently miscounting; the frontend's Category Review panel lets staff resolve them, and resolutions are `overrides` (keyed by `normalizeLoose(raw_value)`) threaded through the stage functions — never written back to `category_map.json`. Confirmed overrides persist as learned overrides so the same correction doesn't need reconfirming every day. Lookups use `Object.hasOwn` — category keys can collide with `Object.prototype` names.

**Final output workbook** (`engine/finalOutput.js`): `ROW_MAP` is the single source of truth mapping each Final-output sheet row to the metric key the pipeline produces. `writeFinalOutput()` loads `engine/final_output_template.xlsx`, writes today's values into the "As on" column right of "Particulars", and the Daily Average and MTD (Proj) columns next to it. Rows not in `ROW_MAP` are never touched — e.g. the manually-filled "Collection (INR)" section exists only as template layout.

**Daily history / MTD** (`engine/history.js`): the app processes one day at a time and has no other memory of past days, so true month-to-date figures require persisting each day's values (`recordDay`, keyed by month → metric → day-of-month). Metrics are classified as cumulative (mean of recorded days, projected across the full month), average-style/snapshot (e.g. Occupancy %, averaged not summed), or constant (Bed Strength). A completed month rolls over from the live 3-column block into a static 2-column pair (`finalizeMonth()`) inserted just left of "Particulars", using however many days were actually recorded that month. A day is not recorded (or exported) while billing categories await review.

**Verification** (`engine/checks.js::runVerification`): an independent, best-effort recompute of key figures directly from the raw frames, run after the pipeline purely as a diagnostic. It must never turn a successful run into an error — failures are logged and swallowed (`verifySafely` in api.js).

**Format validation** (`engine/checks.js::validateUpload`): before processing, uploaded sheets' headers are checked against `schema_baselines.json`. A genuine schema mismatch blocks the run with a specific "which report, which missing column" error; baselines can be reset per category if the HIS export format has legitimately changed.

**Error surfacing**: stage functions throw plain `Error`s with readable messages for "expected column not found". `StageProcessingError` in `stages.js` wraps whatever a stage throws with which report label failed, so `/process` can tell the user which uploaded file was the problem.
