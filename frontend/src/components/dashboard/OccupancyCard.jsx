import StatTile from './StatTile'
import OccupancyBar from './OccupancyBar'
import { formatPercent, formatCount } from '../../format'

function OccupancyCard({ values }) {
  return (
    <div className="dash-card">
      <h3 className="dash-card__title">Occupancy</h3>
      <div className="dash-card__headline">{formatPercent(values['Occupancy %'])}</div>
      <OccupancyBar occupied={values['Beds Occupied']} capacity={values['Bed Strength']} />
      <div className="dash-card__stat-row">
        <StatTile label="Bed Strength" value={formatCount(values['Bed Strength'])} />
        <StatTile label="Beds Occupied" value={formatCount(values['Beds Occupied'])} />
      </div>
    </div>
  )
}

export default OccupancyCard
