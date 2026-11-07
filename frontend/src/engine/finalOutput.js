// Writes the day's values into the "Final output" template: completed months
// roll into static 2-col pairs left of "Particulars"; the current month is the
// 3-col "As on" / "Daily Average" / "MTD (Proj)" block right of it.
import ExcelJS from 'exceljs'

const SHEET_NAME = 'Final output'

// row number -> key in `values`; the contract between the pipeline and the sheet layout.
export const ROW_MAP = {
  4: 'Bed Strength', 5: 'Beds Occupied', 6: 'Occupancy %',
  9: 'OP New Registration', 10: 'OP Encounters',
  11: 'IP Admission Total', 12: 'IP Admission General', 13: 'IP Admission TPA', 14: 'IP Admission ECHS',
  15: 'IP Admission P.Card.Fund', 16: 'IP Admission Corporates',
  18: 'Emergency Admission', 19: 'Planned Admission', 20: 'Admission from OP (walk-in)',
  22: 'IP Discharges Total', 23: 'IP Discharges General', 24: 'IP Discharges TPA', 25: 'IP Discharges ECHS',
  26: 'IP Discharges P.Card.Fund', 27: 'IP Discharges Corporates',
  29: 'Long Stay Patients',
  32: 'OP Billing', 33: 'IP Billing', 34: 'Total Billing',
  37: 'Billing Domestic', 38: 'Billing International', 39: 'Billing Total',
  44: 'Cash Domestic', 45: 'Cash International',
  48: 'Credit Domestic Total', 49: 'Credit Domestic ECHS', 50: 'Credit Domestic P.Card.Fund',
  51: 'Credit Domestic TPA', 52: 'Credit Domestic Corporates',
  54: 'Credit International Total', 55: 'Credit International TPA Aasantha',
  56: 'Credit International Corporates (International)',
  // grand Total Billing (= 44+45+48+54 = row 34), not the credit-only subtotal
  57: 'Total Billing',
  60: 'AEPL Billing',
  63: 'Hospital Revenue (Net of AEPL)',
}

// Written as a live formula on that column's own rows (row 57 - row 60), so staff see the derivation.
const DERIVED_FORMULA_ROWS = { 'Hospital Revenue (Net of AEPL)': [57, 60] }

export const UNAVAILABLE = '—' // month with no recorded days at all
const PERCENT_KEYS = new Set(['Occupancy %'])
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** Half-up whole numbers like Excel; percent keys and non-numbers untouched. */
export function whole(value, key) {
  if (PERCENT_KEYS.has(key) || typeof value !== 'number') return value
  return Math.floor(Math.abs(value) + 0.5) * (value >= 0 ? 1 : -1)
}

export function colLetter(n) {
  let s = ''
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

const headerText = (ws, c) => String(ws.getCell(1, c).value ?? '').trim()

// Inserted cells get the neighbouring column's look, font forced to Arial (house style).
function copyColumnStyle(ws, sourceCol, destCols) {
  for (let r = 1; r <= ws.rowCount; r++) {
    const ref = ws.getCell(r, sourceCol)
    const f = ref.font || {}
    for (const c of destCols) {
      const cell = ws.getCell(r, c)
      cell.font = { name: 'Arial', size: f.size, bold: f.bold, italic: f.italic, color: f.color && structuredClone(f.color) }
      if (ref.border) cell.border = structuredClone(ref.border)
      if (ref.fill) cell.fill = structuredClone(ref.fill)
      if (ref.alignment) cell.alignment = structuredClone(ref.alignment)
      if (ref.numFmt) cell.numFmt = ref.numFmt
    }
  }
}

/** finalizedMonths: [[y, m, finalizeMonth() result | null]]. Returns the shifted 'Particulars' column. */
function finalizePriorMonths(ws, finalizedMonths) {
  let part = 1
  while (part <= ws.columnCount && headerText(ws, part) !== 'Particulars') part++
  if (part > ws.columnCount) throw new Error("Template has no 'Particulars' column.")
  // only columns LEFT of Particulars are finalized months (the live block also says "Daily Average <Month>")
  const existing = new Set(Array.from({ length: part - 1 }, (_, i) => headerText(ws, i + 1)))
  // ponytail: headers carry month name only (matches the manual template), so dedupe breaks after 12 months of history -- add the year then.
  for (const [, m, finalized] of [...finalizedMonths].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const name = MONTHS[m - 1]
    if (existing.has(`Daily Average ${name}`)) continue
    ws.spliceColumns(part, 0, [], [])
    copyColumnStyle(ws, part + 2, [part, part + 1])
    ws.getCell(1, part).value = `Daily Average ${name}`
    ws.getCell(1, part + 1).value = `MTD ${name}`
    for (const [row, key] of Object.entries(ROW_MAP)) {
      if (finalized === null) {
        ws.getCell(+row, part).value = UNAVAILABLE
        ws.getCell(+row, part + 1).value = UNAVAILABLE
      } else if (finalized[key]) {
        ws.getCell(+row, part).value = whole(finalized[key].daily_avg, key)
        ws.getCell(+row, part + 1).value = whole(finalized[key].mtd, key)
      }
    }
    part += 2
  }
  return part
}

/** mtdColumns: computeMtdColumns() result, null = this month has no recorded days ("—" columns). */
export async function writeFinalOutput(templateBytes, values, date, mtdColumns, finalizedMonths) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(templateBytes)
  for (const sheet of [...wb.worksheets]) if (sheet.name !== SHEET_NAME) wb.removeWorksheet(sheet.id)
  const ws = wb.getWorksheet(SHEET_NAME)

  const part = finalizePriorMonths(ws, finalizedMonths)
  const [dateCol, avgCol, projCol] = [part + 1, part + 2, part + 3].map(colLetter)
  const name = MONTHS[date.m - 1]
  ws.getCell(1, part + 2).value = `Daily Average ${name}`
  ws.getCell(1, part + 3).value = `MTD ${name} (Proj)`
  ws.getCell(1, part + 1).value = `As on ${String(date.d).padStart(2, '0')} ${name.slice(0, 3)} ${date.y}`

  const gated = mtdColumns === null
  const hasMtd = mtdColumns && Object.keys(mtdColumns).length > 0
  for (const [row, key] of Object.entries(ROW_MAP)) {
    let cells
    if (DERIVED_FORMULA_ROWS[key]) {
      const [pos, neg] = DERIVED_FORMULA_ROWS[key]
      cells = Object.fromEntries([dateCol, avgCol, projCol].map((c) => [c, { formula: `${c}${pos}-${c}${neg}` }]))
      if (!hasMtd) cells[avgCol] = cells[projCol] = gated ? UNAVAILABLE : null
    } else {
      if (!(key in values)) continue
      cells = { [dateCol]: whole(values[key], key), [avgCol]: null, [projCol]: null }
      if (gated) cells[avgCol] = cells[projCol] = UNAVAILABLE
      else if (mtdColumns?.[key]) {
        cells[avgCol] = whole(mtdColumns[key].daily_avg, key)
        cells[projCol] = whole(mtdColumns[key].mtd_proj, key)
      }
    }
    for (const [c, v] of Object.entries(cells)) if (v !== null) ws.getCell(`${c}${row}`).value = v
  }
  wb.calcProperties.fullCalcOnLoad = true // formula cells carry no cached result
  return wb.xlsx.writeBuffer()
}
