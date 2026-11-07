// The report pipeline: one pure function per report type, each taking a frame
// (see excel.js) and returning computed values -- no I/O. runPipeline() wires
// them into one flat `values` object keyed to match finalOutput.ROW_MAP.
import categoryMap from './data/category_map.json' with { type: 'json' }
import { column, filterRows, pyInt, pyStr, sumNum, toNum } from './excel.js'

export const REPORT_TYPES = [
  'OP New Registration', 'OP Encounters', 'IP Admission', 'Admission Analysis', 'IP Discharges',
  'Billing INR OP', 'Billing INR IP', 'AEPL Billing', 'Bed Occupancy',
]

const has = (obj, key) => obj != null && Object.hasOwn(obj, key)
const pyRepr = (v) => (typeof v === 'string' ? `'${v}'` : pyStr(v))

// ---------------------------------------------------------------- columns
// HIS exports vary header whitespace, punctuation and suffixes ("TotalAmt" vs
// "Total Amt\n(Inc. Tax)"), so match loosely.
function normCol(name, match) {
  if (typeof name !== 'string') return ''
  return name.toLowerCase().replace(match === 'exact' ? /\s+/g : /[^a-z0-9]/g, '')
}

/** match: "exact" (whitespace/case-insensitive), "prefix" or "contains" (alphanumeric-only).
 * Throws a plain Error when required and missing. */
export function findColumn(df, expected, match = 'exact', required = true) {
  const target = normCol(expected, match)
  for (const col of df.columns) {
    const c = normCol(String(col), match)
    if (match === 'exact' ? c === target : match === 'prefix' ? c.startsWith(target) : c.includes(target)) return col
  }
  if (required) throw new Error(`Column matching ${pyRepr(expected)} not found. Available: [${df.columns.map(pyRepr).join(', ')}]`)
  return null
}

// ---------------------------------------------------------------- category mapping
// Raw "Category" values -> fixed bucket (CPR, General, ECHS, TPA, P CARD FUND)
// + region (Domestic/International), via data/category_map.json.

// Override value meaning "explicitly excluded": resolves to no bucket, but counts as reviewed.
export const EXCLUDED = '__EXCLUDED__'

// Substrings shared by every International code; fallback ONLY for overridden
// values with no exact category_map.json entry (e.g. "TPA Aasantha 26-27").
const INTERNATIONAL_HINTS = ['afroasian', 'oman', 'saarc', 'maldives', 'aasandha', 'aasantha', 'westernersandmideasterners', 'middleeast']

/** Strips ALL non-alphanumerics, lowercased: "CPR25" == "CPR-25" == "CPR 25". */
export const normalizeLoose = (v) => (typeof v === 'string' ? v.toLowerCase().replace(/[^a-z0-9]/g, '') : '')

// Exact lookup, no year-suffix fallback: a new code ("CPR 26") must go to
// Category Review. Entries marked "confirm" are skipped unless includeUnconfirmed.
function lookup(raw, includeUnconfirmed = false) {
  const key = normalizeLoose(raw)
  const entry = has(categoryMap, key) ? categoryMap[key] : null
  if (entry && entry.confirm && !includeUnconfirmed) return null
  return entry
}

export function mapCategory(raw) {
  if (!raw || typeof raw !== 'string') return null
  return lookup(raw)?.bucket ?? null
}

export function mapRegion(raw) {
  if (!raw || typeof raw !== 'string') return null
  return lookup(raw)?.region ?? null
}

/** mapCategory, but run/learned overrides (keyed by normalizeLoose) win. */
export function resolveCategory(raw, overrides) {
  if (typeof raw === 'string' && has(overrides, normalizeLoose(raw))) {
    const value = overrides[normalizeLoose(raw)]
    return value === EXCLUDED ? null : value
  }
  return mapCategory(raw)
}

/** Overrides record a bucket only: keep the map's region if the value is in it, else guess from hints. */
export function resolveRegion(raw, overrides) {
  if (typeof raw === 'string' && has(overrides, normalizeLoose(raw))) {
    const key = normalizeLoose(raw)
    if (overrides[key] === EXCLUDED) return null
    const entry = lookup(raw, true)
    if (entry) return entry.region
    return INTERNATIONAL_HINTS.some((hint) => key.includes(hint)) ? 'International' : 'Domestic'
  }
  return mapRegion(raw)
}

