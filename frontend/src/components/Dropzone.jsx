import { useRef, useState } from 'react'
import { isExcelFile } from '../reports'

function Dropzone({ disabled, onFilesAdded, onRejected }) {
  const inputRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)

  function handleFiles(fileList) {
    const files = Array.from(fileList || [])
    if (!files.length) return
    const valid = files.filter((f) => isExcelFile(f.name))
    const invalid = files.filter((f) => !isExcelFile(f.name))
    if (invalid.length) {
      onRejected(invalid.map((f) => f.name))
    }
    if (valid.length) {
      onFilesAdded(valid)
    }
  }

  return (
    <div
      className={`dropzone ${dragOver ? 'dropzone--dragover' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        if (!disabled) setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        if (disabled) return
        handleFiles(e.dataTransfer.files)
      }}
      onClick={() => !disabled && inputRef.current?.click()}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls"
        multiple
        hidden
        disabled={disabled}
        onChange={(e) => {
          handleFiles(e.target.files)
          e.target.value = ''
        }}
      />
      <div className="dropzone__icon" aria-hidden="true">
        ⬆
      </div>
      <div className="dropzone__text">
        <strong>Drag and drop your report files here</strong>
        <span>or click to browse — one combined workbook, several separate files, or a mix. .xlsx / .xls only.</span>
      </div>
    </div>
  )
}

export default Dropzone
