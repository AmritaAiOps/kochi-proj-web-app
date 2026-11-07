// The app's API, run in the browser: handle() serves the URLs the frontend
// calls (/detect, /process, /download/{id}, /category-review[/resolve],
// /api/...) and returns { status, json } or { status, filename, bytes, content_type }.
import dailyHistorySeed from './data/daily_history.json' with { type: 'json' }
import learnedOverridesSeed from './data/learned_overrides.json' with { type: 'json' }
import verificationHistorySeed from './data/verification_history.json' with { type: 'json' }
import schemaBaselinesSeed from './data/schema_baselines.json' with { type: 'json' }
import { readWorkbook } from './excel.js'
import { REPORT_TYPES, EXCLUDED, StageProcessingError, normalizeLoose, runPipeline } from './stages.js'
import { buildFrames, detectDatesFromFilenames, detectReportDate, detectReportType, makeCandidateId, refineBillingTypeEvidence } from './detection.js'
import { computeMonthColumn, computeMtdColumns, finalizeMonth, parseIsoDate, recordDay } from './history.js'
import { writeFinalOutput } from './finalOutput.js'
import { runVerification, validateUpload } from './checks.js'

// Shared state, as JSON text per file. The worker swaps in the KV copy before
// each request and pushes back whatever changed; the seeds apply until KV has one.
const sortedJson = (obj) => JSON.stringify(obj, (_, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v), 2)
export const store = {
  'daily_history.json': sortedJson(dailyHistorySeed),
  'learned_overrides.json': sortedJson(learnedOverridesSeed),
  'verification_history.json': JSON.stringify(verificationHistorySeed, null, 2),
  'schema_baselines.json': sortedJson(schemaBaselinesSeed),
}
const load = (name) => JSON.parse(store[name] || '{}')
const save = (name, obj, sorted = true) => (store[name] = sorted ? sortedJson(obj) : JSON.stringify(obj, null, 2))

// Set by the caller: () => Promise<ArrayBuffer> of the Final output template.
export const config = { loadTemplate: null }

const VALID_BUCKETS = new Set(['General', 'TPA', 'ECHS', 'P CARD FUND', 'CPR'])
const BILLING_SOURCES = new Set(['Billing INR OP', 'Billing INR IP'])
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

class ApiError extends Error {
  constructor(status, detail) {
    super(detail)
    this.status = status
  }
}

// Most recently processed runs, so Category Review can recalculate without re-uploading. Per browser tab.
const RUN_STATE = {}

const summarize = (v) => ({
  'Bed Occupancy %': v['Occupancy %'] ?? null,
  'OP Encounters': v['OP Encounters'] ?? null,
  'Total Billing': v['Total Billing'] ?? null,
  'AEPL Billing': v['AEPL Billing'] ?? null,
})

/** Billing values still awaiting review: while any remain, the day is neither exported nor recorded. */
export function pendingBillingValues(review) {
  const entries = [...(review.possible_matches || []), ...(review.unmatched || [])]
  return [...new Set(entries.filter((e) => BILLING_SOURCES.has(e.source_file) && e.raw_value !== null).map((e) => String(e.raw_value)))].sort()
}

function warningsFromReview(review) {
  const warnings = []
  const { unmatched = [], possible_matches: possible = [] } = review
  if (unmatched.length) {
    const rows = unmatched.reduce((s, e) => s + e.frequency, 0)
    const sample = unmatched.slice(0, 3).map((e) => (e.raw_value !== null ? String(e.raw_value) : '(blank)')).join(', ')
    const more = unmatched.length > 3 ? ` (+${unmatched.length - 3} more)` : ''
    warnings.push(`${unmatched.length} unmatched category value(s) across ${rows} row(s) (e.g. ${sample}${more}) — excluded from category-based totals. See Category Review.`)
  }
  if (possible.length) warnings.push(`${possible.length} category value(s) have a possible match awaiting your confirmation — see Category Review panel.`)
  const pending = pendingBillingValues(review)
  if (pending.length) {
    warnings.push(`Export blocked: billing category value(s) ${pending.join(', ')} need review — resolve them in Category Review so billing totals reconcile.`)
  }
  return warnings
}

function resultResponse(fileId, values, review, verification) {
  const warnings = warningsFromReview(review)
  return {
    status: warnings.length ? 'warning' : 'success',
    file_id: fileId,
    summary: summarize(values),
    values,
    warnings,
    category_review: review,
    verification,
    download_url: `/download/${fileId}`,
  }
}