export const isOverridden = (raw, overrides) => typeof raw === 'string' && has(overrides, normalizeLoose(raw))

// ---------------------------------------------------------------- category review
// 80 so year-suffix variants of documented codes (CPR 26 vs CPR 25) still get a suggestion
export const FUZZY_THRESHOLD = 80

/** rapidfuzz fuzz.ratio: normalized Indel similarity, 0-100. */
export function ratio(a, b) {
  const total = a.length + b.length
  if (total === 0) return 100
  let prev = new Array(b.length + 1).fill(0)
  for (const ch of a) {
    const cur = [0]
    for (let j = 0; j < b.length; j++) cur.push(ch === b[j] ? prev[j] + 1 : Math.max(prev[j + 1], cur[j]))
    prev = cur
  }
  return (1 - (total - 2 * prev[b.length]) / total) * 100
}

const LOOSE_INDEX = Object.entries(categoryMap).map(([key, entry]) => [normalizeLoose(key), entry.bucket])

export function fuzzyBestMatch(raw, threshold = FUZZY_THRESHOLD) {
  const loose = normalizeLoose(raw)
  if (!loose) return null
  let bestBucket = null
  let bestScore = -1
  for (const [key, bucket] of LOOSE_INDEX) {
    if (!key) continue
    const score = ratio(loose, key)
    if (score > bestScore) [bestScore, bestBucket] = [score, bucket]
  }
  return bestBucket !== null && bestScore >= threshold ? { bucket: bestBucket, similarity: Math.round(bestScore * 10) / 10 } : null
}

const byFrequency = (a, b) => b.frequency - a.frequency

/** Every distinct value in categoryColumn that doesn't resolve and isn't already overridden. */
export function getUnmatchedCategories(df, categoryColumn, sourceFile = null, overrides = null) {
  if (!df.columns.includes(categoryColumn)) return []
  const counts = new Map()
  for (const v of column(df, categoryColumn)) counts.set(v, (counts.get(v) || 0) + 1)
  const result = []
  for (const [raw, count] of counts) {
    if (isOverridden(raw, overrides) || resolveCategory(raw, overrides) !== null) continue
    result.push({ raw_value: raw, frequency: count, source_file: sourceFile })
  }
  return result.sort(byFrequency)
}

/** Splits unmatched values into possible_matches (fuzzy hit, needs confirming) and unmatched. */
export function classifyUnmatched(unmatched) {
  const possible = []
  const still = []
  for (const entry of unmatched) {
    const match = fuzzyBestMatch(entry.raw_value)
    if (match) possible.push({ ...entry, suggested_bucket: match.bucket, similarity: match.similarity })
    else still.push(entry)
  }
  return { possible_matches: possible.sort(byFrequency), unmatched: still.sort(byFrequency) }
}

export const reviewFrame = (df, categoryColumn, sourceFile, overrides) =>
  classifyUnmatched(getUnmatchedCategories(df, categoryColumn, sourceFile, overrides))

export const mergeReviews = (reviews) => ({
  possible_matches: reviews.flatMap((r) => r.possible_matches).sort(byFrequency),
  unmatched: reviews.flatMap((r) => r.unmatched).sort(byFrequency),
})

// ---------------------------------------------------------------- row cleaning
export const GROUP_START_LABEL = 'Speciality'
export const GROUP_END_LABEL = 'Total Encounters'
export const normalizeSpace = (v) => v.trim().toLowerCase().replace(/\s+/g, '')

/** Drops rows where ALL requiredColumns are blank/non-numeric. */
export function stripJunkRows(df, requiredColumns) {
  const idx = requiredColumns.map((c) => df.columns.indexOf(c))
  return filterRows(df, (r) => idx.some((i) => !Number.isNaN(toNum(r[i]))))
}

/** OP Encounters (raw rows): sums each "Speciality" group's "Total Encounters"
 * subtotal (column C), skipping excluded specialities. */
export function extractOpEncounterSubtotals(df, excludeSpecialities) {
  const excluded = new Set(excludeSpecialities.map(normalizeSpace))
  let total = 0
  let pending = null
  for (const row of df.rows) {
    const label = row[0]
    if (typeof label === 'string' && label.trim() === GROUP_START_LABEL) {
      pending = { name: row.length > 1 ? row[1] : null }
      continue
    }
    if (typeof label === 'string' && label.trim() === GROUP_END_LABEL) {
      if (pending === null) continue
      const name = pending.name
      pending = null
      if (typeof name !== 'string' || excluded.has(normalizeSpace(name))) continue
      try {
        total += pyInt(row.length > 2 ? row[2] : null)
      } catch {
        // non-numeric subtotal: skip the group
      }
    }
  }
  return total
}

