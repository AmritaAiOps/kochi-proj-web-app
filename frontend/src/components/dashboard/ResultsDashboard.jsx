import { useEffect, useState } from 'react'
import OccupancyCard from './OccupancyCard'
import VolumesCard from './VolumesCard'
import BillingCard from './BillingCard'
import CollectionCard from './CollectionCard'
import { formatDateDisplay } from '../../format'

// Read-only sanity-check view -- every number here comes straight from the
// same `values` dict used to write the Final output Excel. No editing here;
// corrections happen only in the Category Review panel.
const GATE_TOOLTIP = 'Averaging starts once day 1 of the month is recorded'

function MonthlyAverageLine({ date }) {
  const [monthly, setMonthly] = useState(null)

  useEffect(() => {
    if (!date) return
    fetch(`/api/monthly-average?date=${date}`)
      .then((r) => r.json())
      .then(setMonthly)
      .catch(() => setMonthly(null))
  }, [date])

  if (!monthly?.success) return null
  const { monthAvailable, dailyAverage, mtdProjected } = monthly.data
  const num = (v) => v.toLocaleString('en-IN', { maximumFractionDigits: 0 })
  const dash = <span title={GATE_TOOLTIP}>—</span>
  return (
    <span className="dashboard__date-label">
      Total Billing — Daily Avg: {monthAvailable ? num(dailyAverage) : dash}
      {' · '}MTD (Proj): {monthAvailable ? num(mtdProjected) : dash}
    </span>
  )
}

function ResultsDashboard({ values, date }) {
  if (!values) return null

  return (
    <div className="dashboard">

      <div className="dashboard__header">
        <span className="dashboard__date-label">Reporting date</span>
        <span className="dashboard__date-value">{formatDateDisplay(date)}</span>
        <MonthlyAverageLine date={date} />
      </div>

      <div className="dashboard__grid">
        <OccupancyCard values={values} />
        <VolumesCard values={values} />
        <BillingCard values={values} />
        <CollectionCard values={values} />
      </div>
    </div>
  )
}

export default ResultsDashboard
