function UploadedFilesList({ files, disabled, onRemove }) {
  if (!files.length) return null

  return (
    <div className="uploaded-files">
      {files.map((file) => (
        <span className="file-chip" key={file.name}>
          {file.name}
          <button
            type="button"
            className="file-chip__remove"
            disabled={disabled}
            onClick={() => onRemove(file.name)}
            aria-label={`Remove ${file.name}`}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  )
}

export default UploadedFilesList
