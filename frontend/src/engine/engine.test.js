// Port of backend/tests/*.py. Run from frontend/: node --test src/engine/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ExcelJS from 'exceljs'
import * as XLSX from 'xlsx'
import categoryMap from './data/category_map.json' with { type: 'json' }
import { rawFrame } from './excel.js'
import * as S from './stages.js'
import { detectReportDate, detectReportType, findHeaderRow, isCuratedBillingSheet, parseDateFromFilename, refineBillingTypeEvidence } from './detection.js'
import * as H from './history.js'
import { diffHeaders, runVerification, validateUpload } from './checks.js'
import { writeFinalOutput } from './finalOutput.js'
import * as api from './api.js'

const TEMPLATE = new URL('./final_output_template.xlsx', import.meta.url)
const D = H.parseIsoDate

// pandas-style DataFrame({col: [values]}) -> frame
function df(cols) {
  const columns = Object.keys(cols)
  const n = Math.max(...columns.map((c) => cols[c].length))
  return { columns, rows: Array.from({ length: n }, (_, i) => columns.map((c) => cols[c][i] ?? null)) }
}
const frame = (columns, rows) => ({ columns, rows })

// ---------------------------------------------------------------- AEPL
test('AEPL: drops NN/NP bills (any case), debit - credit, column-name variants', () => {
  const base = { 'AEPL Bill No': ['IPF/IPB_BC01/26/580', 'IPF/NNBC01/26/581', 'IPF/NPBC01/26/582', 'OPD/IPB_BC01/26/915'] }
  assert.equal(S.processAeplBilling(df({ ...base, 'Posted Debit Amt': [1000, 5000, 3000, 500], 'Posted Credit Amt': [200, 100, 50, 300] })), 1000)
  assert.equal(S.processAeplBilling(df({ 'AEPL Bill No': ['ipf/nnbc01/26/1', 'ipf/npbc01/26/2', 'ipf/ipb_bc01/26/3'], 'Posted Debit Amt': [100, 200, 300], 'Posted Credit Amt': [0, 0, 0] })), 300)
  assert.equal(S.processAeplBilling(df({ 'AEPL Bill No': ['IPF/IPB_BC01/26/580', 'IPF/NNBC01/26/581'], 'Posted Debit Amount': [1000, 9999], 'Posted Credit Amount': [100, 9999] })), 900)
})

// ---------------------------------------------------------------- billing
const opDf = () => df({
  'Bill\nType': ['IP Bill Counter - 1', 'O_B', 'O_B', 'IP_F'],
  'TotalAmt\n(Inc.Tax)': [null, 1000, 5000, 2000],
  'Disc\nAmt': [null, 100, 500, 200],
  Category: [null, 'GNL', 'TPA - AASANTHA 25', 'GNL'],
  Time: [null, '10:00', '11:00', '12:00'],
})

test('billing OP: junk + non-O_B rows dropped, rows enriched', () => {
  const { enriched, total } = S.processBillingOp(opDf())
  assert.equal(total, 900 + 4500)
  assert.deepEqual(enriched, [
    { net: 900, cat: 'General', cashCredit: 'Cash', region: 'Domestic' },
    { net: 4500, cat: 'TPA', cashCredit: 'Credit', region: 'International' },
  ])
})

test('billing IP: IP_F/IP_D kept, "Cate- gory" / "Total Amt (Inc. Tax)" variants', () => {
  const { enriched, total } = S.processBillingIp(df({
    'Bill\nType': ['IP Bill Counter - 1', 'IP_F', 'IP_D', 'O_B'],
    'Total Amt\n(Inc. Tax)': [null, 20000, 8000, 3000],
    'Disc\nAmt': [null, 3000, 800, 300],
    'Cate- gory': [null, 'GNL', 'CPR - Oman', 'GNL'],
  }))
  assert.equal(total, 17000 + 7200)
  assert.deepEqual(enriched, [
    { net: 17000, cat: 'General', cashCredit: 'Cash', region: 'Domestic' },
    { net: 7200, cat: 'CPR', cashCredit: 'Credit', region: 'International' },
  ])
})

test('billing: unclassified rows stay out of total', () => {
  const d = opDf()
  d.rows[2][3] = 'Unknown Code'
  const { enriched, total } = S.processBillingOp(d)
  assert.equal(total, 900)
  assert.equal(total, enriched.filter((e) => e.region !== null).reduce((s, e) => s + e.net, 0))
})

test('billing: row shifted one column right is realigned, not dropped', () => {
  const { enriched, total } = S.processBillingOp(df({
    'Bill\nType': ['O_B', 'O_B'], 'Patient Name': ['A', 'SANAL. G'], Category: ['GNL', null], 'TotalAmt\n(Inc.Tax)': [750, 'GNL'],
    'Credit\n Amt': [0, 2630], 'Disc\nAmt': [150, 0], 'Write off  Amt': [0, 530], 'Unnamed: 5': [null, 0],
  }))
  assert.equal(total, 600 + 2100)
  assert.deepEqual(enriched.map((e) => e.cat), ['General', 'General'])
})

const row = (net, cat, cashCredit, region) => ({ net, cat, cashCredit, region })

test('aggregateBilling: every bucket', () => {
  const r = S.aggregateBilling([
    row(1000, 'General', 'Cash', 'Domestic'), row(500, 'TPA', 'Credit', 'Domestic'), row(200, 'CPR', 'Credit', 'International'),
    row(2000, 'General', 'Cash', 'Domestic'), row(300, 'ECHS', 'Credit', 'Domestic'), row(150, 'TPA', 'Credit', 'International'),
  ])
  assert.equal(r['Billing Domestic'], 3800)
  assert.equal(r['Billing International'], 350)
  assert.equal(r['Billing Total'], 4150)
  assert.equal(r['Cash Domestic'], 3000)
  assert.equal(r['Cash International'], 0)
  assert.equal(r['Credit Domestic TPA'], 500)
  assert.equal(r['Credit Domestic ECHS'], 300)
  assert.equal(r['Credit Domestic P.Card.Fund'], 0)
  assert.equal(r['Credit Domestic Corporates'], 0)
  assert.equal(r['Credit Domestic Total'], 800)
  assert.equal(r['Credit International TPA Aasantha'], 150)
  assert.equal(r['Credit International Corporates (International)'], 200)
  assert.equal(r['Credit International Total'], 350)
  assert.equal(r['Credit Total Billing'], 1150)
})

