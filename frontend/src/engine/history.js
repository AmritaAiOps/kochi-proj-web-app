// Daily history (each processed day's values, month -> metric -> day) and the
// Daily Average / MTD figures built from it. The app sees one day at a time,
// so MTD only ever reflects days actually processed here. A report date is
// { y, m, d } (see parseIsoDate).
import { daysInMonth, validDate } from './detection.js'
import { ROW_MAP } from './finalOutput.js'

export function parseIsoDate(s) {
  const m = typeof s === 'string' && s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  return m && validDate(+m[1], +m[2], +m[3]) ? { y: +m[1], m: +m[2], d: +m[3], iso: s } : null
}

export const monthKey = (date) => `${String(date.y).padStart(4, '0')}-${String(date.m).padStart(2, '0')}`

// A day filed under the wrong month (hand edit, bad merge) is rejected/ignored, never summed.
function isValidDay(month, day) {
  const [y, m] = month.split('-').map(Number)
  const d = Number(day)
  return Number.isInteger(y) && Number.isInteger(m) && m >= 1 && m <= 12 && Number.isInteger(d) && d >= 1 && d <= daysInMonth(y, m)
}

/** Stores today's values under this month; re-processing a date overwrites it. Mutates and returns history. */
export function recordDay(history, date, values) {
  const month = monthKey(date)
  const day = String(date.d)
  if (!isValidDay(month, day)) throw new Error(`Refusing to record day '${day}' under month '${month}': not a valid calendar date.`)
  history[month] ??= {}
  for (const [key, value] of Object.entries(values)) (history[month][key] ??= {})[day] = value
  return history
}

/** { day -> value } for days 1..date.d recorded for metricKey. */
export function getMonthSeries(history, date, metricKey) {
  const month = monthKey(date)
  const series = history[month]?.[metricKey] ?? {}
  return Object.fromEntries(Object.entries(series).filter(([day]) => isValidDay(month, day) && Number(day) <= date.d).map(([day, v]) => [Number(day), v]))
}

/** [{ day, values: { metric: value } }] for every recorded day of the month, in day order. */
export function getMonthRecords(history, y, m) {
  const month = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`
  const data = history[month] ?? {}
  const days = [...new Set(Object.values(data).flatMap((s) => Object.keys(s)).filter((d) => isValidDay(month, d)).map(Number))].sort((a, b) => a - b)
  return days.map((day) => ({
    day,
    values: Object.fromEntries(Object.entries(data).filter(([, s]) => Object.hasOwn(s, String(day))).map(([k, s]) => [k, s[String(day)]])),
  }))
}

// Snapshot metrics: averaged, never summed or projected.
export const AVERAGE_KEYS = new Set(['Beds Occupied', 'Occupancy %'])
export const CONSTANT_KEYS = new Set(['Bed Strength'])
// Same subtraction in every column (row 63 = row 57 - row 60).
export const DERIVED_KEYS = { 'Hospital Revenue (Net of AEPL)': ['Total Billing', 'AEPL Billing'] }
// Everything else in ROW_MAP is a daily flow: mean of recorded days, projected over the month.
export const CUMULATIVE_KEYS = new Set(Object.values(ROW_MAP).filter((k) => !AVERAGE_KEYS.has(k) && !CONSTANT_KEYS.has(k) && !(k in DERIVED_KEYS)))

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length

/** { metric: { daily_avg, mtd_proj } } for the current month, or null when it has no recorded days. */
export function computeMtdColumns(date, values, history) {
  const month = history[monthKey(date)]
  if (!month || !Object.keys(month).length) return null
  const days = daysInMonth(date.y, date.m)
  const result = {}
  for (const key of CUMULATIVE_KEYS) {
    if (!(key in values)) continue
    const series = Object.values(getMonthSeries(history, date, key))
    if (!series.length) continue
    // mean of days actually recorded, so a skipped day doesn't drag the average
    const avg = mean(series)
    result[key] = { daily_avg: avg, mtd_proj: avg * days }
  }
  for (const key of AVERAGE_KEYS) {
    if (!(key in values)) continue
    const series = Object.values(getMonthSeries(history, date, key))
    const avg = series.length ? mean(series) : values[key]
    result[key] = { daily_avg: avg, mtd_proj: avg }
  }
  for (const key of CONSTANT_KEYS) if (key in values) result[key] = { daily_avg: values[key], mtd_proj: values[key] }
  for (const [key, [pos, neg]] of Object.entries(DERIVED_KEYS)) {
    if (result[pos] && result[neg]) {
      result[key] = { daily_avg: result[pos].daily_avg - result[neg].daily_avg, mtd_proj: result[pos].mtd_proj - result[neg].mtd_proj }
    }
  }
  return result
}

/** Running { asOf, dailyAverage, mtdProjected } for one metric, or null with no recorded days. */
export function computeMonthColumn(history, date, metricKey = 'Total Billing') {
  const values = new Map(
    getMonthRecords(history, date.y, date.m).filter((r) => r.day <= date.d && metricKey in r.values).map((r) => [r.day, r.values[metricKey]]),
  )
  if (!values.size) return null
  const asOf = values.get(date.d) ?? null
  const avg = mean([...values.values()])
  if (CONSTANT_KEYS.has(metricKey)) return { asOf, dailyAverage: asOf, mtdProjected: asOf }
  if (AVERAGE_KEYS.has(metricKey)) return { asOf, dailyAverage: avg, mtdProjected: avg }
  return { asOf, dailyAverage: avg, mtdProjected: avg * daysInMonth(date.y, date.m) }
}

/** Static 2-col figures for a completed month: { metric: { daily_avg, mtd } }, or null with no recorded days. */
export function finalizeMonth(history, y, m) {
  const records = getMonthRecords(history, y, m)
  if (!records.length) return null
  const perMetric = {}
  for (const rec of records) for (const [k, v] of Object.entries(rec.values)) (perMetric[k] ??= []).push(v)
  const out = {}
  for (const [k, vals] of Object.entries(perMetric)) {
    if (CONSTANT_KEYS.has(k)) out[k] = { daily_avg: vals.at(-1), mtd: vals.at(-1) }
    else if (AVERAGE_KEYS.has(k)) out[k] = { daily_avg: mean(vals), mtd: mean(vals) }
    else out[k] = { daily_avg: mean(vals), mtd: vals.reduce((a, b) => a + b, 0) }
  }
  return out
}
