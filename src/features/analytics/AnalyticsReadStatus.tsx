export function AnalyticsReadStatus({ title, error, refreshing, retry }: {
  title: string
  error: Error | null
  refreshing?: boolean
  retry: () => void
}) {
  if (!error && !refreshing) return null
  return <div className={`status-message ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'}>
    <strong>{error ? `${title} error` : `Refreshing ${title.toLowerCase()}`}</strong>
    {error && <><p>{error.message}</p><button type="button" onClick={retry}>Retry {title.toLowerCase()}</button></>}
  </div>
}
