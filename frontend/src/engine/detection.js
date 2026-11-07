// Which uploaded sheet is which of the 9 reports (sheet name first, then the
// header row's column signature; never a silent guess), the report date, and
// turning the confirmed mapping into frames for the pipeline.
import { headerFrame, rawFrame } from './excel.js'

const SHEET_NAME_KEYWORDS = {
  'Bed Occupancy': ['bedoccupancy'],
  'OP New Registration': ['opnewregistration', 'newregistration'],
  'OP Encounters': ['opencounters'],
  'IP Admission': ['ipadmission'],
  'Admission Analysis': ['admissionanalysis'],
  'IP Discharges': ['ipdischarge'],
  'Billing INR OP': ['billinginrop'],
  'Billing INR IP': ['billinginrip'],
  'AEPL Billing': ['aepl'],
}

// every keyword must appear inside some normalized column name. Billing is
// special-cased in matchByColumns (one bill list can feed both OP and IP).
const COLUMN_SIGNATURES = {
  'Bed Occupancy': ['bedstrength', 'bedsoccupied'],
  'OP New Registration': ['mrdnumber', 'registrationdate'],
  'OP Encounters': ['tokennumber', 'loginid'],
  'IP Admission': ['admitdate', 'bedtype', 'patientstatus'],
  'Admission Analysis': ['totalemergencyadmission', 'totalplannedadmission'],
  'IP Discharges': ['dischargestatus', 'sendforbillingtime'],
  'AEPL Billing': ['aimsbillnumber', 'posteddebit', 'postedcredit'],
}

export const normalizeAlnum = (v) => (typeof v === 'string' ? v.toLowerCase().replace(/[^a-z0-9]/g, '') : '')
const headerCols = (headerRow) => headerRow.filter((c) => c !== null && c !== '' && c !== 0 && c !== false).map((c) => normalizeAlnum(String(c)))

/** The row (within the first maxScan) with the most non-blank text cells. */
export function findHeaderRow(rows, maxScan = 10) {
  const scanned = rows.slice(0, maxScan)
  let bestIdx = 0
  let bestScore = -1
  scanned.forEach((row, idx) => {
    const score = row.filter((c) => typeof c === 'string' && c.trim()).length
    if (score > bestScore) [bestScore, bestIdx] = [score, idx]
  })
  return [bestIdx, scanned[bestIdx] || []]
}

function matchBySheetName(sheetName) {
  const n = normalizeAlnum(sheetName)
  const hits = Object.keys(SHEET_NAME_KEYWORDS).filter((rt) => SHEET_NAME_KEYWORDS[rt].some((kw) => n.includes(kw)))
  return hits.length === 1 ? hits[0] : null
}

/** Staff-reconciled sheet (has both Dom/Int and Cash/Credit tag columns) -- tie-breaker only. */
export function isCuratedBillingSheet(headerRow) {
  const cols = headerCols(headerRow)
  return cols.some((c) => c.includes('domint') || c.includes('dominternational')) && cols.some((c) => c.includes('cashcredit'))
}

/** Every report type the header qualifies for. A raw bill list (Bill Type +
 * TotalAmt + DiscAmt) serves both billing reports -- the OP/IP split is per
 * row -- unless it has "No of days Admitted", which marks an IP-only export. */
export function matchByColumns(headerRow) {
  const cols = headerCols(headerRow)
  const hasCol = (kw) => cols.some((c) => c.includes(kw))
  const matches = []
  if (hasCol('totalamt') && hasCol('discamt') && hasCol('billtype')) {
    matches.push(...(hasCol('noofdaysadmitted') ? ['Billing INR IP'] : ['Billing INR OP', 'Billing INR IP']))
  }
  for (const [rt, required] of Object.entries(COLUMN_SIGNATURES)) if (required.every(hasCol)) matches.push(rt)
  return matches
}

/** Scans the Bill Type column's values (pass the FULL sheet: IP rows can sit
 * far below the OP rows) -> { op, ip } seen. */
export function refineBillingTypeEvidence(rows, headerRowIdx, headerRow) {
  const idx = headerRow.findIndex((c) => normalizeAlnum(String(c)).includes('billtype'))
  let op = false
  let ip = false
  if (idx < 0) return { op, ip }
  for (const row of rows.slice(headerRowIdx + 1)) {
    if (idx >= row.length || typeof row[idx] !== 'string') continue
    const v = normalizeAlnum(row[idx])
    if (v === 'ob') op = true
    else if (v === 'ipd' || v === 'ipf') ip = true
    if (op && ip) break
  }
  return { op, ip }
}

/** rows: the sheet's first ~10+ raw rows. */
export function detectReportType(sheetName, rows) {
  const [headerRowIdx, headerRow] = findHeaderRow(rows)
  const base = { header_row: headerRowIdx, curated: isCuratedBillingSheet(headerRow) }
  const sheetMatch = matchBySheetName(sheetName)
  const columnMatches = matchByColumns(headerRow)
  // name says one report, columns clearly another: trust the columns and say so
  if (sheetMatch && columnMatches.length && !columnMatches.includes(sheetMatch)) {
    return { ...base, report_type: columnMatches[0], report_types: columnMatches, confidence: 'medium', matched_via: 'columns', name_conflict: sheetMatch }
  }
  if (sheetMatch) return { ...base, report_type: sheetMatch, report_types: [sheetMatch], confidence: 'high', matched_via: 'sheet_name' }
  if (columnMatches.length) return { ...base, report_type: columnMatches[0], report_types: columnMatches, confidence: 'medium', matched_via: 'columns' }
  return { ...base, report_type: null, report_types: [], confidence: 'none', matched_via: null }
}

