import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { AnalyticsReportContent } from '../src/features/analytics/AnalyticsReportContent'
import { formattedReportMarkdown } from './analytics-report-fixtures'
import { buildAnalyticsSnapshot } from '../server/analytics-core'
import { renderAnalyticsReport } from '../server/analytics-report'

(globalThis as typeof globalThis & { React: typeof React }).React = React

function withReport(content: string, check: (report: HTMLElement) => void) {
  const dom = new JSDOM(renderToStaticMarkup(createElement(AnalyticsReportContent, { content })))
  try {
    const report = dom.window.document.querySelector<HTMLElement>('.analytics-report-content')
    assert(report)
    check(report)
  } finally {
    dom.window.close()
  }
}

describe('formatted Analytics report content', () => {
  it('renders headings, inline emphasis, lists, and accessible scrollable GFM tables', () => {
    withReport(formattedReportMarkdown, (report) => {
      assert.equal(report.querySelector('h3')?.textContent, 'Validated factual report')
      assert.equal(report.querySelector('h4')?.textContent, 'Team trends')
      assert.equal(report.querySelector('li strong')?.textContent, 'Dallas:')
      assert.equal(report.querySelectorAll('ul li').length, 3)
      assert.equal(report.querySelectorAll('thead th').length, 2)
      assert.equal(report.querySelectorAll('tbody tr').length, 2)
      const wrapper = report.querySelector('.analytics-report-table')
      assert.equal(wrapper?.getAttribute('role'), 'region')
      assert.equal(wrapper?.getAttribute('aria-label'), 'Report table')
      assert.equal(wrapper?.getAttribute('tabindex'), '0')
      assert.doesNotMatch(report.textContent ?? '', /##|\*\*|\| ---/)
    })
  })

  it('keeps saved plain text readable without modifying its content', () => {
    const content = 'Validated factual report\n\nFirst observation.\nSecond observation.\n\nSource scope and limitations'
    withReport(content, (report) => {
      assert.equal(report.querySelectorAll('p').length, 3)
      assert.equal(report.querySelectorAll('h3, h4').length, 0)
      assert.equal(report.querySelectorAll('p')[1].textContent, 'First observation.\nSecond observation.')
    })
    assert.equal(content, 'Validated factual report\n\nFirst observation.\nSecond observation.\n\nSource scope and limitations')
  })

  it('supports existing Markdown links, blockquotes, code, and ordered lists', () => {
    withReport('> Stored note.\n\n1. First item\n2. Second item\n\n`teamId 29`\n\n```text\nsource IDs\n```\n\n[Source](https://example.com)', (report) => {
      assert.equal(report.querySelector('blockquote')?.textContent?.trim(), 'Stored note.')
      assert.equal(report.querySelectorAll('ol li').length, 2)
      assert.equal(report.querySelector('p code')?.textContent, 'teamId 29')
      assert.equal(report.querySelector('pre code')?.textContent, 'source IDs\n')
      assert.equal(report.querySelector('a')?.getAttribute('href'), 'https://example.com')
    })
  })

  it('does not render raw HTML, unsafe links, or remote images', () => {
    withReport([
      '<script>alert(1)</script>',
      '<img src="https://example.com/pixel" onerror="alert(1)">',
      '[Unsafe](javascript:alert%281%29)',
      '[Data](data:text/html,unsafe)',
      '![Stored diagram](https://example.com/diagram.png)',
      '<iframe src="https://example.com"></iframe>',
    ].join('\n\n'), (report) => {
      assert.equal(report.querySelectorAll('script, img, iframe, a').length, 0)
      assert.match(report.textContent ?? '', /Unsafe/)
      assert.match(report.textContent ?? '', /Data/)
      assert.match(report.textContent ?? '', /Stored diagram/)
    })
  })

  it('renders application-generated source names literally rather than interpreting their markup', () => {
    const name = '**Dallas** | [fake](https://example.com)\n## invented &copy; <b>bold</b> \\text'
    const snapshot = buildAnalyticsSnapshot('matchup_preview', { season: 2026, gameId: 1 }, {
      games: [], teamStats: [], standings: [], injuries: [], playerStats: [], players: [],
      targetMatchup: {
        gameId: 1, season: 2026, stage: 'Regular Season', week: 'Week 4',
        status: { short: 'NS', long: 'Not Started' },
        kickoff: { date: '2026-10-04', timestamp: 1791122400 },
        awayTeam: { id: 29, name }, homeTeam: { id: 26, name: 'Houston' },
        venue: { name: null, city: null }, currentConsensusOdds: { homeSpread: -3, total: 48 },
      },
    })
    const before = JSON.stringify(snapshot)
    const markdown = renderAnalyticsReport(JSON.stringify({
      observations: [{ kind: 'fact', factId: 'matchup.identity' }],
    }), snapshot, 'stop')
    withReport(markdown, (report) => {
      assert.match(report.textContent ?? '', /\*\*Dallas\*\* \| \[fake\]\(https:\/\/example.com\) ## invented &copy; <b>bold<\/b> \\text/)
      assert.equal(report.querySelectorAll('b, script, table').length, 0)
      assert.equal(report.querySelector('a')?.textContent, 'https://example.com')
      assert.equal(report.querySelector('a')?.getAttribute('href'), 'https://example.com')
      assert.equal(report.querySelectorAll('h4').length, 2)
      assert.equal(report.querySelector('li strong'), null)
      assert.doesNotMatch(report.textContent ?? '', /teamId|gameIds|Evidence:|Game 1/)
    })
    assert.equal(JSON.stringify(snapshot), before)
  })
})
