import { useEffect, useRef, useState } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { AnalyticsReportContent } from './AnalyticsReportContent'

type PrintProps = { title: string; disabled?: boolean } & (
  | { content: string; prepareContent?: never }
  | { content?: never; prepareContent: (signal: AbortSignal) => Promise<string> }
)

export function AnalyticsPrintButton({ content, prepareContent, title, disabled = false }: PrintProps) {
  const [printContent, setPrintContent] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cleanupRef = useRef<(() => void) | null>(null)
  const preparationRef = useRef<AbortController | null>(null)

  useEffect(() => () => {
    preparationRef.current?.abort()
    preparationRef.current = null
    cleanupRef.current?.()
  }, [])
  useEffect(() => {
    if (disabled) preparationRef.current?.abort()
  }, [disabled])

  const print = async () => {
    if (preparationRef.current || cleanupRef.current || disabled) return
    if (document.body.hasAttribute('data-analytics-print')) {
      setError('Another report is already being printed. Close its print dialog before trying again.')
      return
    }
    setError(null)
    let report = content
    if (prepareContent) {
      const controller = new AbortController()
      preparationRef.current = controller
      setPreparing(true)
      try {
        report = await prepareContent(controller.signal)
        if (controller.signal.aborted) return
      } catch (failure) {
        if (!controller.signal.aborted) {
          setError(failure instanceof Error ? `Could not prepare analysis for printing: ${failure.message}` : 'Could not load the original analysis for printing.')
        }
        return
      } finally {
        if (preparationRef.current === controller) {
          preparationRef.current = null
          setPreparing(false)
        }
      }
    }
    if (!report?.trim()) {
      setError('The original analysis has no report content to print.')
      return
    }
    if (document.body.hasAttribute('data-analytics-print')) {
      setError('Another report is already being printed. Close its print dialog before trying again.')
      return
    }
    const previousTitle = document.title
    const media = window.matchMedia?.('print')
    const cleanup = () => {
      window.removeEventListener('afterprint', cleanup)
      media?.removeEventListener('change', onMediaChange)
      document.body.removeAttribute('data-analytics-print')
      document.title = previousTitle
      cleanupRef.current = null
      setPrintContent(null)
    }
    const onMediaChange = (event: MediaQueryListEvent) => {
      if (!event.matches) cleanup()
    }
    cleanupRef.current = cleanup
    window.addEventListener('afterprint', cleanup)
    media?.addEventListener('change', onMediaChange)
    document.body.setAttribute('data-analytics-print', '')
    document.title = title
    flushSync(() => setPrintContent(report))
    try {
      window.print()
    } catch (failure) {
      cleanup()
      setError(failure instanceof Error ? `Could not print analysis: ${failure.message}` : 'Could not open the print dialog.')
    }
  }

  return (
    <>
      <button className="analytics-print-button" type="button" disabled={disabled || preparing || printContent !== null} onClick={() => void print()}>{preparing ? 'Preparing analysis…' : 'Print analysis'}</button>
      {error && <p className="analytics-print-error" role="alert">{error}</p>}
      {printContent !== null && createPortal(
        <article className="analytics-print-root" aria-label={`Print preview: ${title}`}>
          <AnalyticsReportContent content={printContent} />
        </article>,
        document.body,
      )}
    </>
  )
}
