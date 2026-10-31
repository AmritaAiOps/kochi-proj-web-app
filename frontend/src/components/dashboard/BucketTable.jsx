import { formatCount } from '../../format'

const BUCKET_LABELS = ['General', 'TPA', 'ECHS', 'P.Card.Fund', 'Corporates']

// Reads `${prefix} ${bucket}` keys directly out of the same flat `values`
// dict used to write the Final output Excel -- no separate computation.
function BucketTable({ values, prefix }) {
  return (
    <table className="bucket-table">
      <tbody>
        {BUCKET_LABELS.map((label) => (
          <tr key={label}>
            <td>{label}</td>
            <td>{formatCount(values[`${prefix} ${label}`])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export default BucketTable
