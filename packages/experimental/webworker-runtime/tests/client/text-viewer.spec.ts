// @vitest-environment jsdom

import { beforeAll, expect, it } from 'vitest'
import { showTextViewer } from '../../src/client/text-viewer.ts'

beforeAll(() => {
  // jsdom lacks the modal dialog methods.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.open = true }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.open = false }
})

function viewer(): HTMLDialogElement {
  return document.querySelector('dialog[data-preview-text-viewer]') as HTMLDialogElement
}

it('shows the file as plain text, replaces it on reuse, and closes from its button', () => {
  showTextViewer('/dsh/home/a.yml', '<b>first</b>')
  expect(viewer().open).toBe(true)
  expect(viewer().querySelector('h2')?.textContent).toBe('/dsh/home/a.yml')
  expect(viewer().querySelector('pre')?.innerHTML).toBe('&lt;b&gt;first&lt;/b&gt;')

  showTextViewer('/dsh/home/b.yml', 'second')
  expect(document.querySelectorAll('dialog[data-preview-text-viewer]')).toHaveLength(1)
  expect(viewer().querySelector('pre')?.textContent).toBe('second')

  viewer().querySelector('button')?.click()
  expect(viewer().open).toBe(false)
})

it('keeps keys pressed in the viewer from reaching document-level modal layers', () => {
  showTextViewer('/dsh/home/a.yml', 'text')
  let reached = false
  const listener = (): void => { reached = true }
  document.addEventListener('keydown', listener)
  viewer().querySelector('button')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  document.removeEventListener('keydown', listener)
  expect(reached).toBe(false)
})
