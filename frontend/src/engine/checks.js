// Stage 0 (format validation against stored header baselines, blocks the run)
// and the post-pipeline verification (independent recomputes, never blocks).
import { findHeaderRow, normalizeAlnum, parseCandidateId } from './detection.js'
import { sumNum, toNum } from './excel.js'
import { EXCLUDE_SPECIALITIES, GROUP_END_LABEL, GROUP_START_LABEL, findColumn, normalizeSpace } from './stages.js'

// From the confirmed sample workbook: only validates a category's very first upload, which then becomes its baseline.
const REFERENCE_HEADERS = {
  'OP New Registration': ['Mrd Number', 'Patient Name', 'Speciality', 'Fee Paid?', 'Amount', 'Registration Date', 'Remarks', 'Created By'],
  'OP Encounters': ['S.No.', 'VisitDate', 'Mrd No', 'Patient Name', 'TokenNumber', 'Visit Id', 'Doctor', 'Remarks', 'Login Id'],
  'Admission Analysis': ['Speciality', 'Total Emergency Admission', 'Total Planned Admission', 'Total admission from OP (walk-in)', 'Total'],
  'IP Admission': ['Sl.No.', 'MRD No', 'SpecialityName', 'Patient Name', 'District', 'Age', 'Gender', 'ConsultingDoctor', 'Admit Date',
    'Disch Date', 'Disch.Approved Date', 'Ward', 'Visit code', 'Category', 'Days', 'Bill Created?', 'Bed Type', 'Patient Status'],
  'IP Discharges': ['S.No.', 'MrdNo', 'SpecialityName', 'PatientName', 'ConsultingDoctor', 'Admitted Date', 'Discharge Date',
    'Disch Date Approved', 'Disch MarkedTime', 'Send For Billing Time', 'Ward', 'Visit Code', 'Category', 'Discharge status',
    'Discharge Summary Approved Time', 'Days'],
  'Billing INR OP': ['Sl.No.', 'Bill No.', 'User Name', 'Date', 'Time', 'MRD No.', 'Visit Code', 'Bill Type', 'Patient Name', 'Category',
    'TotalAmt(Inc.Tax)', 'Credit Amt', 'Disc Amt', 'Write off Amt', 'Net Amt', 'Paid Amt', 'Payment Due', 'RefundedAmt',
    'BillWiseDiscount', 'ItemWiseDiscount'],
  'Billing INR IP': ['Sl.No.', 'Bill No.', 'User Name', 'Discharge Date', 'MRD No.', 'Visit Code', 'Bill Type', 'Patient Name', 'Category',
    'Total Amt(Inc.Tax)', 'Credit Amt', 'Disc Amt', 'Write off Amt', 'Net Amt', 'Paid Amt', 'Payment Due', 'RefundedAmt', 'Tax',
    'Pay Status', 'Bill Status'],
  'AEPL Billing': ['SL.NO', 'AEPL Bill No', 'Posted Date', 'MRD', 'Patient Name', 'Posted Debit Amount', 'Posted Credit Amount',
    'Bill type', 'Aims Bill Number', 'Status', 'Confirmed Date', 'Account Head', 'Patient Category'],
  'Bed Occupancy': ['Category', 'Bed Strength', 'Beds Available for Admission', 'Beds Occupied', 'Percentage of Utilisation(%)'],
}

export function extractHeaders(rows) {
  const [, header] = findHeaderRow(rows.slice(0, 15))
  return header.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim())
}

/** Missing baseline columns -> hard fail; extra/reordered -> warning. Compared alnum-normalized. */
export function diffHeaders(category, actual, baseline) {
  const actualSet = new Set(actual.map(normalizeAlnum))
  const baselineSet = new Set(baseline.map(normalizeAlnum))
  const missing = baseline.filter((h) => !actualSet.has(normalizeAlnum(h)))
  const extra = actual.filter((h) => !baselineSet.has(normalizeAlnum(h)))
  const warnings = []
  if (extra.length) warnings.push(`${category}: extra column(s) not in baseline: ${extra.join(', ')}`)
  else if (!missing.length && actual.map(normalizeAlnum).join('\0') !== baseline.map(normalizeAlnum).join('\0')) {
    warnings.push(`${category}: columns reordered vs baseline (all present).`)
  }
  return { missing, warnings }
}