// ---------------------------------------------------------------- dates
const pad = (n, w = 2) => String(n).padStart(w, '0')
const isoDate = (y, m, d) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`

export function validDate(y, m, d) {
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null
  return isoDate(y, m, d)
}
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
export const daysInMonth = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]

// HIS file names: dd-mm-yyyy (day first) or yyyy-mm-dd, separators - . _
const FILENAME_PATTERNS = [
  [/(?<!\d)(\d{4})[-._](\d{1,2})[-._](\d{1,2})(?!\d)/g, (m) => [+m[1], +m[2], +m[3]]],
  [/(?<!\d)(\d{1,2})[-._](\d{1,2})[-._](\d{4})(?!\d)/g, (m) => [+m[3], +m[2], +m[1]]],
]

export function parseDateFromFilename(filename) {
  for (const [pattern, toYmd] of FILENAME_PATTERNS) {
    for (const m of filename.matchAll(pattern)) {
      const iso = validDate(...toYmd(m))
      if (iso) return iso
    }
  }
  return null
}

/** { date, conflict, found }: conflict when two filenames disagree. */
export function detectDatesFromFilenames(filenames) {
  const found = Object.fromEntries(filenames.map((f) => [f, parseDateFromFilename(f)]))
  const distinct = [...new Set(Object.values(found).filter(Boolean))]
  if (distinct.length !== 1) return { date: null, conflict: distinct.length > 1, found }
  return { date: distinct[0], conflict: false, found }
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** pd.to_datetime(value, errors="coerce").date() as ISO, or null. Strings are
 * read month-first like pandas/dateutil ("12-07-2026" -> 7 Dec) unless that's impossible. */
export function toIsoDate(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : isoDate(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate())
  if (typeof v === 'number') return Number.isFinite(v) ? '1970-01-01' : null // pandas reads bare numbers as epoch nanoseconds
  if (typeof v !== 'string') return null
  const s = v.trim()
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/)
  if (m) return validDate(+m[1], +m[2], +m[3])
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[ T].*)?$/)
  if (m) return validDate(+m[3], +m[1], +m[2]) || validDate(+m[3], +m[2], +m[1])
  m = s.match(/^(\d{1,2})[-/ ]([A-Za-z]{3,})[-/ ,]+(\d{4})(?:[ T].*)?$/)
  if (m && MONTHS.includes(m[2].slice(0, 3).toLowerCase())) return validDate(+m[3], MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, +m[1])
  m = s.match(/^([A-Za-z]{3,})[ -](\d{1,2}),?[ -](\d{4})(?:[ T].*)?$/)
  if (m && MONTHS.includes(m[1].slice(0, 3).toLowerCase())) return validDate(+m[3], MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, +m[2])
  return null
}

/** sheets: [[headerRowIdx, rows]]. Most common date across every "...date..." column. */
export function detectReportDate(sheets) {
  const counts = new Map()
  for (const [h, rows] of sheets) {
    if (!rows.length || h >= rows.length) continue
    const dateCols = rows[h].map((c, i) => (normalizeAlnum(String(c ?? 'nan')).includes('date') ? i : -1)).filter((i) => i >= 0)
    for (const row of rows.slice(h + 1)) {
      for (const i of dateCols) {
        const iso = i < row.length ? toIsoDate(row[i]) : null
        if (iso) counts.set(iso, (counts.get(iso) || 0) + 1)
      }
    }
  }
  let best = null
  for (const [iso, n] of counts) if (best === null || n > counts.get(best)) best = iso
  return best
}

// ---------------------------------------------------------------- loading
const SEP = '::'
export const makeCandidateId = (file, sheet) => `${file}${SEP}${sheet}`

export function parseCandidateId(id) {
  const i = id.indexOf(SEP)
  if (i < 0) throw new Error(`Malformed candidate id: '${id}'`)
  return [id.slice(0, i), id.slice(i + SEP.length)]
}

/** OP Encounters stays raw (walked positionally); others use their detected header row. */
export function loadReportFrame(rows, reportType) {
  if (reportType === 'OP Encounters') return rawFrame(rows)
  return headerFrame(rows, findHeaderRow(rows.slice(0, 10))[0])
}

/** mapping: report type -> candidate id. books: filename -> readWorkbook() result. */
export function buildFrames(mapping, books) {
  const frames = {}
  for (const [reportType, id] of Object.entries(mapping)) {
    const [file, sheet] = parseCandidateId(id)
    if (!books[file]) throw new Error(`File '${file}' referenced in the report mapping was not uploaded.`)
    if (!books[file].sheetNames.includes(sheet)) throw new Error(`Sheet '${sheet}' not found in '${file}'.`)
    frames[reportType] = loadReportFrame(books[file].rows(sheet), reportType)
  }
  return frames
}
