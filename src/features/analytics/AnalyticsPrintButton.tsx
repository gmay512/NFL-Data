import { useEffect, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { AnalyticsReportContent } from './AnalyticsReportContent'

export function AnalyticsPrintButton({ content, title }: { content: string; title: string }) {
  const [printing, setPrinting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => () => cleanupRef.current?.(), [])

  const print = () => {
    if (document.body.hasAttribute('data-analytics-print')) {
      setError('Another report is already being printed. Close its print dialog before trying again.')
      return
    }
    setError(null)
    const previousTitle = document.title
    const media = window.matchMedia?.('print')
    const cleanup = () => {
      window.removeEventListener('afterprint', cleanup)
      media?.removeEventListener('change', onMediaChange)
      document.body.removeAttribute('data-analytics-print')
      document.title = previousTitle
      cleanupRef.current = null
      setPrinting(false)
    }
    const onMediaChange = (event: MediaQueryListEvent) => {
      if (!event.matches) cleanup()
    }
    cleanupRef.current = cleanup
    window.addEventListener('afterprint', cleanup)
    media?.addEventListener('change', onMediaChange)
    document.body.setAttribute('data-analytics-print', '')
    document.title = title
    flushSync(() => setPrinting(true))
    try {
      window.print()
    } catch (failure) {
      cleanup()
      setError(failure instanceof Error ? `Could not print analysis: ${failure.message}` : 'Could not open the print dialog.')
    }
  }

  return (
    <>
      <button className="analytics-print-button" type="button" disabled={printing} onClick={print}>Print analysis</button>
      {error && <p className="analytics-print-error" role="alert">{error}</p>}
      {printing && createPortal(
        <article className="analytics-print-root" aria-label={`Print preview: ${title}`}>
          <AnalyticsReportContent content={content} />
        </article>,
        document.body,
      )}
    </>
  )
}
