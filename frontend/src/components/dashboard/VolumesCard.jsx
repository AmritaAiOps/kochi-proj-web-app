import StatTile from './StatTile'
import BucketTable from './BucketTable'
import { formatCount } from '../../format'

function VolumesCard({ values }) {
  return (
    <div className="dash-card">
      <h3 className="dash-card__title">Volumes</h3>

      <div className="dash-card__stat-row">
        <StatTile label="OP New Registration" value={formatCount(values['OP New Registration'])} />
        <StatTile label="OP Encounters" value={formatCount(values['OP Encounters'])} />
      </div>

      <div className="dash-card__subsection">
        <div className="dash-card__subheader">
          <span>IP Admission</span>
          <strong>{formatCount(values['IP Admission Total'])}</strong>
        </div>
        <BucketTable values={values} prefix="IP Admission" />
      </div>

      <div className="dash-card__subsection">
        <div className="dash-card__subheader">
          <span>IP Discharges</span>
          <strong>{formatCount(values['IP Discharges Total'])}</strong>
        </div>
        <BucketTable values={values} prefix="IP Discharges" />
      </div>

      <div className="dash-card__stat-row dash-card__stat-row--triple">
        <StatTile label="Emergency Admission" value={formatCount(values['Emergency Admission'])} />
        <StatTile label="Planned Admission" value={formatCount(values['Planned Admission'])} />
        <StatTile label="OP Walk-in Admission" value={formatCount(values['Admission from OP (walk-in)'])} />
      </div>

      <div className="dash-card__subsection">
        <div className="dash-card__subheader">
          <span>Long Stay Patients</span>
          <strong>{formatCount(values['Long Stay Patients Total'])}</strong>
        </div>
        <BucketTable values={values} prefix="Long Stay Patients" />
      </div>
    </div>
  )
}

export default VolumesCard