// diagnostics only: never turns a successful run into an error
function verifySafely(values, frames, date) {
  try {
    const report = runVerification(values, frames)
    const history = load('verification_history.json')
    history[date.iso] = report
    save('verification_history.json', history, false)
    return report
  } catch (err) {
    console.warn('verification stage failed to run:', err)
    return null
  }
}

function recordHistory(date, values, review) {
  if (pendingBillingValues(review).length) return // an unreconciled day never enters MTD
  save('daily_history.json', recordDay(load('daily_history.json'), date, values))
}

function detect(files) {
  const candidates = []
  const notes = []
  const dateSheets = []
  for (const { name: filename, bytes } of files) {
    let book
    try {
      book = readWorkbook(bytes)
    } catch (err) {
      return {
        candidates: [], matches: [], missing: REPORT_TYPES, detected_date: null,
        file_error: { source_file: filename, reason: `Could not read this as an Excel file: ${err.message}` },
      }
    }
    for (const sheet of book.sheetNames) {
      const rows = book.rows(sheet)
      const preview = rows.slice(0, 20)
      const detection = detectReportType(sheet, preview)
      let types = detection.report_types
      // A combined bill list matches both billing types from its header; confirm
      // from the FULL sheet's Bill Type values (IP rows can sit below the preview).
      if (types.includes('Billing INR OP') && types.includes('Billing INR IP')) {
        const ev = refineBillingTypeEvidence(rows, detection.header_row, rows[detection.header_row])
        const refined = [ev.op && 'Billing INR OP', ev.ip && 'Billing INR IP'].filter(Boolean)
        if (refined.length) types = refined
      }
      if (detection.name_conflict) {
        notes.push(`'${sheet}' in ${filename} is named like ${detection.name_conflict}, but its columns look like ${types.join(', ')} -- using the columns.`)
      }
      candidates.push({
        id: makeCandidateId(filename, sheet), source_file: filename, sheet_name: sheet,
        report_types: types, confidence: detection.confidence, curated: detection.curated,
      })
      if (detection.report_type) dateSheets.push([detection.header_row, preview])
    }
  }

  // Rank by confidence, then a staff-curated sheet, then a dedicated single-report
  // sheet over a combined OP+IP bill list -- never just upload order.
  const CONF = { high: 2, medium: 1, none: 0 }
  const rankOf = (c) => [CONF[c.confidence], c.curated ? 1 : 0, c.report_types.length === 1 ? 1 : 0]
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
  const best = new Map()
  for (const c of candidates) {
    for (const rt of c.report_types) if (!best.has(rt) || cmp(rankOf(c), best.get(rt)[0]) > 0) best.set(rt, [rankOf(c), c])
  }
  for (const [rt, [top, chosen]] of best) {
    const rivals = candidates.filter((c) => c !== chosen && c.report_types.includes(rt) && cmp(rankOf(c), top) === 0)
    if (rivals.length) {
      notes.push(`${rivals.length + 1} sheets look like ${rt}; using ${chosen.sheet_name} (${chosen.source_file}). ` +
        `If that's wrong, pick another: ${rivals.map((c) => `${c.sheet_name} (${c.source_file})`).join(', ')}.`)
    }
  }

  const fromNames = detectDatesFromFilenames(files.map((f) => f.name))
  let detectedDate = fromNames.date
  if (detectedDate === null && !fromNames.conflict) detectedDate = detectReportDate(dateSheets)

  return {
    candidates: candidates.map((c) => ({ id: c.id, source_file: c.source_file, sheet_name: c.sheet_name })),
    matches: [...best].map(([rt, [, c]]) => ({ report_type: rt, candidate_id: c.id, confidence: c.confidence })),
    missing: REPORT_TYPES.filter((rt) => !best.has(rt)),
    detected_date: detectedDate,
    date_conflict: fromNames.conflict,
    notes,
  }
}

