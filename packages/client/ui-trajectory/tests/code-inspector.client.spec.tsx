// @vitest-environment jsdom
/** PTC source, output, and independent wrapping through the trajectory inspector. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { TrajectoryTable } from '../src/client/TrajectoryTable.tsx'
import type { TrajectoryCellProps } from '../src/client/trajectory-record.ts'
import { t } from './locale.client.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const SOURCE = 'const value = await tools.bash({ command: "pwd" })\nreturn value\n'
const ARGS = JSON.stringify({ code: SOURCE, description: 'Read the working directory' })
const CELL: TrajectoryCellProps = {
  index: 1, kind: 'tool', toolName: 'run_code', text: `run_code · ${ARGS}`, callId: 'code-1',
  inputDetail: ARGS, outputDetail: 'printed line\n42', result: 'printed line', timeSeconds: 0.5,
}

function Harness({ cell = CELL, getDefault = () => false, setDefault = () => {} }: {
  cell?: TrajectoryCellProps
  getDefault?: () => boolean
  setDefault?: (value: boolean) => void
}) {
  return <TrajectoryTable
    turns={[{ turn: 1, groups: [{ title: 'Step 1', cells: [cell] }] }]}
    renderImages={() => null} t={t}
    stringWrapping={{ label: 'Wrap lines', getDefault, setDefault }}
    collapsedTurns={new Set()} onToggleTurn={() => {}}
    collapsedAssistants={new Set()} onToggleAssistant={() => {}}
  />
}

describe('PTC trajectory inspector', () => {
  it('shows the description, numbered source, original arguments, and verbatim output', () => {
    const view = render(<Harness />)
    const ui = within(view.container)
    fireEvent.click(ui.getByRole('row', { name: /run_code Read the working directory/ }))
    expect(ui.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Summary', 'Code', 'Result', 'Schema', 'Timing'])
    expect(ui.getByRole('tabpanel').textContent).toContain('Read the working directory')
    expect(view.container.querySelector('[data-line-numbers] pre')?.textContent).toBe(SOURCE.trimEnd())
    expect(ui.getByRole('tabpanel').textContent).toContain('printed line\n42')
    fireEvent.click(ui.getByRole('button', { name: 'Code' }))
    expect(ui.getByRole('tab', { name: 'Code' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(ui.getByRole('button', { name: 'Original JSON' }))
    expect(ui.getByRole('tree', { name: 'parameters JSON' }).textContent).toContain('description:')
    fireEvent.click(ui.getByRole('button', { name: 'Original JSON' }))
    expect(view.container.querySelector('[data-line-numbers] pre')?.textContent).toBe(SOURCE.trimEnd())
  })

  it('copies exact source, raw JSON, and output with feedback', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const view = render(<Harness />)
    const ui = within(view.container)
    fireEvent.click(ui.getByRole('row', { name: /run_code Read/ }))
    fireEvent.click(ui.getByRole('button', { name: 'Copy code' }))
    await waitFor(() => { expect(writeText).toHaveBeenLastCalledWith(SOURCE) })
    await waitFor(() => { expect(ui.getByRole('button', { name: 'Copied' })).toBeTruthy() })
    fireEvent.click(ui.getByRole('button', { name: 'Copy output' }))
    await waitFor(() => { expect(writeText).toHaveBeenLastCalledWith('printed line\n42') })
    fireEvent.click(ui.getByRole('tab', { name: 'Code' }))
    fireEvent.click(ui.getByRole('button', { name: 'Original JSON' }))
    fireEvent.click(ui.getByRole('button', { name: 'Copy JSON' }))
    await waitFor(() => { expect(writeText).toHaveBeenLastCalledWith(ARGS) })
  })

  it('samples the last wrapping choice on open without changing another open inspector', () => {
    let preference = false
    const props = { getDefault: () => preference, setDefault: (value: boolean) => { preference = value } }
    const first = render(<Harness {...props} />)
    const second = render(<Harness {...props} />)
    const a = within(first.container)
    const b = within(second.container)
    fireEvent.click(a.getByRole('row', { name: /run_code Read/ }))
    fireEvent.click(b.getByRole('row', { name: /run_code Read/ }))
    fireEvent.click(a.getByRole('button', { name: 'Wrap lines' }))
    expect(preference).toBe(true)
    expect(a.getByRole('button', { name: 'Wrap lines' }).getAttribute('aria-pressed')).toBe('true')
    expect(b.getByRole('button', { name: 'Wrap lines' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(b.getByRole('tab', { name: 'Code' }))
    expect(b.getByRole('button', { name: 'Wrap lines' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(b.getByRole('button', { name: 'Wrap lines' }))
    expect(preference).toBe(false)
    expect(a.getByRole('button', { name: 'Wrap lines' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(a.getByRole('button', { name: 'Close details' }))
    fireEvent.click(a.getByRole('row', { name: /run_code Read/ }))
    expect(a.getByRole('button', { name: 'Wrap lines' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('shows pending execution and keeps a failed run’s captured output', () => {
    const pending = { ...CELL, timeSeconds: null }
    delete pending.result
    delete pending.outputDetail
    const view = render(<Harness cell={pending} />)
    const ui = within(view.container)
    fireEvent.click(ui.getByRole('row', { name: /run_code Read/ }))
    expect(ui.getByRole('tabpanel').textContent).toContain('Running…')
    view.rerender(<Harness cell={{ ...CELL, isError: true, outputDetail: 'Error: execution failed\nCaptured output:\nstep one' }} />)
    expect(ui.getByRole('tabpanel').textContent).toContain('Failed')
    expect(ui.getByRole('tabpanel').textContent).toContain('Error: execution failed\nCaptured output:\nstep one')
  })

  it('uses a tree for complete JSON output and generic input for malformed arguments', () => {
    const view = render(<Harness cell={{ ...CELL, outputDetail: '{"passed":12,"failed":0}' }} />)
    const ui = within(view.container)
    fireEvent.click(ui.getByRole('row', { name: /run_code Read/ }))
    expect(ui.getByRole('tree', { name: 'Result JSON' }).textContent).toContain('passed:12')
    view.rerender(<Harness cell={{ ...CELL, inputDetail: '{"code":3}' }} />)
    expect(ui.getByRole('tab', { name: 'Payload' })).toBeTruthy()
    expect(ui.queryByRole('tab', { name: 'Code' })).toBeNull()
    expect(ui.getByRole('tree', { name: 'Payload JSON' }).textContent).toContain('code:3')
  })
})