test('aggregateBilling: unmapped rows excluded, no crash', () => {
  const r = S.aggregateBilling([row(100, 'General', 'Cash', 'Domestic'), row(50, null, 'Credit', null), row(200, 'TPA', 'Credit', 'International')])
  assert.equal(r['Billing Total'], 300)
  assert.equal(r['Cash Domestic'] + r['Credit Total Billing'], 300)
})

// ---------------------------------------------------------------- CAT-dependent counts
const sampleCats = () => df({ MrdNo: [1, 2, 3, 4, 5, 6], Category: ['GNL', 'TPA', 'ECHS', 'P CARD FUND', 'CPR', 'Totally Unknown'] })
const counts = (r) => [r.General, r.TPA, r.ECHS, r['P.Card.Fund'], r.Corporates, r.Total]

test('IP admission/discharges: one per bucket, unknown goes to review', () => {
  const r = S.processIpAdmission(sampleCats(), 'ip_admission.xlsx')
  assert.deepEqual(counts(r), [1, 1, 1, 1, 1, 5])
  assert.deepEqual(r.category_review, { possible_matches: [], unmatched: [{ raw_value: 'Totally Unknown', frequency: 1, source_file: 'ip_admission.xlsx' }] })
  const d = S.processIpDischarges(df({ MrdNo: [1, 2, 3, 4, 5, 6], 'Cate\ngory': ['GNL', 'TPA', 'ECHS', 'P CARD FUND', 'CPR', 'Bogus'] }), 'ip_discharges.xlsx')
  assert.deepEqual(counts(d), [1, 1, 1, 1, 1, 5])
  assert.equal(d.category_review.unmatched[0].raw_value, 'Bogus')
})

test('IP admission: multiple rows per bucket, overrides, fuzzy near-miss', () => {
  const r = S.processIpAdmission(df({ Category: ['GNL', 'GNL', 'TPA', 'GNL', 'ECHS'] }))
  assert.deepEqual(counts(r), [3, 1, 1, 0, 0, 5])
  assert.deepEqual(r.category_review, { possible_matches: [], unmatched: [] })
  const o = S.processIpAdmission(df({ Category: ['GNL', 'Weird Custom Value'] }), null, { weirdcustomvalue: 'TPA' })
  assert.deepEqual([o.TPA, o.General, o.Total], [1, 1, 2])
  assert.deepEqual(o.category_review, { possible_matches: [], unmatched: [] })
  const f = S.processIpAdmission(df({ Category: ['GNL', 'ESSI2025'] }), 'ip_admission.xlsx')
  assert.equal(f.ECHS, 0)
  assert.equal(f.category_review.possible_matches.length, 1)
  assert.equal(f.category_review.possible_matches[0].raw_value, 'ESSI2025')
  assert.equal(f.category_review.possible_matches[0].suggested_bucket, 'ECHS')
})

test('IP counts: Admission Ward rows excluded in every bucket', () => {
  const d = df({
    Category: ['GNL', 'GNL', 'TPA', 'ECHS', 'TPA', null],
    Ward: ['Admission Ward', 'B-General Male', ' admission ward ', 'ICU', 'T3F1 -Daycare Lounge', null],
  })
  for (const fn of [S.processIpAdmission, S.processIpDischarges]) {
    const r = fn(d)
    assert.deepEqual([r.General, r.TPA, r.ECHS, r.Total], [1, 1, 1, 3])
    assert.deepEqual(r.category_review.unmatched, [])
  }
})

// ---------------------------------------------------------------- category mapping
test('every confirmed category_map.json value still maps exactly', () => {
  const dropped = Object.entries(categoryMap).filter(([raw, e]) => !e.confirm && S.mapCategory(raw) === null).map(([raw]) => raw)
  assert.deepEqual(dropped, [])
})

test('mapCategory/mapRegion: domestic + international codes', () => {
  for (const [raw, bucket, region] of [
    ['CPR', 'CPR', 'Domestic'], ['  gnl ', 'General', 'Domestic'], ['ECHS 2025', 'ECHS', 'Domestic'], ['echs2025', 'ECHS', 'Domestic'],
    ['TPA 24', 'TPA', 'Domestic'], ['P CARD FUND', 'P CARD FUND', 'Domestic'], ['CPR - Oman', 'CPR', 'International'],
    ['GNL - Oman', 'General', 'International'], ['TPA-AASANDHA', 'TPA', 'International'],
    ['labcpr25op.1', 'CPR', 'Domestic'], ['labcpr26op.1', 'CPR', 'Domestic'], ['INHS 2025', 'General', 'Domestic'], ['INHS GNL', 'General', 'Domestic'],
  ]) {
    assert.equal(S.mapCategory(raw), bucket, raw)
    assert.equal(S.mapRegion(raw), region, raw)
  }
  assert.equal(S.mapCategory('Totally Unknown Category XYZ'), null)
  assert.equal(S.mapRegion('Totally Unknown Category XYZ'), null)
  assert.equal(S.BUCKET_TO_OUTPUT_KEY.CPR, 'Corporates')
  assert.equal(S.BUCKET_TO_OUTPUT_KEY.General, 'General')
})

test('normalizeLoose strips punctuation; non-strings -> ""', () => {
  assert.equal(S.normalizeLoose('CPR - 25'), 'cpr25')
  assert.equal(S.normalizeLoose('CPR25.'), 'cpr25')
  assert.equal(S.normalizeLoose(null), '')
})

test('resolveCategory/resolveRegion/isOverridden with overrides', () => {
  const ov = { [S.normalizeLoose('Weird ESI Variant')]: 'ECHS', [S.normalizeLoose('Junk Value')]: S.EXCLUDED, [S.normalizeLoose('Some Weird Corp')]: 'TPA' }
  assert.equal(S.resolveRegion('Some Weird Corp', ov), 'Domestic')
  assert.equal(S.resolveRegion('Junk Value', ov), null)
  assert.equal(S.resolveRegion('CPR - Oman', null), 'International')
  assert.equal(S.resolveRegion('CPR - Oman', {}), 'International')
  assert.equal(S.resolveCategory('CPR'), 'CPR')
  assert.equal(S.resolveCategory('Totally Unknown'), null)
  assert.equal(S.resolveCategory('Weird ESI Variant', ov), 'ECHS')
  assert.equal(S.resolveCategory('weird-esi variant!', ov), 'ECHS')
  assert.equal(S.resolveCategory('CPR', ov), 'CPR')
  assert.equal(S.resolveCategory('Still Unknown', ov), null)
  assert.equal(S.resolveCategory('Junk Value', ov), null)
  assert.equal(S.isOverridden('Weird ESI Variant', ov), true)
  assert.equal(S.isOverridden('Junk Value', ov), true)
  assert.equal(S.isOverridden('Never Touched', ov), false)
  assert.equal(S.isOverridden('Weird ESI Variant', null), false)
})

