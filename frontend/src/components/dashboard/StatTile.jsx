function StatTile({ label, value, large }) {
  return (
    <div className={`stat-tile ${large ? 'stat-tile--large' : ''}`}>
      <div className="stat-tile__value">{value}</div>
      <div className="stat-tile__label">{label}</div>
    </div>
  )
}

export default StatTile