/** Mutates baselines (first upload of a category becomes its baseline).
 * Returns { error: SCHEMA_MISMATCH | null, warnings, changed }. */
export function validateUpload(mapping, books, baselines) {
  const warnings = []
  let changed = false
  for (const [category, id] of Object.entries(mapping)) {
    const [file, sheet] = parseCandidateId(id)
    if (!books[file]) continue // buildFrames reports this with its own message
    let actual
    try {
      actual = extractHeaders(books[file].rows(sheet))
    } catch {
      continue // unreadable sheet -> let loading surface it
    }
    const firstRun = !Object.hasOwn(baselines, category)
    const result = diffHeaders(category, actual, (firstRun ? null : baselines[category]) || REFERENCE_HEADERS[category] || [])
    if (result.missing.length && firstRun) {
      // the seeded reference is advisory: adopt the first real file as baseline
      warnings.push(`${category}: differs from reference headers (${result.missing.join(', ')} absent); adopting actual headers as baseline.`)
      result.missing = []
    }
    if (result.missing.length) return { error: { code: 'SCHEMA_MISMATCH', category, missingColumns: result.missing }, warnings, changed }
    warnings.push(...result.warnings)
    if (firstRun) {
      baselines[category] = actual
      changed = true
    }
  }
  return { error: null, warnings, changed }
}

// ---------------------------------------------------------------- verification
const TOLERANCE = 0.01

const RECONCILIATIONS = [
  ['Row 11 IP Admission total == sum of rows 12-16', 'IP Admission Total',
    ['IP Admission General', 'IP Admission TPA', 'IP Admission ECHS', 'IP Admission P.Card.Fund', 'IP Admission Corporates']],
  ['Row 22 IP Discharges total == sum of rows 23-27', 'IP Discharges Total',
    ['IP Discharges General', 'IP Discharges TPA', 'IP Discharges ECHS', 'IP Discharges P.Card.Fund', 'IP Discharges Corporates']],
  ['Row 34 Total Billing == row 32 + row 33', 'Total Billing', ['OP Billing', 'IP Billing']],
  ['Row 39 Billing total == row 37 + row 38', 'Billing Total', ['Billing Domestic', 'Billing International']],
  ['Row 48 Credit-Domestic == sum of rows 49-52', 'Credit Domestic Total',
    ['Credit Domestic ECHS', 'Credit Domestic P.Card.Fund', 'Credit Domestic TPA', 'Credit Domestic Corporates']],
  ['Row 54 Credit-International == sum of rows 55-56', 'Credit International Total',
    ['Credit International TPA Aasantha', 'Credit International Corporates (International)']],
  ['Row 57 Total Billing == rows 44+45+48+54', 'Total Billing',
    ['Cash Domestic', 'Cash International', 'Credit Domestic Total', 'Credit International Total']],
]

const NON_NEGATIVE_KEYS = ['OP Billing', 'IP Billing', 'Total Billing', 'Billing Domestic', 'Billing International', 'Billing Total',
  'Cash Domestic', 'Cash International', 'Credit Domestic Total', 'Credit International Total', 'Credit Total Billing', 'AEPL Billing']

function check(name, expected, actual) {
  const ok = expected != null && actual != null
  const delta = ok ? Number(actual) - Number(expected) : null
  return { name, expected: expected ?? null, actual: actual ?? null, delta, pass: ok && Math.abs(delta) <= TOLERANCE }
}

// a broken check fails with a note; it never throws
function guarded(name, expected, compute) {
  try {
    return check(name, expected, compute())
  } catch (err) {
    return { name: `${name} (check errored: ${err.message})`, expected: expected ?? null, actual: null, delta: null, pass: false }
  }
}

function recountOpNewRegistration(df) {
  const i = df.columns.indexOf(findColumn(df, 'Mrd Number', 'prefix'))
  return df.rows.filter((r) => r[i] !== null && String(r[i]).trim() !== '' && String(r[i]).trim() !== 'None').length
}