test('undocumented/unconfirmed year variants go to review with a suggestion', () => {
  assert.equal(S.mapCategory('CPR 27'), null)
  assert.equal(S.fuzzyBestMatch('CPR 27').bucket, 'CPR')
  assert.equal(S.mapCategory('TPA 26'), null)
  assert.equal(S.mapRegion('TPA 26'), null)
  assert.equal(S.fuzzyBestMatch('TPA 26').bucket, 'TPA')
  const ov = { [S.normalizeLoose('TPA 26')]: 'TPA' }
  assert.equal(S.resolveCategory('TPA 26', ov), 'TPA')
  assert.equal(S.resolveRegion('TPA 26', ov), 'Domestic')
})

// ---------------------------------------------------------------- category review
test('getUnmatchedCategories: frequency-sorted, nulls, missing column, overrides', () => {
  assert.deepEqual(S.getUnmatchedCategories(df({ Category: ['GNL', 'Bogus A', 'Bogus A', 'Bogus B', 'GNL', 'Bogus A'] }), 'Category', 'test.xlsx'), [
    { raw_value: 'Bogus A', frequency: 3, source_file: 'test.xlsx' },
    { raw_value: 'Bogus B', frequency: 1, source_file: 'test.xlsx' },
  ])
  assert.deepEqual(S.getUnmatchedCategories(df({ Category: ['GNL', null, null] }), 'Category', 'f.xlsx'), [{ raw_value: null, frequency: 2, source_file: 'f.xlsx' }])
  assert.deepEqual(S.getUnmatchedCategories(df({ Other: [1, 2] }), 'Category'), [])
  const d = df({ Category: ['GNL', 'Bogus A', 'Bogus B'] })
  for (const v of [S.EXCLUDED, 'TPA']) {
    assert.deepEqual(S.getUnmatchedCategories(d, 'Category', null, { [S.normalizeLoose('Bogus A')]: v }).map((e) => e.raw_value), ['Bogus B'])
  }
})

test('fuzzyBestMatch: near misses, nonsense, non-strings', () => {
  const m = S.fuzzyBestMatch('ESI2025')
  assert.equal(m.bucket, 'ECHS')
  assert.ok(m.similarity >= 90)
  assert.equal(S.fuzzyBestMatch('CPR .').bucket, 'CPR')
  assert.equal(S.fuzzyBestMatch('Totally Unrelated Nonsense Value'), null)
  assert.equal(S.fuzzyBestMatch(null), null)
  assert.equal(S.fuzzyBestMatch(NaN), null)
})

test('ratio matches rapidfuzz fuzz.ratio', () => {
  assert.equal(S.ratio('cpr26', 'cpr25'), 80)
  assert.equal(S.ratio('abc', 'abc'), 100)
  assert.equal(S.ratio('', ''), 100)
  assert.equal(S.ratio('esi2025', 'esi2025x'), 93.33333333333333)
  assert.equal(S.ratio('kitten', 'sitting'), 61.53846153846154)
})

test('classifyUnmatched / reviewFrame / mergeReviews', () => {
  const r = S.classifyUnmatched([
    { raw_value: 'ESI2025', frequency: 6, source_file: 'a.xlsx' },
    { raw_value: 'Totally Unrelated Nonsense', frequency: 1, source_file: 'a.xlsx' },
  ])
  assert.equal(r.possible_matches.length, 1)
  assert.equal(r.possible_matches[0].raw_value, 'ESI2025')
  assert.equal(r.possible_matches[0].suggested_bucket, 'ECHS')
  assert.ok('similarity' in r.possible_matches[0])
  assert.deepEqual(r.unmatched.map((e) => e.raw_value), ['Totally Unrelated Nonsense'])

  const rv = S.reviewFrame(df({ Category: ['GNL', 'ESSI2025', 'ESSI2025', 'Nonsense Value'] }), 'Category', 'billing_op.xlsx')
  assert.equal(rv.possible_matches[0].raw_value, 'ESSI2025')
  assert.equal(rv.possible_matches[0].frequency, 2)
  assert.equal(rv.unmatched[0].raw_value, 'Nonsense Value')

  const merged = S.mergeReviews([
    { possible_matches: [{ raw_value: 'X', frequency: 2 }], unmatched: [{ raw_value: 'Y', frequency: 1 }] },
    { possible_matches: [{ raw_value: 'Z', frequency: 5 }], unmatched: [{ raw_value: 'W', frequency: 9 }] },
  ])
  assert.deepEqual(merged.possible_matches.map((e) => e.raw_value), ['Z', 'X'])
  assert.deepEqual(merged.unmatched.map((e) => e.raw_value), ['W', 'Y'])
})

// ---------------------------------------------------------------- daily history / MTD / monthly average
test('recordDay + getMonthSeries: overwrite, out-of-order, cut-off, month scope', () => {
  const h = {}
  H.recordDay(h, D('2026-06-20'), { 'OP Encounters': 50 })
  H.recordDay(h, D('2026-06-05'), { 'OP Encounters': 999 })
  H.recordDay(h, D('2026-06-05'), { 'OP Encounters': 20 }) // re-processed: overwrite, not double count
  H.recordDay(h, D('2026-06-01'), { 'OP Encounters': 10 })
  assert.deepEqual(H.getMonthSeries(h, D('2026-06-20'), 'OP Encounters'), { 1: 10, 5: 20, 20: 50 })
  assert.deepEqual(H.getMonthSeries(h, D('2026-06-10'), 'OP Encounters'), { 1: 10, 5: 20 })
  const scoped = { '2026-05': { 'OP Encounters': { 31: 500 } }, '2026-06': { 'OP Encounters': { 1: 100 } } }
  assert.deepEqual(H.getMonthSeries(scoped, D('2026-06-01'), 'OP Encounters'), { 1: 100 })
})

test('history: invalid calendar days rejected on write, ignored on read', () => {
  assert.throws(() => H.recordDay({}, { y: 2026, m: 2, d: 31 }, { X: 1 }), /not a valid calendar date/)
  assert.throws(() => H.recordDay({}, { y: 2026, m: 6, d: 31 }, { X: 1 }), /not a valid calendar date/)
  H.recordDay({}, { y: 2024, m: 2, d: 29 }, { X: 1 }) // leap year ok
  assert.equal(H.parseIsoDate('2026-02-29'), null)
  const h = { '2026-02': { 'OP Encounters': { 1: 100, 15: 200, 30: 99999, 0: 5, 'not-a-day': 7 } } }
  assert.deepEqual(H.getMonthSeries(h, D('2026-02-28'), 'OP Encounters'), { 1: 100, 15: 200 })
  assert.deepEqual(H.getMonthRecords(h, 2026, 2), [{ day: 1, values: { 'OP Encounters': 100 } }, { day: 15, values: { 'OP Encounters': 200 } }])
  assert.deepEqual(H.finalizeMonth(h, 2026, 2)['OP Encounters'], { daily_avg: 150, mtd: 300 })
})

