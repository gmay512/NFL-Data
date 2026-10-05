import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

const components: Components = {
  h1: ({ children }) => <h3>{children}</h3>,
  h2: ({ children }) => <h4>{children}</h4>,
  h3: ({ children }) => <h5>{children}</h5>,
  h4: ({ children }) => <h6>{children}</h6>,
  h5: ({ children }) => <h6>{children}</h6>,
  h6: ({ children }) => <h6>{children}</h6>,
  a: ({ href, children }) => href ? <a href={href}>{children}</a> : <span>{children}</span>,
  img: ({ alt }) => <span>{alt}</span>,
  table: ({ children }) => (
    <div className="analytics-report-table" role="region" aria-label="Report table" tabIndex={0}>
      <table>{children}</table>
    </div>
  ),
}

export function AnalyticsReportContent({ content }: { content: string }) {
  return (
    <div className="analytics-report-content">
      <Markdown remarkPlugins={[remarkGfm]} components={components} skipHtml>{content}</Markdown>
    </div>
  )
}