// ---------------------------------------------------------------- simple counters
export const EXCLUDE_SPECIALITIES = [
  'Radiology', 'Njarakkal Health Center', 'Amrita Urban Health Centre Kaloor', 'Amrita Labs',
  'Amrita Lab Trivandrum', 'Amrita Health Centre Palluruthy', 'Amrita Centre For Advanced Dental Care',
]

const BED_OCCUPANCY_EXCLUDED = new Set([
  'nursery', 'operationtheatre', 'labour', 'daycasea', 'daycasebed', 'emunit',
  'total', // the sheet's own grand-total row -- including it doubles the count
])

export const BED_STRENGTH = 1000

/** Counts only genuinely numeric MRD numbers (raw exports end with a text note row). */
export function processOpNewRegistration(df) {
  const col = findColumn(df, 'MRD Number')
  return column(df, col).filter((v) => !Number.isNaN(toNum(v))).length
}

export const processOpEncounters = (df) => extractOpEncounterSubtotals(df, EXCLUDE_SPECIALITIES)

export function processAdmissionAnalysis(df) {
  const emergency = findColumn(df, 'Total Emergency Admission')
  const planned = findColumn(df, 'Total Planned Admission')
  const walkin = findColumn(df, 'Total admission from OP (walk-in)')
  const row = df.rows.find((r) => pyStr(r[0]).trim().toLowerCase() === 'total')
  if (!row) throw new Error("Admission Analysis sheet has no 'Total' row")
  const at = (c) => row[df.columns.indexOf(c)]
  return {
    'Emergency Admission': pyInt(at(emergency)),
    'Planned Admission': pyInt(at(planned)),
    'Admission from OP (walk-in)': pyInt(at(walkin)),
  }
}

export function processBedOccupancy(df) {
  const categoryCol = findColumn(df, 'Category')
  const occupiedCol = findColumn(df, 'Beds Occupied')
  const ci = df.columns.indexOf(categoryCol)
  // a blank Category is the grand-total row in some exports -- never a real bed category
  const kept = filterRows(df, (r) => {
    const v = r[ci]
    return !(v === null || pyStr(v).trim() === '' || BED_OCCUPANCY_EXCLUDED.has(normalizeSpace(pyStr(v))))
  })
  const cleaned = stripJunkRows(kept, [occupiedCol])
  const bedsOccupied = Math.trunc(sumNum(column(cleaned, occupiedCol).map(toNum)))
  return { bed_strength: BED_STRENGTH, beds_occupied: bedsOccupied, occupancy_pct: bedsOccupied / BED_STRENGTH }
}

// ---------------------------------------------------------------- CAT-dependent counts
export const BUCKET_TO_OUTPUT_KEY = { General: 'General', TPA: 'TPA', ECHS: 'ECHS', 'P CARD FUND': 'P.Card.Fund', CPR: 'Corporates' }

/** Day-care patients in Ward "Admission Ward" are left out of the MIS IP counts. */
export function dropAdmissionWard(df) {
  const wardCol = findColumn(df, 'Ward', 'exact', false)
  if (wardCol === null) return df
  const wi = df.columns.indexOf(wardCol)
  return filterRows(df, (r) => pyStr(r[wi]).trim().toLowerCase() !== 'admission ward')
}

function bucketCounts(df, categoryCol, overrides) {
  const cats = column(df, categoryCol).map((v) => resolveCategory(v, overrides))
  const result = {}
  for (const [bucket, key] of Object.entries(BUCKET_TO_OUTPUT_KEY)) result[key] = cats.filter((c) => c === bucket).length
  result.Total = Object.values(result).reduce((a, b) => a + b, 0)
  return result
}

function processCatCounts(df, sourceFile = null, overrides = null) {
  const categoryCol = findColumn(df, 'Category')
  const ci = df.columns.indexOf(categoryCol)
  // footer/total rows have no Category -- not patients
  const patients = dropAdmissionWard(filterRows(df, (r) => r[ci] !== null))
  return { ...bucketCounts(patients, categoryCol, overrides), category_review: reviewFrame(patients, categoryCol, sourceFile, overrides) }
}