test('computeMonthColumn / finalizeMonth', () => {
  const h = {}
  const save = (iso, v) => H.recordDay(h, D(iso), { 'Total Billing': v })
  assert.equal(H.computeMonthColumn(h, D('2026-05-19')), null)
  assert.equal(H.finalizeMonth(h, 2026, 5), null)
  save('2026-06-01', 500)
  assert.deepEqual(H.getMonthRecords(h, 2026, 6), [{ day: 1, values: { 'Total Billing': 500 } }])
  assert.deepEqual(H.getMonthRecords(h, 2026, 5), [])
  assert.deepEqual(H.computeMonthColumn(h, D('2026-06-01')), { asOf: 500, dailyAverage: 500, mtdProjected: 15000 })
  save('2026-06-02', 200)
  assert.deepEqual(H.computeMonthColumn(h, D('2026-06-02')), { asOf: 200, dailyAverage: 350, mtdProjected: 350 * 30 })
  assert.deepEqual(H.finalizeMonth(h, 2026, 6)['Total Billing'], { daily_avg: 350, mtd: 700 })
  // automation joined mid-month: average only the recorded days
  save('2026-05-18', 100)
  save('2026-05-19', 100)
  assert.deepEqual(H.computeMonthColumn(h, D('2026-05-19')), { asOf: 100, dailyAverage: 100, mtdProjected: 3100 })
  assert.deepEqual(H.finalizeMonth(h, 2026, 5)['Total Billing'], { daily_avg: 100, mtd: 200 })
})

test('computeMtdColumns: cumulative, average, constant, derived, gaps', () => {
  const enc = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [i + 1, 200]))
  enc[18] = 3744
  let r = H.computeMtdColumns(D('2026-06-18'), { 'OP Encounters': 3744 }, { '2026-06': { 'OP Encounters': enc } })
  assert.equal(r['OP Encounters'].daily_avg, (200 * 17 + 3744) / 18)
  assert.equal(r['OP Encounters'].mtd_proj, ((200 * 17 + 3744) / 18) * 30)

  r = H.computeMtdColumns(D('2026-06-03'), { 'Beds Occupied': 1028 }, { '2026-06': { 'Beds Occupied': { 1: 900, 2: 950, 3: 1028 } } })
  assert.deepEqual(r['Beds Occupied'], { daily_avg: (900 + 950 + 1028) / 3, mtd_proj: (900 + 950 + 1028) / 3 })

  r = H.computeMtdColumns(D('2026-05-20'), { 'OP Encounters': 120 }, { '2026-05': { 'OP Encounters': { 18: 100, 19: 110, 20: 120 } } })
  assert.deepEqual(r['OP Encounters'], { daily_avg: 110, mtd_proj: 110 * 31 })
  assert.equal(H.computeMtdColumns(D('2026-05-20'), { 'OP Encounters': 120 }, {}), null)

  r = H.computeMtdColumns(D('2026-06-03'), { 'OP Encounters': 300 }, { '2026-06': { 'OP Encounters': { 1: 100, 3: 300 } } })
  assert.deepEqual(r['OP Encounters'], { daily_avg: 200, mtd_proj: 6000 })

  r = H.computeMtdColumns(D('2026-06-18'), { 'Bed Strength': 1000 }, { '2026-06': { 'Bed Strength': { 1: 1000 } } })
  assert.deepEqual(r['Bed Strength'], { daily_avg: 1000, mtd_proj: 1000 })

  r = H.computeMtdColumns(D('2026-06-18'),
    { 'Total Billing': 8742193.15, 'AEPL Billing': 9667188.25, 'Hospital Revenue (Net of AEPL)': 8742193.15 - 9667188.25 },
    { '2026-06': { 'Total Billing': { 1: 8742193.15, 18: 8742193.15 }, 'AEPL Billing': { 1: 9667188.25, 18: 9667188.25 } } })
  assert.deepEqual(r['Hospital Revenue (Net of AEPL)'], {
    daily_avg: r['Total Billing'].daily_avg - r['AEPL Billing'].daily_avg,
    mtd_proj: r['Total Billing'].mtd_proj - r['AEPL Billing'].mtd_proj,
  })

  assert.deepEqual(H.computeMtdColumns(D('2026-06-18'), {}, { '2026-06': { 'OP Encounters': { 1: 100 } } }), {})
})

test('MTD key classes do not overlap', () => {
  for (const [a, b] of [[H.CUMULATIVE_KEYS, H.AVERAGE_KEYS], [H.CUMULATIVE_KEYS, H.CONSTANT_KEYS], [H.AVERAGE_KEYS, H.CONSTANT_KEYS]]) {
    assert.deepEqual([...a].filter((k) => b.has(k)), [])
  }
})

// ---------------------------------------------------------------- detection / dates
const fromHeader = (header) => [header, header.map(() => 1), header.map(() => 1)]

test('detectReportType: sheet name, column fallback, no guess', () => {
  let r = detectReportType('8.OP encounters', fromHeader(['A', 'B']))
  assert.deepEqual([r.report_type, r.confidence, r.matched_via], ['OP Encounters', 'high', 'sheet_name'])
  r = detectReportType('Sheet1', fromHeader(['Aims Bill Number', 'Posted Debit Amount', 'Posted Credit Amount']))
  assert.deepEqual([r.report_type, r.confidence, r.matched_via], ['AEPL Billing', 'medium', 'columns'])
  r = detectReportType('Mystery Sheet', fromHeader(['Random Column A', 'Random Column B']))
  assert.deepEqual([r.report_type, r.confidence], [null, 'none'])
  for (const rt of S.REPORT_TYPES) assert.equal(detectReportType(rt, fromHeader(['A'])).report_type, rt)
})

