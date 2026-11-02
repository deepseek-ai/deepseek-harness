// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { IconUsersOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { TeamCommandRow, type TeamCommandRowProps } from '../src/client/TeamCommandRow.tsx'
import { zh, en, ja, es, fr, de, ru, pt } from '../src/client/locales.ts'

afterEach(cleanup)

type Node = TeamCommandRowProps['node']
function command(args: string | null, outcome: Node['outcome']): Node {
  return { kind: 'command', seq: 1, time: 1, commandId: CommandId('team-command'), name: 'team', args, outcome }
}

describe.each([
  { id: 'zh', dictionary: zh }, { id: 'en', dictionary: en }, { id: 'ja', dictionary: ja }, { id: 'es', dictionary: es },
  { id: 'fr', dictionary: fr }, { id: 'de', dictionary: de }, { id: 'ru', dictionary: ru }, { id: 'pt', dictionary: pt },
])('Team command fallback in $id', ({ dictionary }) => {
  const t = makeTranslate(dictionary)

  it.each(['status', 'ON', '', null])('shows a localized pending status for unrecognized input %j', (args) => {
    const view = render(<TeamCommandRow node={command(args, null)} t={t} />)
    expect(view.getByText(dictionary['command.title'])).toBeTruthy()
    expect(view.getByText(dictionary['command.running'])).toBeTruthy()
    expect(view.container.querySelector('[data-team-command]')?.getAttribute('aria-busy')).toBe('true')
    expect(view.container.querySelector('[data-team-command]')?.getAttribute('data-state')).toBe('running')
    expect(view.queryByRole('button')).toBeNull()
  })

  it.each(['status', 'ON', '', null])('preserves successful output for unrecognized input %j', (args) => {
    const text = 'Agent Teams enabled.'
    const node = command(args, { kind: 'success', text })
    const original = JSON.stringify(node)
    const view = render(<TeamCommandRow node={node} t={t} />)
    expect(view.getByText(dictionary['command.title'])).toBeTruthy()
    expect(view.getByText(text)).toBeTruthy()
    expect(view.queryByRole('button')).toBeNull()
    expect(view.container.querySelector('[data-team-command]')?.getAttribute('data-state')).toBe('ok')
    expect(JSON.stringify(node)).toBe(original)
  })

  it.each([undefined, ''])('uses a localized completed fallback for empty output %j', (text) => {
    const outcome: Node['outcome'] = { kind: 'success', ...text === undefined ? {} : { text } }
    const view = render(<TeamCommandRow node={command(null, outcome)} t={t} />)
    expect(view.getByText(dictionary['command.title'])).toBeTruthy()
    expect(view.getByText(dictionary['command.done'])).toBeTruthy()
  })

  it.each(['on', 'off', 'status', null])('keeps the raw failure expandable for input %j', (args) => {
    const raw = '  Save failed\r\nThe original diagnostic remains available.\n'
    const node = command(args, { kind: 'error', text: raw })
    const original = JSON.stringify(node)
    const view = render(<TeamCommandRow node={node} t={t} />)
    expect(view.getByText(dictionary['command.title'])).toBeTruthy()
    expect(view.getByText(t('command.failedReason', { reason: 'Save failed' }))).toBeTruthy()
    expect(view.container.querySelector('[data-team-command]')?.getAttribute('data-state')).toBe('error')
    const toggle = view.getByRole('button', { expanded: false })
    fireEvent.keyDown(toggle, { key: 'Enter' })
    expect(view.container.querySelector('pre')?.textContent).toBe(raw)
    fireEvent.keyDown(toggle, { key: ' ' })
    expect(view.container.querySelector('pre')).toBeNull()
    expect(JSON.stringify(node)).toBe(original)
  })

  it.each([undefined, '', '\n   '])('uses a localized failure fallback for empty reason %j', (text) => {
    const outcome: Node['outcome'] = { kind: 'error', ...text === undefined ? {} : { text } }
    const view = render(<TeamCommandRow node={command('on', outcome)} t={t} />)
    expect(view.getByText(dictionary['command.failed'])).toBeTruthy()
  })
})

it('uses the shared agent glyph for a failed command', () => {
  const view = render(<TeamCommandRow node={command('on', { kind: 'error' })} t={makeTranslate(en)} />)
  const icon = render(<IconUsersOutlineRegular size={14} />)
  expect(view.container.querySelector('svg')?.outerHTML).toBe(icon.container.querySelector('svg')?.outerHTML)
})

it('keeps a long single-line failure expandable', () => {
  const raw = 'The original failure detail '.repeat(20)
  const view = render(<TeamCommandRow node={command('off', { kind: 'error', text: raw })} t={makeTranslate(en)} />)
  fireEvent.click(view.getByRole('button', { expanded: false }))
  expect(view.container.querySelector('pre')?.textContent).toBe(raw)
})

it.each(['success', 'error'] as const)('relocalizes the title without rewriting expanded %s output', (kind) => {
  const node = command('status', { kind, text: 'Recorded output\nAdditional recorded detail.' })
  const original = JSON.stringify(node)
  const view = render(<TeamCommandRow node={node} t={makeTranslate(en)} />)
  expect(view.getByText(en['command.title'])).toBeTruthy()
  fireEvent.click(view.getByRole('button', { expanded: false }))
  expect(view.container.querySelector('pre')?.textContent).toBe(node.outcome?.text)
  view.rerender(<TeamCommandRow node={node} t={makeTranslate(zh)} />)
  expect(view.getByText(zh['command.title'])).toBeTruthy()
  expect(view.container.querySelector('pre')?.textContent).toBe(node.outcome?.text)
  expect(JSON.stringify(node)).toBe(original)
})
