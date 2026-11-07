// Reads uploaded workbooks into plain row arrays with the same cell semantics
// the old pandas/openpyxl reader had, so every stage sees identical values:
//   - rows start at A1 (leading blank rows/cols kept, so row indexes = Excel rows - 1)
//   - trailing blank rows dropped, every row padded to the widest row
//   - pandas' default NA strings ("", "NA", "None", "#N/A", ...) become null
//   - formula cells give their cached value, date cells a Date (UTC)
// A "frame" is { columns, rows }: rows are arrays aligned with columns.
import * as XLSX from 'xlsx'

const NA_STRINGS = new Set(['', '#N/A', '#N/A N/A', '#NA', '-1.#IND', '-1.#QNAN', '-NaN', '-nan', '1.#IND', '1.#QNAN',
  '<NA>', 'N/A', 'NA', 'NULL', 'NaN', 'None', 'n/a', 'nan', 'null'])
const ERRORS = { 0x00: '#NULL!', 0x07: '#DIV/0!', 0x0f: '#VALUE!', 0x17: '#REF!', 0x1d: '#NAME?', 0x24: '#NUM!', 0x2a: '#N/A' }

function cellValue(cell) {
  if (!cell) return null
  let v = cell.v
  if (cell.t === 'z' || v === undefined) return null
  if (cell.t === 'e') v = cell.w ?? ERRORS[v] ?? null
  if (typeof v === 'string' && NA_STRINGS.has(v)) return null
  return v
}

function sheetRows(ws) {
  const rows = Array.from(ws['!data'] || [], (row) => {
    const out = []
    for (let c = 0; c < (row ? row.length : 0); c++) out.push(cellValue(row[c]))
    while (out.length && out[out.length - 1] === null) out.pop()
    return out
  })
  while (rows.length && rows[rows.length - 1].length === 0) rows.pop()
  const width = Math.max(0, ...rows.map((r) => r.length))
  for (const r of rows) while (r.length < width) r.push(null)
  return rows
}

export function readWorkbook(bytes) {
  const b = new Uint8Array(bytes)
  const isZip = b[0] === 0x50 && b[1] === 0x4b
  const isOle = b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0
  // SheetJS would happily parse a CSV/text file as a sheet; pandas refused anything that isn't a workbook.
  if (!isZip && !isOle) throw new Error('Excel file format cannot be determined (not an .xlsx/.xls workbook).')
  const wb = XLSX.read(b, { type: 'array', dense: true, cellDates: true, UTC: true })
  const cache = {}
  return {
    sheetNames: wb.SheetNames,
    rows(name) {
      if (!wb.Sheets[name]) throw new Error(`Worksheet named '${name}' not found`)
      return (cache[name] ??= sheetRows(wb.Sheets[name]))
    },
  }
}

// pd.to_numeric(errors="coerce") for one value: NaN when not numeric.
export function toNum(v) {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string') {
    const s = v.trim()
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return Number(s)
    const lower = s.toLowerCase()
    if (lower === 'inf' || lower === '+inf' || lower === 'infinity') return Infinity
    if (lower === '-inf' || lower === '-infinity') return -Infinity
  }
  return NaN
}

// str(value) as Python/pandas would show it for the comparisons the stages do.
export const pyStr = (v) => (v === null || v === undefined ? 'nan' : String(v))

// Python int(): truncates floats, parses integer strings, refuses everything else.
export function pyInt(v) {
  if (typeof v === 'number') {
    if (Number.isNaN(v)) throw new Error('cannot convert float NaN to integer')
    if (!Number.isFinite(v)) throw new Error('cannot convert float infinity to integer')
    return Math.trunc(v)
  }
  if (v === null || v === undefined) throw new Error('cannot convert float NaN to integer')
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string' && /^\s*[+-]?\d+(_\d+)*\s*$/.test(v)) return parseInt(v.replace(/_/g, ''), 10)
  throw new Error(`invalid literal for int() with base 10: '${v}'`)
}

export const sumNum = (values) => values.reduce((total, v) => (Number.isNaN(v) ? total : total + v), 0)

// header=None: columns are positions, every row is data.
export const rawFrame = (rows) => ({ columns: (rows[0] || []).map((_, i) => i), rows })

// header=h: row h becomes the (deduplicated) column names. Like pandas, a
// column whose values are all numbers or numeric strings is converted to numbers.
export function headerFrame(rows, h) {
  const seen = {}
  const columns = (rows[h] || []).map((v, i) => {
    let name = v === null ? `Unnamed: ${i}` : v instanceof Date ? v.toISOString().replace('T', ' ').slice(0, 19) : String(v)
    if (seen[name] !== undefined) {
      seen[name] += 1
      name = `${name}.${seen[name]}`
    }
    seen[name] ??= 0
    return name
  })
  const body = rows.slice(h + 1).map((r) => r.slice())
  columns.forEach((_, c) => {
    const vals = body.map((r) => r[c]).filter((v) => v !== null)
    const numeric = vals.every((v) => typeof v === 'number' || (typeof v === 'string' && !Number.isNaN(toNum(v))))
    if (numeric && vals.some((v) => typeof v === 'string')) for (const r of body) if (r[c] !== null) r[c] = toNum(r[c])
  })
  return { columns, rows: body }
}

export const column = (df, name) => {
  const idx = df.columns.indexOf(name)
  return df.rows.map((r) => r[idx])
}

export const filterRows = (df, keep) => ({ columns: df.columns, rows: df.rows.filter(keep) })
