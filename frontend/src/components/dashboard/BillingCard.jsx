import StatTile from './StatTile'
import { formatInr } from '../../format'

function BillingCard({ values }) {
  return (
    <div className="dash-card">
      <h3 className="dash-card__title">Billing (INR)</h3>
      <div className="dash-card__headline">{formatInr(values['Billing Total'])}</div>

      <div className="dash-card__stat-row">
        <StatTile label="OP Billing" value={formatInr(values['OP Billing'])} />
        <StatTile label="IP Billing" value={formatInr(values['IP Billing'])} />
        <StatTile label="Total Billing" value={formatInr(values['Total Billing'])} />
      </div>

      <div className="dash-card__stat-row">
        <StatTile label="Domestic" value={formatInr(values['Billing Domestic'])} />
        <StatTile label="International" value={formatInr(values['Billing International'])} />
      </div>

      <div className="dash-card__subsection">
        <div className="dash-card__subheader">
          <span>Cash</span>
        </div>
        <div className="dash-card__stat-row">
          <StatTile label="Domestic" value={formatInr(values['Cash Domestic'])} />
          <StatTile label="International" value={formatInr(values['Cash International'])} />
        </div>
      </div>

      <div className="dash-card__subsection">
        <div className="dash-card__subheader">
          <span>Credit</span>
          <strong>{formatInr(values['Credit Total Billing'])}</strong>
        </div>
        <table className="bucket-table">
          <tbody>
            <tr>
              <td>ECHS/ESI /INHS/ISRO/CIAL (Domestic)</td>
              <td>{formatInr(values['Credit Domestic ECHS'])}</td>
            </tr>
            <tr>
              <td>P.Card.Fund (Domestic)</td>
              <td>{formatInr(values['Credit Domestic P.Card.Fund'])}</td>
            </tr>
            <tr>
              <td>TPA (Domestic)</td>
              <td>{formatInr(values['Credit Domestic TPA'])}</td>
            </tr>
            <tr>
              <td>Corporates (Domestic)</td>
              <td>{formatInr(values['Credit Domestic Corporates'])}</td>
            </tr>
            <tr>
              <td>Domestic Total</td>
              <td>{formatInr(values['Credit Domestic Total'])}</td>
            </tr>
            <tr>
              <td>TPA Aasandha (International)</td>
              <td>{formatInr(values['Credit International TPA Aasantha'])}</td>
            </tr>
            <tr>
              <td>Corporates (International)</td>
              <td>{formatInr(values['Credit International Corporates (International)'])}</td>
            </tr>
            <tr>
              <td>International Total</td>
              <td>{formatInr(values['Credit International Total'])}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default BillingCard