/** Counts detail rows (non-blank Mrd No) inside non-excluded speciality groups --
 * independent of the subtotal rows the pipeline sums. */
function recountOpEncounters(df) {
  const excluded = new Set(EXCLUDE_SPECIALITIES.map(normalizeSpace))
  let mrdIdx = -1
  let headerIdx = -1
  for (const [r, row] of df.rows.slice(0, 15).entries()) {
    mrdIdx = row.findIndex((c) => typeof c === 'string' && normalizeAlnum(c) === 'mrdno')
    if (mrdIdx >= 0) {
      headerIdx = r
      break
    }
  }
  if (mrdIdx < 0) throw new Error("OP Encounters: no 'Mrd No' column found.")
  let count = 0
  let inGroup = false
  let groupExcluded = false
  for (const row of df.rows.slice(headerIdx + 1)) {
    const label = row[0]
    if (typeof label === 'string' && label.trim() === GROUP_START_LABEL) {
      inGroup = true
      groupExcluded = typeof row[1] === 'string' && excluded.has(normalizeSpace(row[1]))
      continue
    }
    if (typeof label === 'string' && label.trim() === GROUP_END_LABEL) {
      inGroup = false
      continue
    }
    if (!inGroup || groupExcluded) continue
    if (row[mrdIdx] !== null && String(row[mrdIdx]).trim() !== '') count++
  }
  return count
}

function recomputeTotalBilling(opDf, ipDf) {
  let total = 0
  for (const [df, types] of [[opDf, ['O_B']], [ipDf, ['IP_D', 'IP_F']]]) {
    const [ti, di, bi] = ['TotalAmt', 'DiscAmt', 'BillType'].map((n) => df.columns.indexOf(findColumn(df, n, 'prefix')))
    total += sumNum(df.rows.filter((r) => types.includes(r[bi]) && !(Number.isNaN(toNum(r[ti])) && Number.isNaN(toNum(r[di])))).map((r) => toNum(r[ti]) - toNum(r[di])))
  }
  return total
}

/** sources: report type -> the frames the pipeline ran on. */
export function runVerification(values, sources) {
  const num = (k) => {
    if (!(k in values)) throw new Error(`'${k}'`)
    return Number(values[k])
  }
  const checks = []
  if (sources['OP New Registration']) {
    checks.push(guarded('Row 9 OP New Registration recount (non-blank Mrd Number)', values['OP New Registration'],
      () => recountOpNewRegistration(sources['OP New Registration'])))
  }
  if (sources['OP Encounters']) {
    checks.push(guarded('Row 10 OP Encounters recount (detail rows, exclusions applied)', values['OP Encounters'],
      () => recountOpEncounters(sources['OP Encounters'])))
  }
  if (sources['Billing INR OP'] && sources['Billing INR IP']) {
    checks.push(guarded('Row 34 Total Billing recompute (sum of Net across billing sheets)', values['Total Billing'],
      () => recomputeTotalBilling(sources['Billing INR OP'], sources['Billing INR IP'])))
  }
  for (const [name, target, addends] of RECONCILIATIONS) {
    checks.push(guarded(name, values[target], () => addends.reduce((s, k) => s + num(k), 0)))
  }
  checks.push(guarded('Row 39 == Row 34 (both billing totals agree)', values['Total Billing'], () => num('Billing Total')))
  checks.push(guarded('Row 6 Occupancy % == row 5 / row 4', values['Occupancy %'], () => num('Beds Occupied') / num('Bed Strength')))
  for (const key of NON_NEGATIVE_KEYS) {
    if (key in values) checks.push({ name: `${key} is not negative`, expected: '>= 0', actual: values[key], delta: null, pass: Number(values[key]) >= 0 })
  }
  if ('Occupancy %' in values) {
    const occ = Number(values['Occupancy %'])
    checks.push({ name: 'Occupancy % within [0, 1.5]', expected: '0 to 1.5', actual: occ, delta: null, pass: occ >= 0 && occ <= 1.5 })
  }
  return { checks, allPassed: checks.every((c) => c.pass) }
}