function process(files, mappingText, dateText) {
  const date = parseIsoDate(dateText)
  if (!date) return { status: 'error', failed_file: null, reason: `Invalid date: '${dateText}'. Expected YYYY-MM-DD.` }
  let mapping
  try {
    mapping = JSON.parse(mappingText)
  } catch {
    return { status: 'error', failed_file: null, reason: 'Malformed report mapping.' }
  }
  const missing = REPORT_TYPES.filter((rt) => !Object.hasOwn(mapping, rt))
  if (missing.length) return { status: 'error', failed_file: null, reason: `No report assigned for: ${missing.join(', ')}.` }

  const books = {}
  for (const { name } of files) {
    if (!/\.(xlsx|xls)$/i.test(name)) return { status: 'error', failed_file: name, reason: `'${name}' is not an Excel file (.xlsx/.xls).` }
  }
  const mapped = new Set(Object.values(mapping).map((id) => String(id).split('::')[0]))
  for (const { name, bytes } of files.filter((f) => mapped.has(f.name))) {
    try {
      books[name] = readWorkbook(bytes)
    } catch (err) {
      return { status: 'error', failed_file: name, reason: `Could not read this as an Excel file: ${err.message}` }
    }
  }

  const baselines = load('schema_baselines.json')
  const schema = validateUpload(mapping, books, baselines)
  if (schema.changed) save('schema_baselines.json', baselines)
  if (schema.error) {
    return {
      status: 'error', success: false, error: schema.error, failed_file: schema.error.category,
      reason: `Schema mismatch in ${schema.error.category}: expected column(s) missing: ${schema.error.missingColumns.join(', ')}. ` +
        "If the HIS export format has genuinely changed, reset this report's baseline and re-upload.",
    }
  }

  let frames
  try {
    frames = buildFrames(mapping, books)
  } catch (err) {
    return { status: 'error', failed_file: null, reason: err.message }
  }

  // seeded with earlier accepted corrections so they don't need re-confirming daily
  const overrides = { ...load('learned_overrides.json') }
  let result
  try {
    result = runPipeline(frames, overrides)
  } catch (err) {
    if (err instanceof StageProcessingError) return { status: 'error', failed_file: err.label, reason: err.reason }
    return { status: 'error', failed_file: null, reason: err.message }
  }

  const fileId = crypto.randomUUID().replaceAll('-', '')
  recordHistory(date, result.values, result.categoryReview)
  const verification = verifySafely(result.values, frames, date)
  RUN_STATE[fileId] = { frames, date, overrides, values: result.values, review: result.categoryReview }
  return resultResponse(fileId, result.values, result.categoryReview, verification)
}

async function download(fileId) {
  const state = RUN_STATE[fileId]
  if (!state) throw new ApiError(404, 'No processed run found for this id')
  const pending = pendingBillingValues(state.review)
  if (pending.length) throw new ApiError(409, `Resolve billing categories in Category Review before exporting: ${pending.join(', ')}`)

  const history = load('daily_history.json')
  const { date } = state
  // completed months roll into static pairs ("—" pair if a month never recorded a day)
  const finalized = Object.keys(history)
    .map((k) => k.split('-').map(Number))
    .filter(([y, m]) => y < date.y || (y === date.y && m < date.m))
    .map(([y, m]) => [y, m, finalizeMonth(history, y, m)])
  const bytes = await writeFinalOutput(await config.loadTemplate(), state.values, date, computeMtdColumns(date, state.values, history), finalized)
  const dd = String(date.d).padStart(2, '0')
  const mm = String(date.m).padStart(2, '0')
  return { filename: `Final Output - ${dd}-${mm}-${date.y}.xlsx`, bytes: new Uint8Array(bytes) }
}

function resolveCategoryReview(body) {
  const state = RUN_STATE[body.file_id]
  if (!state) throw new ApiError(404, 'No processed run found for this id.')
  if (!body.resolutions.length) return { status: 'error', failed_file: null, reason: 'No resolutions provided.' }
  // never trust the dropdown alone
  const invalid = [...new Set(body.resolutions.map((r) => r.chosen_bucket).filter((b) => b != null && !VALID_BUCKETS.has(b)))].sort()
  if (invalid.length) {
    const list = (xs) => `[${xs.map((x) => `'${x}'`).join(', ')}]`
    return { status: 'error', failed_file: null, reason: `Unknown bucket(s) ${list(invalid)}. Must be one of ${list([...VALID_BUCKETS].sort())} or null to exclude.` }
  }
  const entries = Object.fromEntries(body.resolutions.map((r) => [normalizeLoose(r.raw_value), r.chosen_bucket ?? EXCLUDED]))
  Object.assign(state.overrides, entries)
  // remembered separately from category_map.json (the master table), which is never rewritten
  save('learned_overrides.json', { ...load('learned_overrides.json'), ...entries })

  let result
  try {
    result = runPipeline(state.frames, state.overrides)
  } catch (err) {
    if (err instanceof StageProcessingError) return { status: 'error', failed_file: err.label, reason: err.reason }
    throw err
  }
  state.values = result.values
  state.review = result.categoryReview
  recordHistory(state.date, result.values, result.categoryReview)
  const verification = verifySafely(result.values, state.frames, state.date)
  return resultResponse(body.file_id, result.values, result.categoryReview, verification)
}

