type ReadStatus = {
  title: string
  error: Error | null
  refreshing?: boolean
  retry: () => void
}

export function AnalyticsReadStatuses({ reads }: { reads: ReadStatus[] }) {
  return <div className="analytics-read-statuses">
    <div className="analytics-refresh-indicators">
      {reads.filter((read) => read.refreshing !== undefined).map(({ title, refreshing }) =>
        <span key={title} className={`analytics-refresh-indicator ${refreshing ? 'is-active' : ''}`}
          role={refreshing ? 'status' : undefined} aria-hidden={!refreshing}>
          Refreshing {title.toLowerCase()}
        </span>,
      )}
    </div>
    {reads.map(({ title, error, retry }) => error && <div key={title} className="status-message is-error" role="alert">
      <strong>{title} error</strong>
      <p>{error.message}</p>
      <button type="button" onClick={retry}>Retry {title.toLowerCase()}</button>
    </div>)}
  </div>
}