test('curated billing sheet needs both tag columns', () => {
  assert.equal(detectReportType('Sheet3', fromHeader(['Bill No.', 'Bill Type', 'Dom/Int', 'Cash/Credit', 'CAT', 'Category', 'TotalAmt (Inc.Tax)', 'Disc Amt', 'Net'])).curated, true)
  assert.equal(detectReportType('Sheet1', fromHeader(['Bill No.', 'Bill Type', 'Category', 'TotalAmt (Inc.Tax)', 'Disc Amt', 'Net Amt'])).curated, false)
  assert.equal(isCuratedBillingSheet(['Bill No.', 'Dom/Int', 'TotalAmt (Inc.Tax)', 'Disc Amt']), false)
  assert.equal(isCuratedBillingSheet(['Bill No.', 'Cash/Credit', 'TotalAmt (Inc.Tax)', 'Disc Amt']), false)
})

test('billing OP vs IP by columns; Bill Type evidence', () => {
  const op = detectReportType('Sheet1', fromHeader(['Bill Type', 'TotalAmt (Inc.Tax)', 'Disc Amt', 'Category']))
  assert.equal(op.report_type, 'Billing INR OP')
  assert.deepEqual(new Set(op.report_types), new Set(['Billing INR OP', 'Billing INR IP']))
  const ip = detectReportType('Sheet2', fromHeader(['Bill Type', 'Total Amt (Inc. Tax)', 'Disc Amt', 'No. of days Admitted']))
  assert.deepEqual([ip.report_type, ip.report_types], ['Billing INR IP', ['Billing INR IP']])

  const header = ['Bill No.', 'Bill Type', 'TotalAmt (Inc.Tax)', 'Disc Amt']
  assert.deepEqual(refineBillingTypeEvidence([header, ['1', 'O_B', 100, 10], ['2', 'O_B', 200, 20]], 0, header), { op: true, ip: false })
  const stacked = [header, ...Array(30).fill(['1', 'O_B', 100, 10]), ['2', 'IP_F', 500, 50]]
  assert.deepEqual(refineBillingTypeEvidence(stacked, 0, header), { op: true, ip: true })
  const noType = ['Bill No.', 'TotalAmt (Inc.Tax)', 'Disc Amt']
  assert.deepEqual(refineBillingTypeEvidence([noType, ['1', 100, 10]], 0, noType), { op: false, ip: false })
})

test('findHeaderRow skips a title row', () => {
  const rows = [['Bed Type Wise Bed Occupancy Reports', null, null], ['Category', 'Bed Strength', 'Beds Occupied'], ['3 Bed Ward', 30, 25]]
  assert.deepEqual(findHeaderRow(rows), [1, ['Category', 'Bed Strength', 'Beds Occupied']])
})

test('detectReportDate: most common, across sheets, unparseable skipped, none', () => {
  const d = (day) => new Date(Date.UTC(2026, 5, day))
  assert.equal(detectReportDate([[0, [['Mrd Number', 'Registration Date'], [1, d(18)], [2, d(18)], [3, d(18)], [4, d(17)]]]]), '2026-06-18')
  assert.equal(detectReportDate([[0, [['Mrd Number', 'Registration Date'], [1, d(18)]]], [0, [['Bill No', 'Bill Date'], [1, d(18)], [2, d(18)]]]]), '2026-06-18')
  assert.equal(detectReportDate([[0, [['Category', 'Beds Occupied'], ['General', 25]]]]), null)
  assert.equal(detectReportDate([[0, [['Name', 'Some Date'], ['A', 'not a date'], ['B', d(18)]]]]), '2026-06-18')
  assert.equal(parseDateFromFilename('IP Admission 12-07-2026.xlsx'), '2026-07-12')
})

// ---------------------------------------------------------------- final output
async function readOut(bytes) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(bytes)
  return wb.getWorksheet('Final output')
}
const template = () => readFile(TEMPLATE)

test('writeFinalOutput: values in "As on" column, rounding, untouched rows', async () => {
  // template: Particulars in E -> As on F, Daily Average G, MTD (Proj) H
  const orig = await readOut(await template())
  const ws = await readOut(await writeFinalOutput(await template(), { 'Bed Strength': 1000, 'Beds Occupied': 966, 'OP Billing': 9923868.6, 'Long Stay Patients': 14 }, D('2026-07-12'), {}, []))
  assert.equal(ws.getCell('F1').value, 'As on 12 Jul 2026')
  assert.equal(ws.getCell('G1').value, 'Daily Average July')
  assert.equal(ws.getCell('H1').value, 'MTD July (Proj)')
  assert.equal(ws.getCell('F4').value, 1000)
  assert.equal(ws.getCell('F5').value, 966)
  assert.equal(ws.getCell('F32').value, 9923869)
  assert.equal(ws.getCell('F29').value, 14)
  for (const ref of ['F8', 'F9', 'G4', 'H4']) assert.deepEqual(ws.getCell(ref).value, orig.getCell(ref).value, ref) // not in ROW_MAP / not supplied
})

test('writeFinalOutput: Daily Average + MTD columns, "—" when month has no history', async () => {
  let ws = await readOut(await writeFinalOutput(await template(), { 'Bed Strength': 1000, 'Beds Occupied': 1028 }, D('2026-07-12'),
    { 'Bed Strength': { daily_avg: 1000, mtd_proj: 1000 }, 'Beds Occupied': { daily_avg: 964.6, mtd_proj: 964.6 } }, []))
  assert.deepEqual(['G4', 'H4', 'G5', 'H5'].map((c) => ws.getCell(c).value), [1000, 1000, 965, 965])
  ws = await readOut(await writeFinalOutput(await template(), { 'Bed Strength': 1000 }, D('2026-07-12'), null, []))
  assert.deepEqual(['F4', 'G4', 'H4', 'G63'].map((c) => ws.getCell(c).value), [1000, '—', '—', '—'])
})

test('writeFinalOutput: Hospital Revenue is a live formula in every column', async () => {
  const ws = await readOut(await writeFinalOutput(await template(),
    { 'Total Billing': 8742193.15, 'AEPL Billing': 9667188.25, 'Hospital Revenue (Net of AEPL)': 8742193.15 - 9667188.25 }, D('2026-06-18'),
    { 'Total Billing': { daily_avg: 485677.4, mtd_proj: 14570322 }, 'AEPL Billing': { daily_avg: 536999.3, mtd_proj: 16109980 } }, []))
  assert.deepEqual(['F', 'G', 'H'].map((c) => ws.getCell(`${c}63`).value.formula), ['F57-F60', 'G57-G60', 'H57-H60'])
})

