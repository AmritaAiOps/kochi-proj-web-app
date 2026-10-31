// Must match backend/stages/reports.py REPORT_TYPES exactly.
export const REPORT_TYPES = [
  'OP New Registration',
  'OP Encounters',
  'IP Admission',
  'Admission Analysis',
  'IP Discharges',
  'Billing INR OP',
  'Billing INR IP',
  'AEPL Billing',
  'Bed Occupancy',
]

export const PROCESSING_STEPS = [
  'Cleaning data...',
  'Mapping categories...',
  'Calculating billing...',
  'Writing output...',
]

export function isExcelFile(filename) {
  return /\.(xlsx|xls)$/i.test(filename || '')
}

export function fileKey(file) {
  return `${file.name}::${file.size}::${file.lastModified}`
}
