import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import * as React from 'react'
import { JSDOM } from 'jsdom'
import { createRoot, type Root } from 'react-dom/client'
import { AnalyticsPrintButton } from '../src/features/analytics/AnalyticsPrintButton'

let dom: JSDOM | undefined
let root: Root | undefined
const content = '# Matchup Summary\n\n## 1. Totals Performance\n\n| Team | Average |\n| --- | ---: |\n| Dallas | 24 |\n\n**Summary:** Historical averages only.\n\n**Unverified statement:** Availability unknown.\n\n## Overall Summary of Observations\n\nDescriptive, not predictive.'

afterEach(async () => {
  await React.act(() => root?.unmount())
  root = undefined
  dom?.window.close()
  dom = undefined
})

async function setup(print: () => void) {
  dom = new JSDOM('<!doctype html><title>NFL dashboard</title><div id="root"></div><aside>Unrelated page content</aside>')
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    React: { configurable: true, value: React },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  })
  dom.window.print = print
  const container = document.getElementById('root')!
  root = createRoot(container)
  await React.act(() => root?.render(React.createElement(AnalyticsPrintButton, { content, title: 'Dallas at Houston' })))
  return container.querySelector<HTMLButtonElement>('button')!
}

describe('formatted analysis printing', () => {
  it('renders only the selected Markdown report before opening print and cleans up after the dialog closes', async () => {
    let calls = 0
    const button = await setup(() => {
      calls++
      const surface = document.querySelector('.analytics-print-root')
      assert(surface)
      assert.equal(surface.parentElement, document.body)
      assert.equal(document.title, 'Dallas at Houston')
      assert(document.body.hasAttribute('data-analytics-print'))
      assert.equal(surface.querySelector('h3')?.textContent, 'Matchup Summary')
      assert.equal(surface.querySelector('h4')?.textContent, '1. Totals Performance')
      assert.equal(surface.querySelectorAll('tbody tr').length, 1)
      assert.equal(surface.querySelector('tbody td:nth-child(2)')?.textContent, '24')
      assert.match(surface.textContent ?? '', /Unverified statement: Availability unknown/)
      assert.match(surface.textContent ?? '', /Overall Summary of Observations/)
      assert.doesNotMatch(surface.textContent ?? '', /Unrelated|Print analysis|##|\*\*|\| ---/)
      assert.equal(surface.querySelectorAll('button, textarea').length, 0)
    })
    await React.act(() => button.click())
    assert.equal(calls, 1)
    assert(button.disabled)
    await React.act(() => window.dispatchEvent(new window.Event('afterprint')))
    assert.equal(document.querySelector('.analytics-print-root'), null)
    assert(!document.body.hasAttribute('data-analytics-print'))
    assert.equal(document.title, 'NFL dashboard')
    assert(!button.disabled)
  })

  it('restores state if printing fails and shows an explicit error', async () => {
    const button = await setup(() => { throw new Error('Printer unavailable') })
    await React.act(() => button.click())
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /Could not print analysis: Printer unavailable/)
    assert.equal(document.querySelector('.analytics-print-root'), null)
    assert(!document.body.hasAttribute('data-analytics-print'))
    assert.equal(document.title, 'NFL dashboard')
    assert(!button.disabled)
  })

  it('cleans up on unmount and can print again after cancelling', async () => {
    const button = await setup(() => {})
    await React.act(() => button.click())
    await React.act(() => window.dispatchEvent(new window.Event('afterprint')))
    await React.act(() => button.click())
    assert(document.querySelector('.analytics-print-root'))
    await React.act(() => root?.unmount())
    root = undefined
    assert.equal(document.querySelector('.analytics-print-root'), null)
    assert(!document.body.hasAttribute('data-analytics-print'))
    assert.equal(document.title, 'NFL dashboard')
  })
})
