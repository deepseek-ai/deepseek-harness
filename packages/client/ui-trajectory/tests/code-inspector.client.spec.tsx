// @vitest-environment jsdom
/** PTC source, output, and independent wrapping through the trajectory inspector. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { TrajectoryTable } from '../src/client/TrajectoryTable.tsx'
import { deriveTrajectoryLayout } from '../src/client/layout.ts'
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
    renderSlot={() => null} loadImage={async () => 'blob:unused'} t={t}
    stringWrapping={{ label: 'Wrap lines', getDefault, setDefault }}
    collapsedTurns={new Set()} onToggleTurn={() => {}}
    collapsedAssistants={new Set()} onToggleAssistant={() => {}}
    collapsedTools={new Set()} onToggleTool={() => {}}
  />
}

function failedCell(name: string, texts: readonly string[], nested: boolean): TrajectoryCellProps {
  const argsRaw = name === 'run_code' ? ARGS : '{"file_path":"missing.txt"}'
  const result: ToolResultNode = {
    kind: 'tool-result', seq: 1, time: 1_000, callId: 'failed-call', name,
    args: PartialArguments.fromText(argsRaw), call: { name, argsRaw }, callTime: 500,
    content: texts.map(text => ({ type: 'text', text })), isError: true,
    error: { name: 'ToolError', code: 'TOOL_FAILED' }, subCalls: [],
  }
  const turns = deriveTrajectoryLayout({
    nodes: nested ? [{ ...result, callId: 'parent', name: 'run_code', isError: false, subCalls: [result] }] : [result],
    partial: null, runningCalls: [],
  }, t)
  return turns.flatMap(turn => turn.groups.flatMap(group => group.cells))
    .find(cell => cell.kind === (nested ? 'subtool' : 'tool'))!
}

describe('PTC trajectory inspector', () => {
  it.each([
    ['run_code', false], ['read', false], ['read', true],
  ] as const)('keeps failed %s JSON output as raw text (nested: %s)', (name, nested) => {
    const output = '{ "reason" : "missing", "steps": [1, 2] }\n'
    const view = render(<Harness cell={failedCell(name, [output], nested)} />)
    const ui = within(view.container)
    fireEvent.click(ui.getByRole('row', { name: /TOOL/ }))
    for (const tab of ['Summary', 'Result']) {
      fireEvent.click(ui.getByRole('tab', { name: tab }))
      const panel = ui.getByRole('tabpanel')
      expect(within(panel).queryByRole('tree', { name: 'Result JSON' })).toBeNull()
      expect([...panel.querySelectorAll('pre')].filter(pre => pre.textContent === output)).toHaveLength(1)
    }
  })

  it.each([
    ['run_code', false], ['read', false], ['read', true],
  ] as const)('keeps error details for empty %s blocks (nested: %s)', async (name, nested) => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const cell = failedCell(name, ['', ''], nested)
    expect(cell.outputDetail).toBe('ToolError: TOOL_FAILED')
    const view = render(<Harness cell={cell} />)
    const ui = within(view.container)
    expect(ui.getByRole('row', { name: /TOOL/ }).textContent).toContain('TOOL_FAILED')
    fireEvent.click(ui.getByRole('row', { name: /TOOL/ }))
    for (const tab of ['Summary', 'Result']) {
      fireEvent.click(ui.getByRole('tab', { name: tab }))
      expect(ui.getByRole('tabpanel').textContent).toContain('ToolError: TOOL_FAILED')
    }
    if (name === 'run_code') {
      fireEvent.click(ui.getByRole('tab', { name: 'Summary' }))
      fireEvent.click(ui.getByRole('button', { name: 'Copy output' }))
      await waitFor(() => { expect(writeText).toHaveBeenLastCalledWith('ToolError: TOOL_FAILED') })
    }
  })

  it.each([
    ['run_code', false], ['read', false], ['read', true],
  ] as const)('keeps whitespace-only %s failure text verbatim (nested: %s)', (name, nested) => {
    const output = ' \n\t '
    const cell = failedCell(name, [output], nested)
    expect(cell.resultPreviewMarkdown).toBe(output)
    expect(cell.outputDetail).toBe(output)
    const view = render(<Harness cell={cell} />)
    const ui = within(view.container)
    fireEvent.click(ui.getByRole('row', { name: /TOOL/ }))
    for (const tab of ['Summary', 'Result']) {
      fireEvent.click(ui.getByRole('tab', { name: tab }))
      const panel = ui.getByRole('tabpanel')
      expect(panel.textContent).not.toContain('ToolError: TOOL_FAILED')
      expect([...panel.querySelectorAll('pre')].filter(pre => pre.textContent === output)).toHaveLength(1)
    }
  })

  it.each(['run_code', 'read'])('preserves the recorded %s failure in the ledger and inspector', async (name) => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const output = name === 'run_code'
      ? "Error: code run failed (exception): Identifier 'value' has already been declared\nCaptured output:\nstep one\n"
      : 'Error: missing.txt does not exist\nCheck the file path.\n'
    const argsRaw = name === 'run_code' ? ARGS : '{"file_path":"missing.txt"}'
    const turns = deriveTrajectoryLayout({
      nodes: [{
        kind: 'tool-result', seq: 1, time: 1_000, callId: 'failed-call', name,
        args: PartialArguments.fromText(argsRaw), call: { name, argsRaw }, callTime: 500,
        content: [{ type: 'text', text: output }], isError: true,
        error: { name: 'CodeRunFailedError', code: 'CODE_RUN_FAILED' }, subCalls: [],
      }],
      partial: null, runningCalls: [],
    }, t)
    const cell = turns.flatMap(turn => turn.groups.flatMap(group => group.cells))[0]!
    const view = render(<Harness cell={cell} />)
    const ui = within(view.container)
    expect(ui.getByRole('row', { name: /TOOL/ }).textContent).toContain(output.split('\n')[0])
    fireEvent.click(ui.getByRole('row', { name: /TOOL/ }))
    for (const tab of ['Summary', 'Result']) {
      fireEvent.click(ui.getByRole('tab', { name: tab }))
      const panel = ui.getByRole('tabpanel')
      expect(panel.textContent).not.toContain('CodeRunFailedError: CODE_RUN_FAILED')
      expect([...panel.querySelectorAll('pre')].filter(pre => pre.textContent === output)).toHaveLength(1)
    }
    if (name === 'run_code') {
      fireEvent.click(ui.getByRole('tab', { name: 'Summary' }))
      fireEvent.click(ui.getByRole('button', { name: 'Copy output' }))
      await waitFor(() => { expect(writeText).toHaveBeenLastCalledWith(output) })
    }
  })

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