test('writeFinalOutput: finalized month inserted left of Particulars; existing months not duplicated', async () => {
  const ws = await readOut(await writeFinalOutput(await template(), { 'Bed Strength': 1000 }, D('2026-08-03'), {},
    [[2026, 7, null], [2026, 6, { 'Total Billing': { daily_avg: 100.4, mtd: 200.6 } }], [2026, 5, { 'Total Billing': { daily_avg: 1, mtd: 1 } }]]))
  const headers = Array.from({ length: 12 }, (_, i) => ws.getCell(1, i + 1).value)
  assert.deepEqual(headers.slice(4, 9).map((h) => String(h).trim()), ['Daily Average June', 'MTD June', 'Daily Average July', 'MTD July', 'Particulars'])
  assert.equal(headers.filter((h) => h === 'Daily Average May').length, 1)
  assert.deepEqual(['E34', 'F34', 'G34', 'H34', 'J4'].map((c) => ws.getCell(c).value), [100, 201, '—', '—', 1000])
  assert.equal(ws.getCell('J1').value, 'As on 03 Aug 2026')
})

// ---------------------------------------------------------------- format validation
const BED_OCC = ['Category', 'Bed Strength', 'Beds Available for Admission', 'Beds Occupied', 'Percentage of Utilisation(%)']
const MAPPING = { 'Bed Occupancy': 'f.xlsx::Bed Occupancy' }
const books = (headers) => ({ 'f.xlsx': { sheetNames: ['Bed Occupancy'], rows: () => [headers] } })

test('validateUpload: baseline created, missing column fails, extra/reordered warn, reset', () => {
  const baselines = {}
  let r = validateUpload(MAPPING, books(BED_OCC), baselines)
  assert.deepEqual([r.error, r.warnings, r.changed], [null, [], true])
  assert.deepEqual(baselines['Bed Occupancy'], BED_OCC)

  const renamed = ['Category', 'Bed Capacity', ...BED_OCC.slice(2)]
  r = validateUpload(MAPPING, books(renamed), baselines)
  assert.deepEqual(r.error, { code: 'SCHEMA_MISMATCH', category: 'Bed Occupancy', missingColumns: ['Bed Strength'] })

  r = validateUpload(MAPPING, books([...BED_OCC].reverse()), baselines)
  assert.equal(r.error, null)
  assert.ok(r.warnings.some((w) => w.includes('reordered')))
  r = validateUpload(MAPPING, books([...BED_OCC, 'New Col']), baselines)
  assert.equal(r.error, null)
  assert.ok(r.warnings.some((w) => w.toLowerCase().includes('extra column')))

  delete baselines['Bed Occupancy'] // what /api/schema-baseline/reset does
  assert.equal(validateUpload(MAPPING, books(renamed), baselines).error, null)
  assert.deepEqual(baselines['Bed Occupancy'], renamed)
})

test('diffHeaders normalizes punctuation and case', () => {
  assert.deepEqual(diffHeaders('X', ['MRD  no.'], ['Mrd No']).missing, [])
})

// ---------------------------------------------------------------- long stay
const ls = (rows, columns = ['MrdNo', 'Category', 'Days']) => frame(columns, rows)

test('long stay: > 10 days only, every bucket, bad Days skipped', () => {
  let r = S.processLongStayPatients(ls([[1, 'GNL', 10], [2, 'GNL', 11], [3, 'TPA', 15]]))
  assert.deepEqual([r.General, r.TPA, r.Total], [1, 1, 2])
  r = S.processLongStayPatients(ls([[1, 'GNL', 12], [2, 'TPA', 20], [3, 'ECHS', 30], [4, 'P CARD FUND', 40], [5, 'CPR', 50], [6, 'GNL', 5]]))
  assert.deepEqual(r, { General: 1, TPA: 1, ECHS: 1, 'P.Card.Fund': 1, Corporates: 1, Total: 5, category_review: { possible_matches: [], unmatched: [] } })
  r = S.processLongStayPatients(ls([[1, 'GNL', 'not a number'], [2, 'GNL', 15], [3, 'GNL', null]]))
  assert.deepEqual([r.General, r.Total], [1, 1])
})

test('long stay: review, overrides, "Cate\\ngory", Admission Ward', () => {
  let r = S.processLongStayPatients(ls([[1, 'GNL', 15], [2, 'Nonsense Category', 20]]), 'ip_discharges.xlsx')
  assert.equal(r.Total, 1)
  assert.equal(r.category_review.unmatched[0].raw_value, 'Nonsense Category')
  r = S.processLongStayPatients(ls([[1, 'Weird Custom Value', 20]]), null, { weirdcustomvalue: 'TPA' })
  assert.deepEqual([r.TPA, r.Total, r.category_review.unmatched], [1, 1, []])
  assert.equal(S.processLongStayPatients(ls([[1, 'GNL', 15]], ['MrdNo', 'Cate\ngory', 'Days'])).General, 1)
  assert.equal(S.processLongStayPatients(ls([[1, 'GNL', 15, 'Admission Ward'], [2, 'GNL', 15, 'ICU']], ['MrdNo', 'Category', 'Days', 'Ward'])).Total, 1)
})

// ---------------------------------------------------------------- row cleaning / simple counters
test('stripJunkRows', () => {
  let c = S.stripJunkRows(df({ BillNo: ['IP Bill Counter - 1', 1, 2, 'Radiology Bill Counter', 3], TotalAmt: [null, 100, 200, null, 300], DiscAmt: [null, 10, 20, null, 30] }), ['TotalAmt', 'DiscAmt'])
  assert.deepEqual(c.rows.map((r) => r[0]), [1, 2, 3])
  c = S.stripJunkRows(df({ TotalAmt: [0, null], DiscAmt: [0, null] }), ['TotalAmt', 'DiscAmt'])
  assert.equal(c.rows.length, 1)
  c = S.stripJunkRows(df({ Category: ['NURSERY header', 'GNL', 'TPA'], 'Beds Occupied': [null, 5, 3] }), ['Beds Occupied'])
  assert.deepEqual(c.rows.map((r) => r[1]), [5, 3])
})

test('OP encounter subtotals: exclusions, orphan groups', () => {
  const enc = rawFrame([
    ['Speciality', 'Cardiology', null], [1, 'PATIENT A', null], [2, 'PATIENT B', null], ['Total Encounters', null, 2],
    ['Speciality', 'Radiology', null], [1, 'PATIENT C', null], ['Total Encounters', null, 1],
    ['Speciality', 'General Medicine', null], [1, 'PATIENT D', null], ['Total Encounters', null, 3],
  ])
  assert.equal(S.extractOpEncounterSubtotals(enc, S.EXCLUDE_SPECIALITIES), 5)
  assert.equal(S.processOpEncounters(enc), 5)
  assert.equal(S.extractOpEncounterSubtotals(rawFrame([['Speciality', '  amrita labs ', null], [1, 'X', null], ['Total Encounters', null, 99]]), S.EXCLUDE_SPECIALITIES), 0)
  assert.equal(S.extractOpEncounterSubtotals(rawFrame([['Speciality', 'Orphaned Group', null], [1, 'X', null], ['Speciality', 'Valid Group', null], [1, 'Y', null], ['Total Encounters', null, 7]]), S.EXCLUDE_SPECIALITIES), 7)
  assert.equal(S.extractOpEncounterSubtotals(rawFrame([['Speciality', 'Valid Group', null], [1, 'Y', null], ['Total Encounters', null, 4], ['Speciality', 'Trailing Orphan', null], [1, 'Z', null]]), S.EXCLUDE_SPECIALITIES), 4)
})

