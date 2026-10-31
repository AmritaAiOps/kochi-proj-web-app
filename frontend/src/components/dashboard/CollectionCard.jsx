import StatTile from './StatTile'
import { formatInr } from '../../format'

function CollectionCard({ values }) {
  return (
    <div className="dash-card">
      <h3 className="dash-card__title">Revenue (INR)</h3>
      <div className="dash-card__headline">{formatInr(values['Hospital Revenue (Net of AEPL)'])}</div>
      <div className="dash-card__stat-row">
        <StatTile label="AEPL Billing" value={formatInr(values['AEPL Billing'])} />
        <StatTile label="Hospital Revenue (Net of AEPL)" value={formatInr(values['Hospital Revenue (Net of AEPL)'])} />
      </div>
    </div>
  )
}

export default CollectionCard
