import { useState } from 'react'

const EXCLUDE_VALUE = '__EXCLUDE__'

const BUCKET_OPTIONS = [
  { value: 'General', label: 'General' },
  { value: 'TPA', label: 'TPA' },
  { value: 'ECHS', label: 'ECHS' },
  { value: 'P CARD FUND', label: 'P.Card.Fund' },
  { value: 'CPR', label: 'Corporates' },
]

function entryKey(entry) {
  return `${entry.raw_value}::${entry.source_file}`
}

function bucketLabel(value) {
  if (value === EXCLUDE_VALUE) return 'Excluded'
  const match = BUCKET_OPTIONS.find((b) => b.value === value)
  return match ? match.label : value
}

function BucketSelect({ value, onChange, disabled, allowPlaceholder }) {
  return (
    <select className="category-review__select" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {allowPlaceholder && (
        <option value="" disabled>
          Choose bucket...
        </option>
      )}
      {BUCKET_OPTIONS.map((b) => (
        <option key={b.value} value={b.value}>
          {b.label}
        </option>
      ))}
      <option value="" disabled>
        ──────────
      </option>
      <option value={EXCLUDE_VALUE}>Leave unmatched / exclude</option>
    </select>
  )
}

function CategoryReviewPanel({ categoryReview, onAccept }) {
  // entryKey -> current dropdown value (persists selection across re-renders/applies)
  const [selections, setSelections] = useState({})
  // entryKey -> { entry, chosenValue } for rows applied this session (collapsed section)
  const [resolved, setResolved] = useState({})
  // entries the user chose to re-open from "Resolved this session" -- kept
  // locally since the backend no longer returns them once overridden
  const [reopened, setReopened] = useState({})
  const [pending, setPending] = useState(() => new Set())
  const [resolvedSectionOpen, setResolvedSectionOpen] = useState(false)
  // checkbox-based multi-select, independent of the per-row dropdown/Apply flow
  const [checked, setChecked] = useState(() => new Set())

  if (!categoryReview) return null

  const resolvedKeys = new Set(Object.keys(resolved))
  const possible = [
    ...Object.values(reopened).filter((r) => r.section === 'possible').map((r) => r.entry),
    ...(categoryReview.possible_matches || []),
  ].filter((entry) => !resolvedKeys.has(entryKey(entry)))

  const unmatched = [
    ...Object.values(reopened).filter((r) => r.section === 'unmatched').map((r) => r.entry),
    ...(categoryReview.unmatched || []),
  ].filter((entry) => !resolvedKeys.has(entryKey(entry)))

  const resolvedList = Object.values(resolved)
  const isBusy = pending.size > 0

  if (possible.length === 0 && unmatched.length === 0 && resolvedList.length === 0) return null

  function getSelection(entry, defaultValue) {
    const key = entryKey(entry)
    return key in selections ? selections[key] : defaultValue
  }

  function setSelection(entry, value) {
    setSelections((prev) => ({ ...prev, [entryKey(entry)]: value }))
  }

  function toggleChecked(key) {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleCheckAll(entries) {
    const keys = entries.map(entryKey)
    const allChecked = keys.length > 0 && keys.every((k) => checked.has(k))
    setChecked((prev) => {
      const next = new Set(prev)
      if (allChecked) keys.forEach((k) => next.delete(k))
      else keys.forEach((k) => next.add(k))
      return next
    })
  }

  function clearChecked(keys) {
    setChecked((prev) => {
      const next = new Set(prev)
      keys.forEach((k) => next.delete(k))
      return next
    })
  }

  async function applyOne(entry, section) {
    const key = entryKey(entry)
    const value = getSelection(entry, section === 'possible' ? entry.suggested_bucket : '')
    if (!value) return // placeholder still selected -- do nothing, no default guess

    setPending((prev) => new Set(prev).add(key))
    const chosen_bucket = value === EXCLUDE_VALUE ? null : value
    await onAccept([{ raw_value: entry.raw_value, chosen_bucket }])

    setResolved((prev) => ({ ...prev, [key]: { entry, chosenValue: value, section } }))
    setReopened((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
    clearChecked([key])
    setPending((prev) => {
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }

  async function applyBatch(entries, section) {
    const ready = entries
      .map((entry) => ({ entry, value: getSelection(entry, section === 'possible' ? entry.suggested_bucket : '') }))
      .filter(({ value }) => !!value)
    if (ready.length === 0) return

    const keys = ready.map(({ entry }) => entryKey(entry))
    setPending(new Set(keys))

    const resolutions = ready.map(({ entry, value }) => ({
      raw_value: entry.raw_value,
      chosen_bucket: value === EXCLUDE_VALUE ? null : value,
    }))
    await onAccept(resolutions)

    setResolved((prev) => {
      const next = { ...prev }
      ready.forEach(({ entry, value }) => {
        next[entryKey(entry)] = { entry, chosenValue: value, section }
      })
      return next
    })
    setReopened((prev) => {
      const next = { ...prev }
      keys.forEach((k) => delete next[k])
      return next
    })
    clearChecked(keys)
    setPending(new Set())
  }

  function applyAll(entries, section) {
    return applyBatch(entries, section)
  }

  function applySelected(entries, section) {
    const selectedEntries = entries.filter((entry) => checked.has(entryKey(entry)))
    return applyBatch(selectedEntries, section)
  }

  function undo(key) {
    const record = resolved[key]
    if (!record) return
    setReopened((prev) => ({ ...prev, [key]: { entry: record.entry, section: record.section } }))
    setSelections((prev) => ({ ...prev, [key]: record.chosenValue }))
    setResolved((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  return (
    <div className="category-review" id="category-review">
      <div className="category-review__header">
        <h2 className="category-review__title">Category Review</h2>
        <span className="category-review__counts">
          {unmatched.length} unresolved, {possible.length} need review
        </span>
      </div>
      <p className="category-review__subtitle">
        These Category values from the uploaded files didn't match the Category Codes list. Applied fixes are
        remembered for future runs too — but they never change the master Category Codes sheet itself.
      </p>

      {possible.length > 0 && (
        <div className="category-review__section">
          <div className="category-review__section-header">
            <h3 className="category-review__section-title">Possible matches — needs your confirmation</h3>
            <div className="category-review__bulk-actions">
              <button
                className="button button--tiny button--secondary"
                disabled={isBusy || possible.every((e) => !checked.has(entryKey(e)))}
                onClick={() => applySelected(possible, 'possible')}
              >
                Apply selected ({possible.filter((e) => checked.has(entryKey(e))).length})
              </button>
              <button
                className="button button--tiny button--primary"
                disabled={isBusy}
                onClick={() => applyAll(possible, 'possible')}
              >
                Apply all
              </button>
            </div>
          </div>
          <table className="category-review__table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    checked={possible.length > 0 && possible.every((e) => checked.has(entryKey(e)))}
                    disabled={isBusy}
                    onChange={() => toggleCheckAll(possible)}
                    aria-label="Select all possible matches"
                  />
                </th>
                <th>Raw value</th>
                <th>Suggested bucket</th>
                <th>Similarity</th>
                <th>Source</th>
                <th>Bucket</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {possible.map((entry) => {
                const key = entryKey(entry)
                const isPending = pending.has(key)
                return (
                  <tr key={key} className={isPending ? 'category-review__row--pending' : ''}>
                    <td>
                      <input
                        type="checkbox"
                        checked={checked.has(key)}
                        disabled={isBusy}
                        onChange={() => toggleChecked(key)}
                        aria-label={`Select ${entry.raw_value ?? '(blank)'}`}
                      />
                    </td>
                    <td>{entry.raw_value ?? '(blank)'}</td>
                    <td>{entry.suggested_bucket}</td>
                    <td>{entry.similarity}%</td>
                    <td>{entry.source_file}</td>
                    <td>
                      <BucketSelect
                        value={getSelection(entry, entry.suggested_bucket)}
                        onChange={(v) => setSelection(entry, v)}
                        disabled={isBusy}
                      />
                    </td>
                    <td className="category-review__actions">
                      {isPending ? (
                        <span className="category-review__pending">
                          <span className="spinner spinner--tiny" aria-hidden="true" />
                          Applying...
                        </span>
                      ) : (
                        <button
                          className="button button--tiny button--primary"
                          disabled={isBusy}
                          onClick={() => applyOne(entry, 'possible')}
                        >
                          Apply
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {unmatched.length > 0 && (
        <div className="category-review__section">
          <div className="category-review__section-header">
            <h3 className="category-review__section-title">Unmatched — no match found</h3>
            <div className="category-review__bulk-actions">
              <button
                className="button button--tiny button--secondary"
                disabled={isBusy || unmatched.every((e) => !checked.has(entryKey(e)))}
                onClick={() => applySelected(unmatched, 'unmatched')}
              >
                Apply selected ({unmatched.filter((e) => checked.has(entryKey(e))).length})
              </button>
              <button
                className="button button--tiny button--primary"
                disabled={isBusy}
                onClick={() => applyAll(unmatched, 'unmatched')}
              >
                Apply all
              </button>
            </div>
          </div>
          <table className="category-review__table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    checked={unmatched.length > 0 && unmatched.every((e) => checked.has(entryKey(e)))}
                    disabled={isBusy}
                    onChange={() => toggleCheckAll(unmatched)}
                    aria-label="Select all unmatched"
                  />
                </th>
                <th>Raw value</th>
                <th>Frequency</th>
                <th>Source</th>
                <th>Bucket</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {unmatched.map((entry) => {
                const key = entryKey(entry)
                const isPending = pending.has(key)
                const selection = getSelection(entry, '')
                return (
                  <tr key={key} className={isPending ? 'category-review__row--pending' : ''}>
                    <td>
                      <input
                        type="checkbox"
                        checked={checked.has(key)}
                        disabled={isBusy}
                        onChange={() => toggleChecked(key)}
                        aria-label={`Select ${entry.raw_value ?? '(blank)'}`}
                      />
                    </td>
                    <td>{entry.raw_value ?? '(blank)'}</td>
                    <td>{entry.frequency}</td>
                    <td>{entry.source_file}</td>
                    <td>
                      <BucketSelect
                        value={selection}
                        onChange={(v) => setSelection(entry, v)}
                        disabled={isBusy}
                        allowPlaceholder
                      />
                    </td>
                    <td className="category-review__actions">
                      {isPending ? (
                        <span className="category-review__pending">
                          <span className="spinner spinner--tiny" aria-hidden="true" />
                          Applying...
                        </span>
                      ) : (
                        <button
                          className="button button--tiny button--primary"
                          disabled={isBusy || !selection}
                          onClick={() => applyOne(entry, 'unmatched')}
                        >
                          Apply
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p className="category-review__note">
            Rows still shown here were excluded from category-based counts until you choose a bucket.
          </p>
        </div>
      )}

      {resolvedList.length > 0 && (
        <div className="category-review__section category-review__resolved">
          <button
            type="button"
            className="category-review__resolved-toggle"
            onClick={() => setResolvedSectionOpen((v) => !v)}
          >
            {resolvedSectionOpen ? '▾' : '▸'} Resolved this session ({resolvedList.length})
          </button>
          {resolvedSectionOpen && (
            <table className="category-review__table">
              <thead>
                <tr>
                  <th>Raw value</th>
                  <th>Resolved as</th>
                  <th>Source</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {resolvedList.map(({ entry, chosenValue }) => {
                  const key = entryKey(entry)
                  return (
                    <tr key={key}>
                      <td>{entry.raw_value ?? '(blank)'}</td>
                      <td>{bucketLabel(chosenValue)}</td>
                      <td>{entry.source_file}</td>
                      <td>
                        <button className="button button--tiny button--secondary" onClick={() => undo(key)}>
                          Undo
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}

export default CategoryReviewPanel