test('OP new registration counts numeric MRDs only', () => {
  assert.equal(S.processOpNewRegistration(df({ 'Mrd Number': [123, 456, null, 789], 'Patient Name': ['A', 'B', 'C', 'D'] })), 3)
  assert.equal(S.processOpNewRegistration(df({ 'Mrd Number': [123, 456, 789, 'a) Take the count of MRD number - 3 '] })), 3)
})

test('admission analysis reads the Total row; missing Total throws', () => {
  const cols = { 'Total Emergency Admission': [7, 17, 24], 'Total Planned\nAdmission': [1, 1, 2], 'Total admission from OP \n(walk-in)': [1, 15, 16] }
  assert.deepEqual(S.processAdmissionAnalysis(df({ Speciality: ['Cardiology', 'General Medicine', 'Total'], ...cols, Total: [9, 33, 42] })),
    { 'Emergency Admission': 24, 'Planned Admission': 2, 'Admission from OP (walk-in)': 16 })
  assert.throws(() => S.processAdmissionAnalysis(df({ Speciality: ['Cardiology'], 'Total Emergency Admission': [7], 'Total Planned\nAdmission': [1], 'Total admission from OP \n(walk-in)': [1] })), /Total/)
})

test('bed occupancy: excluded categories, junk rows, own Total row', () => {
  assert.deepEqual(S.processBedOccupancy(df({ Category: ['3 Bed Ward', 'Day Case A', 'Nursery', 'Bed Occupancy header', 'ICU'], 'Beds Occupied': [25, 4, 10, null, 15] })),
    { bed_strength: 1000, beds_occupied: 40, occupancy_pct: 0.04 })
  assert.equal(S.processBedOccupancy(df({ Category: ['operation theatre', 'EM UNIT', '3 Bed Ward'], 'Beds Occupied': [5, 2, 20] })).beds_occupied, 20)
  assert.equal(S.processBedOccupancy(df({ Category: ['3 Bed Ward', 'ICU', 'Total'], 'Beds Occupied': [25, 157, 182] })).beds_occupied, 182)
})

test('runPipeline names the failing report', () => {
  assert.throws(() => S.runPipeline({ 'Bed Occupancy': df({ X: [1] }) }), (e) => e instanceof S.StageProcessingError && e.label === 'Bed Occupancy')
})

// ---------------------------------------------------------------- verification
const GOOD = {
  'Bed Strength': 1000, 'Beds Occupied': 900, 'Occupancy %': 0.9,
  'OP Billing': 100, 'IP Billing': 200, 'Total Billing': 300,
  'Billing Domestic': 250, 'Billing International': 50, 'Billing Total': 300,
  'Cash Domestic': 100, 'Cash International': 20,
  'Credit Domestic ECHS': 40, 'Credit Domestic P.Card.Fund': 30, 'Credit Domestic TPA': 60, 'Credit Domestic Corporates': 20, 'Credit Domestic Total': 150,
  'Credit International TPA Aasantha': 20, 'Credit International Corporates (International)': 10, 'Credit International Total': 30,
  'Credit Total Billing': 300, 'AEPL Billing': 10,
  'IP Admission Total': 10, 'IP Admission General': 4, 'IP Admission TPA': 3, 'IP Admission ECHS': 1, 'IP Admission P.Card.Fund': 1, 'IP Admission Corporates': 1,
  'IP Discharges Total': 5, 'IP Discharges General': 2, 'IP Discharges TPA': 1, 'IP Discharges ECHS': 1, 'IP Discharges P.Card.Fund': 1, 'IP Discharges Corporates': 0,
}
const failed = (report) => report.checks.filter((c) => !c.pass).map((c) => c.name)

test('verification: clean values pass, broken reconciliation / negatives fail', () => {
  const ok = runVerification(GOOD, {})
  assert.deepEqual(failed(ok), [])
  assert.ok(ok.allPassed)
  for (const c of ok.checks) if (c.delta !== null) assert.ok(Math.abs(c.delta) <= 0.01)
  const broken = runVerification({ ...GOOD, 'Total Billing': 999, 'Billing Total': 999, 'Credit Total Billing': 999 }, {})
  assert.ok(failed(broken).includes('Row 34 Total Billing == row 32 + row 33'))
  assert.equal(broken.allPassed, false)
  assert.ok(failed(runVerification({ ...GOOD, 'AEPL Billing': -5 }, {})).includes('AEPL Billing is not negative'))
})

test('verification: billing recompute + OP encounter recount + errored check', () => {
  const op = df({ 'Bill Type': ['O_B', 'O_B', 'IP_D', null], 'TotalAmt(Inc.Tax)': [100, 50, 999, null], 'Disc Amt': [10, 0, 0, null] })
  const ip = df({ 'Bill Type': ['IP_D', 'IP_F', 'O_B'], 'Total Amt(Inc.Tax)': [200, 100, 999], 'Disc Amt': [50, 0, 0] })
  const enc = rawFrame([
    ['S.No.', 'VisitDate', 'Mrd No', 'Patient Name'], ['Speciality', 'Cardiology', null, null], [1, 'd', 'M1', 'A'], [2, 'd', 'M2', 'B'],
    ['Total Encounters', null, 2, null], ['Speciality', 'Radiology', null, null], [1, 'd', 'M3', 'C'], ['Total Encounters', null, 1, null],
  ])
  const values = { ...GOOD, 'OP Billing': 140, 'IP Billing': 250, 'Total Billing': 390, 'Billing Total': 390, 'Credit Total Billing': 390,
    'Billing Domestic': 340, 'Cash Domestic': 190, 'OP Encounters': 2 }
  const report = runVerification(values, { 'Billing INR OP': op, 'Billing INR IP': ip, 'OP Encounters': enc })
  const find = (p) => report.checks.find((c) => c.name.startsWith(p))
  assert.ok(find('Row 34 Total Billing recompute').pass)
  assert.ok(find('Row 10 OP Encounters recount').pass)
  const errored = runVerification({ ...GOOD, 'OP New Registration': 5 }, { 'OP New Registration': df({ X: [1] }) }).checks.filter((c) => c.name.includes('check errored'))
  assert.ok(errored.length && !errored[0].pass)
})

