import { REPORT_TYPES } from '../reports'

function candidateDisplayLabel(candidate) {
  return `${candidate.source_file} → ${candidate.sheet_name}`
}

function ReportChecklist({ candidates, assignments, autoMatches, disabled, onAssign }) {
  return (
    <div className="checklist">
      {REPORT_TYPES.map((reportType) => {
        const assignedId = assignments[reportType] || ''
        const autoMatch = autoMatches[reportType]
        const isAuto = autoMatch && assignedId === autoMatch.candidate_id
        const isAssigned = !!assignedId
        const status = !isAssigned ? 'missing' : isAuto ? 'auto' : 'manual'

        return (
          <div className={`checklist__row checklist__row--${status}`} key={reportType}>
            <div className="checklist__status" aria-hidden="true">
              {isAssigned ? '✓' : '✕'}
            </div>
            <div className="checklist__label">
              {reportType}
              {status === 'auto' && (
                <span className="checklist__tag checklist__tag--auto">
                  detected{autoMatch.confidence === 'medium' ? ' (by columns)' : ''}
                </span>
              )}
              {status === 'manual' && <span className="checklist__tag checklist__tag--manual">manually assigned</span>}
              {status === 'missing' && <span className="checklist__tag checklist__tag--missing">not found — assign below</span>}
            </div>
            <select
              className="checklist__select"
              value={assignedId}
              disabled={disabled}
              onChange={(e) => onAssign(reportType, e.target.value)}
            >
              <option value="">— select a sheet —</option>
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidateDisplayLabel(candidate)}
                </option>
              ))}
            </select>
          </div>
        )
      })}
    </div>
  )
}

export default ReportChecklist
