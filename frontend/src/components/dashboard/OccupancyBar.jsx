import { formatCount } from '../../format'

// Occupancy can exceed 100% of bed strength in practice, so the fill caps
// visually at full width but flags "over capacity" rather than clipping
// silently or breaking the layout.
function OccupancyBar({ occupied, capacity }) {
  const pct = capacity > 0 ? occupied / capacity : 0
  const overCapacity = pct > 1
  const widthPct = Math.min(pct, 1) * 100

  return (
    <div className="occupancy-bar">
      <div className="occupancy-bar__track">
        <div
          className={`occupancy-bar__fill ${overCapacity ? 'occupancy-bar__fill--over' : ''}`}
          style={{ width: `${widthPct}%` }}
        />
      </div>
      <div className="occupancy-bar__caption">
        {formatCount(occupied)} / {formatCount(capacity)} beds
        {overCapacity && <span className="occupancy-bar__over-tag">over capacity</span>}
      </div>
    </div>
  )
}

export default OccupancyBar