export const processIpAdmission = processCatCounts
export const processIpDischarges = processCatCounts

// ---------------------------------------------------------------- long stay
export const LONG_STAY_THRESHOLD_DAYS = 10

/** "Days" in IP Discharges is already length-of-stay. Non-numeric Days are excluded. */
export function processLongStayPatients(df, sourceFile = null, overrides = null) {
  const daysCol = findColumn(df, 'Days')
  const categoryCol = findColumn(df, 'Category')
  const di = df.columns.indexOf(daysCol)
  const longStay = filterRows(dropAdmissionWard(df), (r) => toNum(r[di]) > LONG_STAY_THRESHOLD_DAYS)
  return { ...bucketCounts(longStay, categoryCol, overrides), category_review: reviewFrame(longStay, categoryCol, sourceFile, overrides) }
}

// ---------------------------------------------------------------- billing
const findPrefix = (df, name, required = true) => findColumn(df, name, 'prefix', required)

/** Some HIS bill-counter blocks carry an extra blank cell before Category:
 * Category empty, TotalAmt holds the category code. Shift those rows one column left. */
export function realignShiftedRows(df) {
  const ci = df.columns.indexOf(findPrefix(df, 'Category'))
  const ti = df.columns.indexOf(findPrefix(df, 'TotalAmt'))
  const shifted = (r) => r[ci] === null && typeof r[ti] === 'string' && r[ti].trim() !== '' && Number.isNaN(toNum(r[ti]))
  if (!df.rows.some(shifted)) return df
  return { columns: df.columns, rows: df.rows.map((r) => (shifted(r) ? [...r.slice(0, ci), ...r.slice(ci + 1), null] : r)) }
}

function processBilling(df, billTypes, sourceFile, overrides) {
  df = realignShiftedRows(df)
  const totalCol = findPrefix(df, 'TotalAmt')
  const discCol = findPrefix(df, 'DiscAmt')
  const billTypeCol = findPrefix(df, 'BillType')
  const categoryCol = findPrefix(df, 'Category')
  const bi = df.columns.indexOf(billTypeCol)
  const cleaned = filterRows(stripJunkRows(df, [totalCol, discCol]), (r) => billTypes.includes(r[bi]))
  const [ti, di, ci] = [totalCol, discCol, categoryCol].map((c) => cleaned.columns.indexOf(c))
  const enriched = cleaned.rows.map((r) => {
    const cat = resolveCategory(r[ci], overrides)
    return { net: toNum(r[ti]) - toNum(r[di]), cat, cashCredit: cat === 'General' ? 'Cash' : 'Credit', region: resolveRegion(r[ci], overrides) }
  })
  // Only rows with a region count, so OP + IP always equals Domestic + International.
  const total = sumNum(enriched.filter((e) => e.region !== null).map((e) => e.net))
  return { enriched, total, review: reviewFrame(cleaned, categoryCol, sourceFile, overrides) }
}

export const processBillingOp = (df, sourceFile = null, overrides = null) => processBilling(df, ['O_B'], sourceFile, overrides)
export const processBillingIp = (df, sourceFile = null, overrides = null) => processBilling(df, ['IP_D', 'IP_F'], sourceFile, overrides)

const DOMESTIC_CREDIT_BUCKETS = { ECHS: 'ECHS', 'P CARD FUND': 'P.Card.Fund', TPA: 'TPA', CPR: 'Corporates' }
const INTERNATIONAL_CREDIT_BUCKETS = { TPA: 'TPA Aasantha', CPR: 'Corporates (International)' }

/** enrichedRows: OP + IP rows from processBilling. */
export function aggregateBilling(enrichedRows) {
  const net = (pred) => sumNum(enrichedRows.filter(pred).map((e) => e.net))
  const dom = (e) => e.region === 'Domestic'
  const intl = (e) => e.region === 'International'
  const cash = (e) => e.cashCredit === 'Cash'
  const credit = (e) => e.cashCredit === 'Credit'
  const domestic = net(dom)
  const international = net(intl)
  const creditDomestic = net((e) => credit(e) && dom(e))
  const creditInternational = net((e) => credit(e) && intl(e))
  const result = {
    'Billing Domestic': domestic,
    'Billing International': international,
    'Billing Total': domestic + international,
    'Cash Domestic': net((e) => cash(e) && dom(e)),
    'Cash International': net((e) => cash(e) && intl(e)),
    'Credit Domestic Total': creditDomestic,
    'Credit International Total': creditInternational,
    'Credit Total Billing': creditDomestic + creditInternational,
  }
  for (const [cat, key] of Object.entries(DOMESTIC_CREDIT_BUCKETS)) result[`Credit Domestic ${key}`] = net((e) => credit(e) && dom(e) && e.cat === cat)
  for (const [cat, key] of Object.entries(INTERNATIONAL_CREDIT_BUCKETS)) result[`Credit International ${key}`] = net((e) => credit(e) && intl(e) && e.cat === cat)
  return result
}