function monthlyAverage(dateText, metric) {
  const date = parseIsoDate(dateText)
  if (!date) return { success: false, error: 'date must be YYYY-MM-DD' }
  const col = computeMonthColumn(load('daily_history.json'), date, metric)
  if (!col) return { success: true, data: { monthAvailable: false, asOf: null, dailyAverage: null, mtdProjected: null } }
  return { success: true, data: { monthAvailable: true, ...col } }
}

function verificationReport(dateText) {
  const date = parseIsoDate(dateText)
  if (!date) return { success: false, error: 'date must be YYYY-MM-DD' }
  const report = load('verification_history.json')[date.iso]
  return report ? { success: true, data: report } : { success: false, error: `No verification report recorded for ${dateText}.` }
}

function schemaBaselineReset(category) {
  if (!REPORT_TYPES.includes(category)) return { success: false, error: `Unknown report category: '${category}'.` }
  const baselines = load('schema_baselines.json')
  if (Object.hasOwn(baselines, category)) {
    delete baselines[category]
    save('schema_baselines.json', baselines)
  }
  return { success: true, data: { category, message: "Baseline reset. The next upload's headers become the new baseline." } }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
function requireFields(body, fields) {
  if (!isObj(body)) throw new ApiError(422, 'Request body must be a JSON object.')
  for (const [key, check] of Object.entries(fields)) if (!check(body[key])) throw new ApiError(422, `Field '${key}' is required.`)
}
const isStr = (v) => typeof v === 'string'

/** One request. body: parsed JSON (or the multipart text fields for /process); files: [{ name, bytes }]. */
export async function handle({ method, path, query = '', body = null, files = [] }) {
  const q = Object.fromEntries(new URLSearchParams(query))
  try {
    if (method === 'POST' && path === '/detect') return { status: 200, json: detect(files) }
    if (method === 'POST' && path === '/process') {
      if (!isObj(body) || !isStr(body.mapping) || !isStr(body.date)) throw new ApiError(422, "Fields 'mapping' and 'date' are required.")
      return { status: 200, json: process(files, body.mapping, body.date) }
    }
    if (method === 'GET' && path.startsWith('/download/')) {
      const { filename, bytes } = await download(path.slice('/download/'.length))
      return { status: 200, filename, bytes, content_type: XLSX_TYPE }
    }
    if (method === 'GET' && path === '/category-review') {
      if (!('file_id' in q)) throw new ApiError(422, "Query parameter 'file_id' is required.")
      if (!RUN_STATE[q.file_id]) throw new ApiError(404, 'No processed run found for this id.')
      return { status: 200, json: RUN_STATE[q.file_id].review }
    }
    if (method === 'POST' && path === '/category-review/resolve') {
      requireFields(body, { file_id: isStr, resolutions: Array.isArray })
      for (const r of body.resolutions) requireFields(r, { raw_value: isStr })
      if (body.resolutions.some((r) => r.chosen_bucket != null && !isStr(r.chosen_bucket))) throw new ApiError(422, 'chosen_bucket must be a string or null.')
      return { status: 200, json: resolveCategoryReview(body) }
    }
    if (method === 'GET' && (path === '/api/monthly-average' || path === '/api/verification-report')) {
      if (!('date' in q)) throw new ApiError(422, "Query parameter 'date' is required.")
      const json = path === '/api/monthly-average' ? monthlyAverage(q.date, q.metric ?? 'Total Billing') : verificationReport(q.date)
      return { status: 200, json }
    }
    if (method === 'POST' && path === '/api/schema-baseline/reset') {
      requireFields(body, { category: isStr })
      return { status: 200, json: schemaBaselineReset(body.category) }
    }
    throw new ApiError(404, 'Not Found')
  } catch (err) {
    if (err instanceof ApiError) return { status: err.status, json: { detail: err.message } }
    throw err
  }
}