// ---------------------------------------------------------------- API / export gate
test('pendingBillingValues only blocks on resolvable billing entries', () => {
  assert.deepEqual(api.pendingBillingValues({
    possible_matches: [{ raw_value: 'CPR 26', source_file: 'Billing INR IP', frequency: 2 }],
    unmatched: [{ raw_value: null, source_file: 'Billing INR OP', frequency: 5 }, { raw_value: 'Weird', source_file: 'IP Admission', frequency: 1 }],
  }), ['CPR 26'])
  assert.deepEqual(api.pendingBillingValues({ possible_matches: [], unmatched: [] }), [])
})

function workbook(sheets) {
  const wb = XLSX.utils.book_new()
  for (const [name, aoa] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name)
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))
}

test('API: detect -> process (export gated on billing review) -> resolve -> download', async () => {
  Object.assign(api.store, { 'daily_history.json': '{}', 'learned_overrides.json': '{"esi2025":"ECHS"}', 'verification_history.json': '{}', 'schema_baselines.json': '{}' })
  api.config.loadTemplate = template
  const name = 'daily 12-07-2026.xlsx'
  const bill = ['Bill Type', 'Category', 'TotalAmt', 'DiscAmt']
  const files = [{ name, bytes: workbook({
    'Bed Occupancy': [['Category', 'Bed Strength', 'Beds Occupied'], ['ICU', 10, 5], ['Total', 10, 5]],
    'OP New Registration': [['Mrd Number', 'Registration Date'], [1, '2026-07-12'], [2, '2026-07-12']],
    'OP Encounters': [['S.No.', 'VisitDate', 'Mrd No', 'TokenNumber', 'Login Id'], ['Speciality', 'Cardiology'], [1, 'd', 'M1'], ['Total Encounters', null, 1]],
    'IP Admission': [['MRD No', 'Category', 'Ward'], [1, 'GNL', 'ICU'], [2, 'TPA', 'ICU']],
    'Admission Analysis': [['Speciality', 'Total Emergency Admission', 'Total Planned Admission', 'Total admission from OP (walk-in)'], ['Total', 3, 2, 1]],
    'IP Discharges': [['MrdNo', 'Category', 'Days', 'Ward'], [1, 'GNL', 12, 'ICU']],
    'Billing INR OP': [bill, ['O_B', 'GNL', 1000, 100]],
    'Billing INR IP': [bill, ['IP_D', 'CPR 26', 500, 0]],
    'AEPL Billing': [['AEPL Bill No', 'Posted Debit', 'Posted Credit'], ['X/1', 50, 10]],
  }) }]

  const det = await api.handle({ method: 'POST', path: '/detect', files })
  assert.equal(det.json.detected_date, '2026-07-12')
  assert.deepEqual(det.json.missing, [])
  const mapping = Object.fromEntries(det.json.matches.map((m) => [m.report_type, m.candidate_id]))
  for (const rt of S.REPORT_TYPES) assert.equal(mapping[rt], `${name}::${rt}`, rt)

  const proc = (await api.handle({ method: 'POST', path: '/process', body: { mapping: JSON.stringify(mapping), date: '2026-07-12' }, files })).json
  assert.equal(proc.status, 'warning', JSON.stringify(proc))
  assert.ok(proc.warnings.some((w) => w.startsWith('Export blocked') && w.includes('CPR 26')))
  assert.equal(proc.values['Total Billing'], 900) // CPR 26 has no region yet
  assert.equal(proc.values['OP Encounters'], 1)
  assert.equal(proc.values['IP Admission Total'], 2)
  assert.equal(proc.values['Long Stay Patients'], 1)
  assert.equal(proc.values['AEPL Billing'], 40)
  assert.equal(api.store['daily_history.json'], '{}') // unreconciled day never enters MTD
  assert.equal((await api.handle({ method: 'GET', path: `/download/${proc.file_id}` })).status, 409)

  const review = await api.handle({ method: 'GET', path: '/category-review', query: `file_id=${proc.file_id}` })
  assert.equal(review.json.possible_matches[0].raw_value, 'CPR 26')
  const bad = await api.handle({ method: 'POST', path: '/category-review/resolve', body: { file_id: proc.file_id, resolutions: [{ raw_value: 'CPR 26', chosen_bucket: 'Nope' }] } })
  assert.match(bad.json.reason, /Unknown bucket/)
  const res = (await api.handle({ method: 'POST', path: '/category-review/resolve', body: { file_id: proc.file_id, resolutions: [{ raw_value: 'CPR 26', chosen_bucket: 'CPR' }] } })).json
  assert.equal(res.status, 'success', JSON.stringify(res.warnings))
  assert.equal(res.values['Total Billing'], 1400)
  assert.ok(res.verification.allPassed, JSON.stringify(failed(res.verification)))
  assert.deepEqual(JSON.parse(api.store['learned_overrides.json']), { cpr26: 'CPR', esi2025: 'ECHS' })
  assert.equal(JSON.parse(api.store['daily_history.json'])['2026-07']['Total Billing']['12'], 1400)

  const dl = await api.handle({ method: 'GET', path: `/download/${proc.file_id}` })
  assert.equal(dl.filename, 'Final Output - 12-07-2026.xlsx')
  const ws = await readOut(dl.bytes)
  assert.deepEqual(['F34', 'G34', 'H34'].map((c) => ws.getCell(c).value), [1400, 1400, 1400 * 31])

  const avg = await api.handle({ method: 'GET', path: '/api/monthly-average', query: 'date=2026-07-12' })
  assert.deepEqual(avg.json.data, { monthAvailable: true, asOf: 1400, dailyAverage: 1400, mtdProjected: 43400 })
  assert.equal((await api.handle({ method: 'GET', path: '/api/verification-report', query: 'date=2026-07-12' })).json.success, true)
  assert.ok(JSON.parse(api.store['schema_baselines.json'])['Bed Occupancy'])
  assert.equal((await api.handle({ method: 'POST', path: '/api/schema-baseline/reset', body: { category: 'Bed Occupancy' } })).json.success, true)
  assert.equal(JSON.parse(api.store['schema_baselines.json'])['Bed Occupancy'], undefined)
  assert.equal((await api.handle({ method: 'GET', path: '/download/nope' })).status, 404)
})