// ---------------------------------------------------------------- AEPL
export function processAeplBilling(df) {
  const billCol = findColumn(df, 'AEPL Bill No', 'contains')
  const debitCol = findColumn(df, 'Posted Debit', 'contains')
  const creditCol = findColumn(df, 'Posted Credit', 'contains')
  const [bi, di, ci] = [billCol, debitCol, creditCol].map((c) => df.columns.indexOf(c))
  const kept = df.rows.filter((r) => !/NN|NP/.test(pyStr(r[bi]).toUpperCase()))
  return sumNum(kept.map((r) => toNum(r[di]))) - sumNum(kept.map((r) => toNum(r[ci])))
}

// ---------------------------------------------------------------- pipeline
const CAT_KEYS = ['General', 'TPA', 'ECHS', 'P.Card.Fund', 'Corporates', 'Total']

/** Names the report that failed so the UI can point at the right upload. */
export class StageProcessingError extends Error {
  constructor(label, reason) {
    super(`${label}: ${reason}`)
    this.label = label
    this.reason = reason
  }
}

function runStage(label, fn, ...args) {
  try {
    return fn(...args)
  } catch (err) {
    if (err instanceof StageProcessingError) throw err
    throw new StageProcessingError(label, err.message)
  }
}

/** frames: report type -> frame. Returns { values, categoryReview }. */
export function runPipeline(frames, overrides = null) {
  const f = frames
  const bed = runStage('Bed Occupancy', processBedOccupancy, f['Bed Occupancy'])
  const opNew = runStage('OP New Registration', processOpNewRegistration, f['OP New Registration'])
  const opEnc = runStage('OP Encounters', processOpEncounters, f['OP Encounters'])
  const ipAdm = runStage('IP Admission', processIpAdmission, f['IP Admission'], 'IP Admission', overrides)
  const admAnalysis = runStage('Admission Analysis', processAdmissionAnalysis, f['Admission Analysis'])
  const ipDis = runStage('IP Discharges', processIpDischarges, f['IP Discharges'], 'IP Discharges', overrides)
  // Long Stay reuses the IP Discharges upload
  const longStay = runStage('IP Discharges', processLongStayPatients, f['IP Discharges'], 'IP Discharges', overrides)
  const op = runStage('Billing INR OP', processBillingOp, f['Billing INR OP'], 'Billing INR OP', overrides)
  const ip = runStage('Billing INR IP', processBillingIp, f['Billing INR IP'], 'Billing INR IP', overrides)
  const aepl = runStage('AEPL Billing', processAeplBilling, f['AEPL Billing'])
  const totalBilling = op.total + ip.total
  const agg = runStage('Billing Aggregation', aggregateBilling, [...op.enriched, ...ip.enriched])

  const values = {
    'Bed Strength': bed.bed_strength,
    'Beds Occupied': bed.beds_occupied,
    'Occupancy %': bed.occupancy_pct,
    'OP New Registration': opNew,
    'OP Encounters': opEnc,
    ...admAnalysis,
    'Long Stay Patients': longStay.Total,
    'OP Billing': op.total,
    'IP Billing': ip.total,
    'Total Billing': totalBilling,
    'AEPL Billing': aepl,
    'Hospital Revenue (Net of AEPL)': totalBilling - aepl,
  }
  for (const k of CAT_KEYS) {
    values[`IP Admission ${k}`] = ipAdm[k]
    values[`IP Discharges ${k}`] = ipDis[k]
    values[`Long Stay Patients ${k}`] = longStay[k] // dashboard-only breakdown
  }
  Object.assign(values, agg)

  const categoryReview = mergeReviews([ipAdm.category_review, ipDis.category_review, longStay.category_review, op.review, ip.review])
  return { values, categoryReview }
}
