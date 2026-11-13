import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
// @vitest-environment jsdom
import { cloneElement, forwardRef, useState, useSyncExternalStore } from 'react'
import type { ButtonHTMLAttributes, ComponentProps, ReactElement, ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { Panel } from '../src/client/Panel.tsx'
import { Details } from '../src/client/Details.tsx'
import { en } from '../src/client/locales.ts'
import type { TimelineKey } from '../src/client/locales.ts'
import type { ViewState } from '../src/client/store.ts'
import { createViewStore } from '../src/client/store.ts'
import { annotationSchema, taskId, treeSchema, reportSchema } from '../src/records.ts'
import type { TimelineView } from '../src/records.ts'
import { patchTasks, recordTaskHistory } from '../src/tasks.ts'
import { Config, liveConfig } from '../src/config.ts'
import type { ProgressPrecision } from '../src/policy.ts'
import type { AnnotationRequest } from '../src/client/actions.ts'
import type { TreeTransferActions } from '../src/client/TreeTransfer.tsx'
import checkpoint from './checkpoint.timeline.json' with { type: 'json' }
import { treeId } from '../src/records.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  MarkdownText: ({ text }: { text: string }) => <div>{text}</div>,
  Button: forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>((props, ref) => (
    <button {...props} ref={ref} />
  )),
  Tag: ({ children, tone }: { children: ReactNode; tone: string }) => (
    <span data-tone={tone}>{children}</span>
  ),
  IconCheckOutlineRegular: () => <span />,
  IconChevronDownOutlineRegular: () => <span />,
  IconChevronRightOutlineRegular: () => <span />,
  IconChevronLeftOutlineRegular: () => <span />,
  IconEllipsisOutlineRegular: () => <span />,
  IconDownloadOutlineRegular: () => <span />,
  IconPlusOutlineRegular: () => <span />,
  IconTrashOutlineRegular: () => <span />,
  IconPauseOutlineRegular: () => <span data-icon="pause" />,
  IconPlayOutlineRegular: () => <span data-icon="play" />,
  IconListPenOutlineRegular: () => <span />,
  IconChevronsUpDownOutlineRegular: () => <span />,
  IconQueueOutlineRegular: () => <span />,
  IconQuestionOutlineRegular: () => <span />,
  Tooltip: ({ children, label }: { children: ReactElement<{ 'data-tooltip'?: string }>; label: string }) =>
    cloneElement(children, { 'data-tooltip': label }),
  Modal: ({
    open,
    title,
    description,
    children,
    footer,
    onClose,
    closeLabel,
  }: {
    open: boolean
    title: string
    description?: string
    children: ReactNode
    footer: ReactNode
    onClose: () => void
    closeLabel: string
  }) =>
    open ? (
      <section role="dialog" aria-label={title}>
        <button aria-label={closeLabel} onClick={onClose} />
        {description}
        <div>{children}</div>
        <footer>{footer}</footer>
      </section>
    ) : null,
  Menu: ({
    anchor,
    open,
    items,
    onClose,
    onSelect,
  }: {
    anchor: ReactNode
    open: boolean
    items: { id: string; label: ReactNode; disabled?: boolean }[]
    onClose: () => void
    onSelect: (id: string) => void
  }) => (
    <div>
      {anchor}
      {open ? (
        <div role="menu" onKeyDown={(event) => {
          if (event.key === 'Escape') onClose()
        }}>
          {items.map(item => (
            <button key={item.id} role="menuitem" disabled={item.disabled} onClick={() => { onSelect(item.id) }}>
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  ),
}))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const now = Date.parse('2026-10-22T03:00:00Z')
const tree = treeSchema.parse({
  id: 'release',
  title: 'Review release',
  description: '',
  createdAt: now - 60000,
  tasks: patchTasks(
    [],
    [
      { id: taskId.parse('group'), title: 'Review' },
      {
        id: taskId.parse('code'),
        parent: taskId.parse('group'),
        title: 'Read code',
        status: 'done',
        details: 'Code is ready.',
      },
      {
        id: taskId.parse('check'),
        parent: taskId.parse('group'),
        title: 'Verify behavior',
        status: 'active',
        remaining: 8,
        timeShare: 4,
      },
    ],
    now,
    10,
  ),
})
const view: TimelineView = {
  annotations: [],
  trees: [tree],
  activeTreeId: tree.id,
  reports: [],
  error: null,
}
const openTab = vi.fn()
const requestTask = vi.fn().mockResolvedValue(undefined)
const setPriority = vi.fn().mockResolvedValue(undefined)
const importTree = vi
  .fn<TreeTransferActions['importTree']>()
  .mockResolvedValue({ action: 'import', tree: treeId.parse('imported'), reused: false, notified: true })
const removeTree = vi.fn<TreeTransferActions['removeTree']>()
  .mockResolvedValue({ action: 'remove', removed: true, notified: true, draft: false })
const annotate = vi
  .fn<(request: AnnotationRequest) => Promise<{ notified: boolean }>>()
  .mockResolvedValue({ notified: true })
function Fixture({
  factors = [5, 12, 24],
  decimals = 2,
  segmented = false,
  value = view,
  initial = {},
  time = now,
  running = false,
  loading = false,
  configured = true,
  reportsEnabled = true,
  selected = false,
}: {
  factors?: number[]
  decimals?: ProgressPrecision
  segmented?: boolean
  value?: TimelineView
  initial?: Partial<ViewState>
  time?: number
  running?: boolean
  loading?: boolean
  configured?: boolean
  reportsEnabled?: boolean
  selected?: boolean
}) {
  const [store] = useState(() => {
    const instance = createViewStore().create()
    instance.actions.update({ zoom: 5, ...initial })
    return instance
  })
  const state = useSyncExternalStore(listener => store.subscribe(listener), () => store.getSnapshot())
  const sessionId = SessionId('panel-fixture')
  const props = {
    sessionId,
    useProjection: () => loading ? undefined : value,
    useSelection: (select: (value: SessionId | null) => unknown) => select(selected ? sessionId : null),
    consumeSelection: () => undefined,
    useTabInfo: () => ({ sidebar: { expanded: true }, tab: { visible: true, actions: { openTab } } }),
    useStore: (selector: (value: ViewState) => unknown) => selector(state),
    useClock: (selector: (value: number) => unknown) => selector(time),
    useLocale: (selector: (value: { active: string }) => unknown) => selector({ active: 'en' }),
    useSettings: (selector: (value: unknown) => unknown) =>
      selector({
        value: configured ? liveConfig(Config({
          intervalMs: 60000,
          rollupFactors: factors,
          progressDecimals: decimals,
          segmentedProgress: segmented,
          reportsEnabled,
        })) : undefined,
      }),
    useSession: (selector: (value: unknown) => unknown) => selector({ running }),
    t: (key: TimelineKey, values?: Record<string, string | number>) =>
      en[key].replace(/\{(\w+)\}/gu, (token, field: string) => String(values?.[field] ?? token)),
    requestTask,
    setPriority,
    annotate,
    importTree,
    removeTree,
    actions: store.actions,
  } as ComponentProps<typeof Panel>
  return <Panel {...props} />
}
describe('the Task Tree and Timeline tabs', () => {
  it('shows an unavailable transcript target before offering the active tree', () => {
    const { rerender } = render(<Fixture initial={{ tree: treeId.parse('removed-tree') }} />)
    expect(screen.getByRole('status').textContent).toBe(en.treeUnavailable)
    expect(screen.queryByRole('button', { name: /Verify behavior\s*Active/ })).toBeNull()
    rerender(<Fixture value={{ ...view, trees: [], activeTreeId: null }} />)
    expect(screen.queryByRole('button', { name: en.openActiveTree })).toBeNull()
    rerender(<Fixture />)
    fireEvent.click(screen.getByRole('button', { name: en.openActiveTree }))
    expect(screen.getByRole('button', { name: /Verify behavior\s*Active/ })).toBeTruthy()
  })
  it('keeps the checkpoint picker consistent if the dialog closes during file loading', async () => {
    const pending = Promise.withResolvers<string>()
    const successful = Promise.withResolvers<string>()
    const old = new File(['{}'], 'older.timeline.json')
    Object.defineProperty(old, 'text', { value: () => successful.promise })
    const file = new File(['{}'], 'old.timeline.json')
    Object.defineProperty(file, 'text', { value: () => pending.promise })
    const open = () => {
      fireEvent.click(screen.getByRole('button', { name: en.treeActions }))
      fireEvent.click(screen.getByRole('menuitem', { name: en.importTree }))
      return within(screen.getByRole('dialog', { name: en.importTree }))
    }
    const rendered = render(<Fixture />)
    const dialog = open()
    const input = dialog.getByLabelText(en.chooseCheckpoint)
    fireEvent.change(input, { target: { files: [old] } })
    fireEvent.change(input, { target: { files: [file] } })
    await act(async () => { successful.resolve(JSON.stringify(checkpoint)) })
    expect(dialog.queryByText(old.name)).toBeNull()
    const [close] = dialog.getAllByRole('button', { name: en.cancel })
    if (close === undefined) throw new Error('Missing close button')
    fireEvent.click(close)
    expect(dialog.getByRole<HTMLButtonElement>('button', { name: en.saving }).disabled).toBe(true)
    rendered.unmount()
    pending.reject(new Error('File read cancelled'))
    await expect(pending.promise).rejects.toThrow('File read cancelled')
    render(<Fixture />)
    const reopened = open()
    expect(reopened.queryByText(file.name)).toBeNull()
    expect(reopened.getByRole<HTMLButtonElement>('button', { name: en.importTree }).disabled).toBe(true)
    expect(importTree).not.toHaveBeenCalled()
  })
  it('reports a download failure and keeps deletion confirmation open through a failed save', async () => {
    const createObjectURL = vi.fn().mockImplementation(() => { throw new Error('Downloads unavailable') })
    vi.stubGlobal('URL', class extends URL {
      static override createObjectURL = createObjectURL
    })
    const result = Promise.withResolvers<Awaited<ReturnType<TreeTransferActions['removeTree']>>>()
    removeTree.mockReturnValueOnce(result.promise)
    render(<Fixture />)
    const menuButton = screen.getByRole('button', { name: en.treeActions })
    fireEvent.click(menuButton)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    fireEvent.click(menuButton)
    fireEvent.click(screen.getByRole('menuitem', { name: en.exportTree }))
    expect(screen.getByRole('alert').textContent).toBe('Downloads unavailable')
    fireEvent.click(menuButton)
    fireEvent.click(screen.getByRole('menuitem', { name: en.deleteTree }))
    const dialog = within(screen.getByRole('dialog', { name: en.deleteTree }))
    fireEvent.click(dialog.getByRole('button', { name: en.exportTree }))
    expect(dialog.getByRole('alert').textContent).toBe('Downloads unavailable')
    fireEvent.click(dialog.getByRole('button', { name: en.deleteTree }))
    result.reject(new Error('Save unavailable'))
    expect((await dialog.findByRole('alert')).textContent).toBe('Save unavailable')
    expect(screen.getByRole('dialog', { name: en.deleteTree })).toBeTruthy()
    removeTree.mockResolvedValueOnce({ action: 'remove', removed: true, notified: false, draft: false })
    fireEvent.click(dialog.getByRole('button', { name: en.deleteTree }))
    expect((await screen.findByRole('alert')).textContent).toBe(en.treeNotifyUnknown)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
  it('keeps a removal dialog usable if another client removes its tree first', async () => {
    const createObjectURL = vi.fn().mockImplementation(() => { throw 'Download unavailable' })
    vi.stubGlobal('URL', class extends URL {
      static override createObjectURL = createObjectURL
    })
    const { rerender } = render(<Fixture />)
    fireEvent.change(screen.getByRole('combobox', { name: en.taskTreeChoice }), { target: { value: 'unavailable' } })
    const menu = screen.getByRole('button', { name: en.treeActions })
    fireEvent.click(menu)
    fireEvent.click(screen.getByRole('menuitem', { name: en.exportTree }))
    expect(screen.getByRole('alert').textContent).toBe(en.treeTransferFailed)
    fireEvent.click(menu)
    fireEvent.click(screen.getByRole('menuitem', { name: en.deleteTree }))
    rerender(<Fixture running value={{ ...view, activeTreeId: null, trees: [] }} />)
    const dialog = within(screen.getByRole('dialog', { name: en.deleteTree }))
    const remove = dialog.getByRole<HTMLButtonElement>('button', { name: en.deleteTree })
    expect(remove.disabled).toBe(true)
    expect(screen.getByRole('button', { name: en.importTree }).getAttribute('title')).toBe(en.treeIdleRequired)
    fireEvent.click(dialog.getByRole('button', { name: en.exportTree }))
    expect(dialog.getByRole('alert').textContent).toBe(en.treeTransferFailed)
    rerender(<Fixture value={{ ...view, activeTreeId: null, trees: [] }} />)
    removeTree.mockRejectedValueOnce('Delete rejected')
    fireEvent.click(remove)
    expect((await dialog.findByRole('alert')).textContent).toBe(en.treeTransferFailed)
  })
  it('allows selecting a saved plan without an active tree', () => {
    render(<Fixture value={{ ...view, activeTreeId: null }} />)
    expect(screen.getByText(en.emptyTasks)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.nextTree }))
    expect(screen.queryByText(en.emptyTasks)).toBeNull()
  })
  it('keeps navigation available after a selected task or report disappears', () => {
    const { rerender } = render(<Fixture configured={false} />)
    expect(screen.getByText('20.00%')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Review\s*Active/ }))
    expect(screen.getByRole('heading', { name: 'Review' })).toBeTruthy()
    expect(screen.getByText(en.progress).nextElementSibling?.textContent).toBe('20.00%')
    expect(screen.queryByText(en.completedUnits)).toBeNull()
    const tasks = patchTasks(tree.tasks, [
      { id: taskId.parse('group'), status: 'retired', subtree: true, note: 'Replaced by a new plan.' },
    ], now, 10)
    rerender(<Fixture value={{ ...view, trees: [{ ...tree, tasks }] }} />)
    expect(screen.getByText(en.retired)).toBeTruthy()
    expect(screen.getByText(en.progress).nextElementSibling?.textContent).toBe('0.00%')
    rerender(<Fixture value={{ ...view, trees: [], activeTreeId: null }} />)
    expect(screen.getByText(en.detailUnavailable)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.back }))
    expect(document.activeElement).toBe(screen.getByRole('tabpanel'))
    expect(screen.getByText(en.emptyTasks)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.importTree }))
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
  it('resets to the task tree on command selection and keeps report notices visible', () => {
    const shown = render(<Fixture loading initial={{ tab: 'timeline' }} />)
    expect(screen.getByRole('status').textContent).toBe(en.loading)
    shown.rerender(<Fixture configured={false} value={{ ...view, error: 'Report timed out.' }} />)
    expect(screen.getByRole('alert').textContent).toContain('Report timed out.')
    shown.rerender(<Fixture reportsEnabled={false} selected />)
    expect(screen.getByRole('tab', { name: en.tasks }).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(screen.getByRole('tab', { name: en.tasks }), { key: 'x' })
    expect(screen.getByRole('tab', { name: en.tasks }).getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('tab', { name: en.reports }))
    expect(screen.getByText(en.reportsDisabled).getAttribute('role')).toBe('status')
  })
  it('previews a fresh file after a failed read and keeps an unconfirmed import visible', async () => {
    render(<Fixture />)
    fireEvent.click(screen.getByRole('button', { name: en.treeActions }))
    fireEvent.click(screen.getByRole('menuitem', { name: en.importTree }))
    const dialog = screen.getByRole('dialog', { name: en.importTree })
    const input = within(dialog).getByLabelText(en.chooseCheckpoint)
    fireEvent.click(within(dialog).getByRole('button', { name: en.chooseCheckpoint }))
    fireEvent.change(input, { target: { files: [] } })
    const large = new File(['测'.repeat(700000)], 'large.timeline.json')
    fireEvent.change(input, { target: { files: [large] } })
    expect((await within(dialog).findByRole('alert')).textContent).toContain('2 MiB')
    const bad = new File(['{}'], 'invalid.timeline.json')
    const readFile = vi.fn<() => Promise<string>>().mockRejectedValueOnce('Read interrupted')
    Object.defineProperty(bad, 'text', { value: readFile })
    fireEvent.change(input, { target: { files: [bad] } })
    await within(dialog).findByText(en.treeTransferFailed)
    const content = JSON.stringify({ format: checkpoint.format, version: 1, title: 'New plan', tasks: [] })
    const file = new File([content], 'new.timeline.json')
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(content) })
    fireEvent.change(input, { target: { files: [file] } })
    await within(dialog).findByText('New plan')
    fireEvent.click(within(dialog).getByRole('checkbox', { name: en.copyCheckpoint }))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: en.continueCheckpoint }))
    importTree.mockRejectedValueOnce(new Error('Save interrupted'))
    const submit = within(dialog).getByRole('button', { name: en.importTree })
    act(() => {
      submit.click()
      submit.click()
    })
    await within(dialog).findByText('Save interrupted')
    expect(importTree).toHaveBeenCalledOnce()
    importTree.mockResolvedValueOnce({ action: 'import', tree: treeId.parse('imported'), reused: false, notified: false })
    fireEvent.click(within(dialog).getByRole('button', { name: en.importTree }))
    await screen.findByText(en.treeNotifyUnknown)
    expect(importTree.mock.calls[0]?.[0]).toMatchObject({ copy: true, continue: true })
    expect(importTree.mock.calls[0]?.[0].id).toBe(importTree.mock.calls[1]?.[0].id)
  })
  it('downloads the acknowledged plan and cancels removal while preserving it', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const createObjectURL = vi.fn(() => 'blob:plan')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', class extends URL {
      static override createObjectURL = createObjectURL
      static override revokeObjectURL = revokeObjectURL
    })
    render(<Fixture />)
    fireEvent.click(screen.getByRole('button', { name: en.treeActions }))
    fireEvent.click(screen.getByRole('menuitem', { name: en.exportTree }))
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe('Review release.timeline.json')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:plan')
    fireEvent.click(screen.getByRole('button', { name: en.treeActions }))
    fireEvent.click(screen.getByRole('menuitem', { name: en.deleteTree }))
    const dialog = screen.getByRole('dialog', { name: en.deleteTree })
    fireEvent.click(within(dialog).getByRole('button', { name: en.exportTree }))
    expect(click).toHaveBeenCalledTimes(2)
    const cancel = within(dialog).getAllByRole('button', { name: en.cancel })[0]
    if (cancel === undefined) throw new Error('Missing cancel button')
    fireEvent.click(cancel)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(removeTree).not.toHaveBeenCalled()
  })
  it('shows folded task revisions below discussions, newest first, without changing saved data', async () => {
    const tasks = recordTaskHistory([], tree.tasks, now - 2000)
    const updated = patchTasks(
      tasks,
      [{ id: taskId.parse('check'), title: 'Verify updated behavior', done: [1, 2], description: 'Updated scope.', note: 'Half verified.', details: 'CLI cases remain.' }],
      now,
      10,
    )
    const value = { ...view, trees: [{ ...tree, tasks: recordTaskHistory(tasks, updated, now) }] }
    const original = JSON.stringify(value)
    const { container, rerender } = render(<Fixture value={value} />)
    fireEvent.click(screen.getByRole('button', { name: /Verify updated behavior\s*Active/ }))
    const order = [...container.querySelectorAll('.timeline-detail-scroll > *')].map(node =>
      node.tagName === 'DL' ? 'metrics' : node.textContent)
    expect(order.slice(0, 5)).toEqual(['Review release', 'Updated scope.', 'Half verified.', 'metrics', 'CLI cases remain.'])
    const section = container.querySelector<HTMLDetailsElement>('.timeline-task-history')
    if (section === null) throw new Error('Missing change history')
    expect(section.previousElementSibling?.className).toBe('timeline-annotations')
    expect(section.open).toBe(false)
    expect(section.querySelector('ol')).toBeNull()
    section.open = true
    fireEvent(section, new Event('toggle'))
    await waitFor(() => { expect(section.querySelectorAll('li')).toHaveLength(2) })
    expect(section.querySelector('li')?.textContent).toContain('0.00% → 50.00%')
    expect(section.querySelector('li')?.textContent).toContain(`${en.durationWeight}4`)
    expect(section.querySelector('li')?.textContent).toContain('Updated scope.')
    expect(section.querySelector('li')?.textContent).toContain('CLI cases remain.')
    expect(section.querySelectorAll('li')[1]?.textContent).toContain('Verify behavior')
    expect(section.querySelectorAll('time')[0]?.dateTime).toBe(new Date(now).toISOString())
    expect(section.querySelectorAll('time')[1]?.dateTime).toBe(new Date(now - 2000).toISOString())
    expect(JSON.stringify(value)).toBe(original)
    rerender(<Fixture />)
    await waitFor(() => { expect(section.textContent).toContain(en.emptyTaskHistory) })
  })
  it('shows one progress value for a revision that keeps the displayed progress', async () => {
    const tasks = recordTaskHistory([], tree.tasks, now - 2000)
    const renamed = patchTasks(tasks, [{ id: taskId.parse('check'), title: 'Verify renamed behavior' }], now, 10)
    const value = { ...view, trees: [{ ...tree, tasks: recordTaskHistory(tasks, renamed, now) }] }
    const { container } = render(<Fixture value={value} />)
    fireEvent.click(screen.getByRole('button', { name: /Verify renamed behavior\s*Active/ }))
    const section = container.querySelector<HTMLDetailsElement>('.timeline-task-history')
    if (section === null) throw new Error('Missing change history')
    section.open = true
    fireEvent(section, new Event('toggle'))
    await waitFor(() => { expect(section.querySelectorAll('li')).toHaveLength(2) })
    expect(section.querySelector('li dd')?.textContent).toBe('0.00%')
  })
  it('shows only the tree title when the session has one task tree', () => {
    const { container } = render(<Fixture />)
    expect(screen.queryByRole('button', { name: en.previousTree })).toBeNull()
    expect(screen.queryByRole('button', { name: en.nextTree })).toBeNull()
    expect(container.querySelector('.timeline-tree-label small')).toBeNull()
    expect(screen.getByRole('navigation', { name: en.taskTreeChoice }).hasAttribute('data-single')).toBe(true)
    expect(screen.getByRole('combobox', { name: en.taskTreeChoice })).toBeTruthy()
  })
  it('previews a checkpoint before importing, with an explicit continuation request', async () => {
    render(<Fixture />)
    fireEvent.click(screen.getByRole('button', { name: 'Task tree actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Import task tree' }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Task tree actions' }))
    const input = screen.getByLabelText('Choose file…')
    const file = new File([JSON.stringify(checkpoint)], 'plan.timeline.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(JSON.stringify(checkpoint)) })
    fireEvent.change(input, { target: { files: [file] } })
    await screen.findByText('Restore saved plans')
    expect(importTree).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox', { name: en.continueCheckpoint }))
    fireEvent.click(screen.getByRole('button', { name: 'Import task tree' }))
    await waitFor(() => { expect(importTree).toHaveBeenCalledOnce() })
    expect(importTree).toHaveBeenCalledWith(
      expect.objectContaining({ content: JSON.stringify(checkpoint), copy: false, continue: true }),
    )
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })
  it('requires confirmation for tree deletion and refuses mutation controls during a running turn', async () => {
    const rendered = render(<Fixture />)
    fireEvent.click(screen.getByRole('button', { name: 'Task tree actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete task tree' }))
    expect(removeTree).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Delete task tree' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete task tree' }))
    await waitFor(() => { expect(removeTree).toHaveBeenCalledWith(tree.id) })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    rendered.rerender(<Fixture running />)
    fireEvent.click(screen.getByRole('button', { name: 'Task tree actions' }))
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Import task tree' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Delete task tree' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Export task tree' }).disabled).toBe(false)
  })
  it.each(['__proto__', 'constructor', 'toString'])(
    'keeps disclosure state local for the opaque tree ID %s',
    (id) => {
      const selected = treeSchema.parse({ ...tree, id })
      const store = createViewStore().create()
      const before: unknown = Object.getPrototypeOf(store.getSnapshot().collapsed)
      store.actions.toggle(selected.id, taskId.parse('group'))
      expect(Object.getPrototypeOf(store.getSnapshot().collapsed)).toBe(before)
      expect(Object.hasOwn(store.getSnapshot().collapsed, id)).toBe(true)
      expect(store.getSnapshot().collapsed[id]).toEqual(['group'])
      store.actions.toggle(selected.id, taskId.parse('group'))
      expect(store.getSnapshot().collapsed[id]).toEqual([])
      render(<Fixture value={{ ...view, trees: [selected], activeTreeId: selected.id }} />)
      const disclosure = screen.getByRole('button', { name: 'Review' })
      expect(disclosure.getAttribute('aria-expanded')).toBe('true')
      fireEvent.click(disclosure)
      expect(disclosure.getAttribute('aria-expanded')).toBe('false')
      fireEvent.click(disclosure)
      expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    },
  )

  it('switches overview and task bars together without changing their progress values', () => {
    const { rerender } = render(<Fixture />)
    const values = screen.getAllByRole('progressbar').map(bar => bar.getAttribute('aria-valuenow'))
    expect(screen.getAllByRole('progressbar').every(bar => !bar.hasAttribute('data-segmented'))).toBe(true)
    rerender(<Fixture segmented />)
    expect(screen.getAllByRole('progressbar').map(bar => bar.getAttribute('aria-valuenow'))).toEqual(values)
    expect(
      screen.getAllByRole('progressbar').every(bar => bar.getAttribute('data-segmented') === 'true'),
    ).toBe(true)
    rerender(<Fixture />)
    expect(screen.getAllByRole('progressbar').every(bar => !bar.hasAttribute('data-segmented'))).toBe(true)
  })

  it('retains each tree’s folds through arrows, the selector, bulk actions and tab changes with repeated task IDs', () => {
    const other = treeSchema.parse({
      ...tree,
      id: 'other',
      title: 'Second plan',
      tasks: tree.tasks.map(task => ({ ...task, title: `Second ${task.title}` })),
    })
    const value = { ...view, trees: [tree, other] }
    const { rerender } = render(<Fixture value={value} />)
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(screen.queryByRole('button', { name: /Read code/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.nextTree }))
    const second = screen.getByRole('button', { name: 'Second Review' })
    expect(second.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(second)
    fireEvent.click(screen.getByRole('button', { name: en.previousTree }))
    expect(screen.getByRole('button', { name: 'Review' }).getAttribute('aria-expanded')).toBe('false')
    fireEvent.change(screen.getByRole('combobox', { name: en.taskTreeChoice }), {
      target: { value: other.id },
    })
    expect(screen.getByRole('button', { name: 'Second Review' }).getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: en.treeActions }))
    fireEvent.click(screen.getByRole('menuitem', { name: en.expandAll }))
    expect(screen.getByRole('button', { name: 'Second Review' }).getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: en.previousTree }))
    fireEvent.click(screen.getByRole('tab', { name: /^Reports/ }))
    fireEvent.click(screen.getByRole('tab', { name: en.tasks }))
    rerender(<Fixture value={{ ...value, error: 'A report failed' }} />)
    expect(screen.getByRole('button', { name: 'Review' }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: /Read code/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.nextTree }))
    expect(screen.getByRole('button', { name: 'Second Review' }).getAttribute('aria-expanded')).toBe('true')
  })
  it('keeps a folded Session request history below both pages and preserves it through detail navigation', async () => {
    const report = reportSchema.parse({
      id: 'history-period',
      level: 0,
      start: now - 60000,
      end: now,
      policy: '[60000,5,3]',
      children: [],
      source: 'model',
      toolCount: 1,
      covered: 1,
      contextSeq: 1,
      summary: { progress: ['Recovery is verified.'], uncertainties: [], userActions: [] },
    })
    const annotations = [
      annotationSchema.parse({
        id: randomUUID(),
        target: { kind: 'tree', tree: tree.id },
        text: 'Pause at the next checkpoint.',
        createdAt: now,
        reply: null,
        control: { action: 'pause', delivery: 'accepted', outcome: null },
      }),
      annotationSchema.parse({
        id: randomUUID(),
        target: { kind: 'task', tree: tree.id, task: 'check' },
        text: 'Check the saved result.',
        createdAt: now + 1,
        reply: { text: 'The saved result is verified.', createdAt: now + 2 },
      }),
      annotationSchema.parse({
        id: randomUUID(),
        target: { kind: 'report', report: report.id },
        text: 'Explain this period.',
        createdAt: now + 3,
        reply: null,
      }),
    ]
    const value = { ...view, reports: [report], annotations }
    const original = JSON.stringify(value)
    const { container, rerender } = render(<Fixture value={value} />)
    const history = () => {
      const element = container.querySelector<HTMLDetailsElement>('.timeline-discussion-history')
      if (element === null) throw new Error('Missing request history')
      return element
    }
    const toggleHistory = (open: boolean) => {
      history().open = open
      fireEvent(history(), new Event('toggle'))
    }
    expect(history().parentElement).toBe(screen.getByRole('tabpanel'))
    expect(history().parentElement?.lastElementChild).toBe(history())
    expect(container.querySelector('.timeline-overview details')).toBeNull()
    expect(history().open).toBe(false)
    expect(history().querySelector('summary')?.textContent).toBe(`${en.discussionHistory} 3`)
    expect(screen.queryByText('Pause at the next checkpoint.')).toBeNull()
    toggleHistory(true)
    await waitFor(() => { expect(screen.getByText('Pause at the next checkpoint.')).toBeTruthy() })
    const titles = [...container.querySelectorAll('.timeline-annotation-target')].map(
      node => node.textContent,
    )
    expect(titles).toEqual([
      'Task Tree: Review release',
      'Review release · Verify behavior',
      `Level 1 · 1m: ${new Date(report.start).toLocaleString()} – ${new Date(report.end).toLocaleString()}`,
    ])
    expect(screen.getByText(en.controlWaiting)).toBeTruthy()
    expect(screen.getByText('The saved result is verified.')).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: /Reports/ }))
    expect(history().open).toBe(true)
    expect(history().parentElement?.lastElementChild).toBe(history())
    fireEvent.click(screen.getByRole('tab', { name: en.tasks }))
    fireEvent.click(screen.getByRole('button', { name: /Verify behavior\s*Active/ }))
    expect(container.querySelector('.timeline-discussion-history')).toBeNull()
    expect(screen.getByText('Check the saved result.')).toBeTruthy()
    expect(screen.queryByText('Explain this period.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.back }))
    expect(history().open).toBe(true)
    expect(screen.getByText('Explain this period.')).toBeTruthy()
    rerender(
      <Fixture
        value={{
          ...value,
          annotations: annotations.map(annotation =>
            annotation.control === undefined
              ? annotation
              : {
                ...annotation,
                control: { ...annotation.control, outcome: { status: 'applied', at: now + 4 } },
              },
          ),
        }}
      />,
    )
    expect(screen.getByText(en.controlApplied)).toBeTruthy()
    expect(screen.queryByText(en.controlWaiting)).toBeNull()
    toggleHistory(false)
    await waitFor(() => { expect(screen.queryByText('Explain this period.')).toBeNull() })
    expect(JSON.stringify(value)).toBe(original)
    expect(requestTask).not.toHaveBeenCalled()
    expect(setPriority).not.toHaveBeenCalled()
    expect(annotate).not.toHaveBeenCalled()
  })
  it('leaves no-activity placeholders out of the report count on the tab', () => {
    const placeholder = reportSchema.parse({
      id: 'quiet', level: 0, start: now - 60000, end: now, policy: '[60000,5]',
      children: [], source: 'no-activity', toolCount: 1, covered: 1, contextSeq: 1,
      summary: { progress: ['No activity.'], uncertainties: [], userActions: [] },
    })
    const { rerender } = render(<Fixture value={{ ...view, reports: [placeholder] }} />)
    expect(screen.getByRole('tab', { name: en.reports }).textContent).toBe(`${en.reports}0`)
    const report = reportSchema.parse({ ...placeholder, id: 'worked', source: 'model' })
    rerender(<Fixture value={{ ...view, reports: [placeholder, report] }} />)
    expect(screen.getByRole('tab', { name: en.reports }).textContent).toBe(`${en.reports}1`)
  })
  it('omits empty request history from both main pages', () => {
    render(<Fixture />)
    expect(screen.queryByText(en.discussionHistory)).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: /Reports/ }))
    expect(screen.queryByText(en.discussionHistory)).toBeNull()
  })
  it('shows unavailable discussion targets and unconfirmed delivery in saved history', () => {
    const missingTree = treeId.parse('removed')
    const archived = reportSchema.parse({
      id: 'legacy-period', level: 0, start: now - 120000, end: now, policy: 'legacy',
      children: [], source: 'model', toolCount: 1, covered: 1, contextSeq: 1,
      summary: { progress: ['Recovery is verified.'], uncertainties: [], userActions: [] },
    })
    const annotations = [
      { kind: 'tree', tree: missingTree },
      { kind: 'task', tree: missingTree, task: 'old-task' },
      { kind: 'report', report: 'old-report' },
      { kind: 'report', report: archived.id },
      { kind: 'tree', tree: tree.id },
    ].map((target, index) => annotationSchema.parse({
      id: randomUUID(), target, text: `Saved discussion ${index + 1}`, createdAt: now, reply: null,
      ...(index === 4 ? { control: { action: 'pause', delivery: 'unknown', outcome: null } } : {}),
    }))
    const { container } = render(<Fixture value={{ ...view, annotations, reports: [archived] }} initial={{ historyOpen: true }} />)
    const labels = [...container.querySelectorAll('.timeline-annotation-target')].map(node => node.textContent)
    expect(labels.slice(0, 3)).toEqual([
      `Task Tree: ${en.detailUnavailable}`, ` · ${en.detailUnavailable}`, en.detailUnavailable,
    ])
    expect(labels[3]).toContain('Level 1 · 2m: ')
    expect(screen.getByText(en.controlDeliveryUnknown)).toBeTruthy()
    expect(screen.getByRole('group', { name: en.pausePending }).getAttribute('data-tooltip')).toContain(en.controlDeliveryUnknown)
  })
  it('returns to the continuous report and saved scroll position after reading its details', () => {
    const report = reportSchema.parse({
      id: 'fragmented',
      level: 0,
      start: now - 3660000,
      end: now,
      ranges: [
        [now - 3660000, now - 3636000],
        [now - 60000, now],
      ],
      policy: '[60000,5,3]',
      children: [],
      source: 'model',
      toolCount: 1,
      covered: 1,
      contextSeq: 1,
      summary: { progress: ['Recovery is verified.'], uncertainties: [], userActions: [] },
    })
    const { container } = render(
      <Fixture value={{ ...view, reports: [report] }} initial={{ tab: 'timeline' }} />,
    )
    const origin = () => {
      const card = container.querySelector<HTMLButtonElement>('[data-report-id="fragmented"]')
      if (card === null) throw new Error('Missing report origin')
      return card
    }
    expect(container.querySelectorAll('[data-report-id="fragmented"]')).toHaveLength(1)
    fireEvent.scroll(screen.getByLabelText('History'), { target: { scrollTop: 120 } })
    const position = screen.getByLabelText('History').scrollTop
    fireEvent.click(origin())
    expect(screen.getByRole('heading', { name: 'Report · Level 1' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.back }))
    expect(document.activeElement).toBe(origin())
    expect(screen.getByLabelText('History').scrollTop).toBeCloseTo(position, 6)
  })
  it('keeps the priority chooser in the action grid and waits for committed user priority', async () => {
    const { rerender } = render(<Fixture />)
    fireEvent.click(screen.getByRole('button', { name: /Verify behavior\s*Active/ }))
    const priority = screen.getByRole('button', { name: 'Priority: None' })
    expect(priority.closest('footer')).toBeTruthy()
    fireEvent.click(priority)
    fireEvent.click(screen.getByRole('menuitem', { name: /P0.*Urgent/ }))
    await waitFor(() => {
      expect(setPriority).toHaveBeenCalledWith({ tree: 'release', task: 'check', priority: 'P0' }) },
    )
    expect(requestTask).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Priority: None' })).toBeTruthy()
    rerender(
      <Fixture
        value={{
          ...view,
          trees: [
            {
              ...tree,
              tasks: tree.tasks.map(task =>
                task.id === 'check' ? { ...task, priority: 'P0', updatedAt: now + 1 } : task,
              ),
            },
          ],
        }}
      />,
    )
    expect(screen.getByRole('button', { name: 'Priority: P0' })).toBeTruthy()
    expect(screen.getByText('Completed steps').nextElementSibling?.textContent).toBe('0 / 1')
    const control = screen.getByRole('button', { name: 'Priority: P0' })
    fireEvent.click(control)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    setPriority.mockRejectedValueOnce(new Error('Cannot save priority'))
    fireEvent.click(control)
    fireEvent.click(screen.getByRole('menuitem', { name: 'None' }))
    expect((await screen.findByRole('alert')).textContent).toBe(en.prioritySaveFailed)
    expect(screen.getByRole('button', { name: 'Priority: P0' })).toBeTruthy()
  })
  it('shows inherited priority in task rows and details while keeping the user override separate', () => {
    const inherited = {
      ...view,
      trees: [
        {
          ...tree,
          tasks: tree.tasks.map(task =>
            task.id === 'group' ? { ...task, priority: 'P0' as const } : task,
          ),
        },
      ],
    }
    render(<Fixture value={inherited} />)
    fireEvent.click(screen.getByRole('button', { name: /Verify behavior\s*Active/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Priority: P0' }))
    expect(screen.getByRole('menuitem', { name: 'Inherited: P0' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Inherited: P0' }))
    expect(setPriority).not.toHaveBeenCalled()
  })
  it('ignores repeated note submissions while a save is in flight', async () => {
    const pending = Promise.withResolvers<{ notified: boolean }>()
    annotate.mockReturnValueOnce(pending.promise)
    render(<Fixture />)
    fireEvent.click(screen.getByRole('button', { name: /Verify behavior\s*Active/ }))
    fireEvent.click(screen.getByRole('button', { name: en.addAnnotation }))
    const input = screen.getByRole<HTMLTextAreaElement>('textbox', { name: en.addAnnotation })
    const form = input.form
    if (form === null) throw new Error('Missing discussion form')
    fireEvent.submit(form)
    expect(annotate).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'Check the saved progress.' } })
    fireEvent.click(screen.getByRole('button', { name: en.cancelAnnotation }))
    fireEvent.click(screen.getByRole('button', { name: en.addAnnotation }))
    const reopened = screen.getByRole<HTMLTextAreaElement>('textbox', { name: en.addAnnotation })
    expect(reopened.value).toBe('')
    fireEvent.change(reopened, { target: { value: 'Check the saved progress.' } })
    if (reopened.form === null) throw new Error('Missing discussion form')
    fireEvent.submit(reopened.form)
    fireEvent.submit(reopened.form)
    expect(annotate).toHaveBeenCalledOnce()
    await act(async () => { pending.resolve({ notified: true }) })
    expect(screen.queryByRole('textbox')).toBeNull()
  })
  it('retains a failed note draft and identity, then displays the committed user/agent pair', async () => {
    annotate
      .mockRejectedValueOnce(new Error('Save outcome unknown'))
      .mockResolvedValueOnce({ notified: false })
    const { rerender } = render(<Fixture />)
    fireEvent.click(screen.getByRole('button', { name: /Verify behavior\s*Active/ }))
    const add = screen.getByRole('button', { name: en.addAnnotation })
    expect(add.closest('footer')).toBeTruthy()
    fireEvent.click(add)
    const input = screen.getByRole('textbox', { name: en.addAnnotation }) as HTMLTextAreaElement
    expect(document.activeElement).toBe(input)
    expect(input.closest('footer')).toBe(add.closest('footer'))
    expect(add.getAttribute('aria-pressed')).toBe('true')
    fireEvent.change(input, { target: { value: 'Explain what the restart check still needs.' } })
    fireEvent.click(add)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(add.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(add)
    const reopened = screen.getByRole('textbox', { name: en.addAnnotation }) as HTMLTextAreaElement
    expect(reopened.value).toBe('Explain what the restart check still needs.')
    expect(document.activeElement).toBe(reopened)
    fireEvent.click(screen.getByRole('button', { name: en.saveAnnotation }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en.annotationSaveFailed) })
    expect(reopened.value).toBe('Explain what the restart check still needs.')
    const first = annotate.mock.calls[0]?.[0]
    if (first === undefined) throw new Error('Missing annotation request')
    expect(first.id).toMatch(/^note-[0-9a-f]{16}$/)
    fireEvent.click(screen.getByRole('tab', { name: en.reports }))
    fireEvent.click(screen.getByRole('tab', { name: en.tasks }))
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: en.addAnnotation }).value).toBe(first.text)
    const restoredAdd = screen.getByRole('button', { name: en.addAnnotation })
    fireEvent.click(restoredAdd)
    fireEvent.click(restoredAdd)
    fireEvent.click(screen.getByRole('button', { name: en.saveAnnotation }))
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe(en.annotationNotifyFailed) })
    expect(annotate.mock.calls[1]?.[0]).toEqual(first)
    expect(screen.queryByRole('textbox')).toBeNull()
    const committed = annotationSchema.parse({
      ...first,
      createdAt: now,
      reply: { text: 'The permission check still needs a test account.', createdAt: now + 1 },
    })
    rerender(<Fixture value={{ ...view, annotations: [committed] }} />)
    expect(screen.getByText('Explain what the restart check still needs.')).toBeTruthy()
    expect(screen.getByText('The permission check still needs a test account.')).toBeTruthy()
    expect(screen.getByText(en.annotationResolved)).toBeTruthy()
    expect(screen.getByText('Completed steps').nextElementSibling?.textContent).toBe('0 / 1')
  })
  it('adds a note to a report reference without rewriting historical report content', async () => {
    const report = reportSchema.parse({
      id: 'discuss',
      level: 0,
      start: now - 60000,
      end: now,
      policy: '[60000,5]',
      children: [],
      source: 'model',
      toolCount: 1,
      covered: 1,
      contextSeq: 1,
      summary: { progress: ['Restart checks passed.'], uncertainties: [], userActions: [] },
    })
    render(
      <Details
        view={{ ...view, reports: [report] }}
        target={{ kind: 'report', report: report.id }}
        decimals={2}
        back={vi.fn()}
        open={vi.fn()}
        requestTask={requestTask}
        playback={{ annotations: [], trees: view.trees, now }}
        setPriority={setPriority}
        annotate={annotate}
        t={key => en[key as TimelineKey]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: en.addAnnotation }))
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'What did this period leave unresolved?' },
    })
    fireEvent.click(screen.getByRole('button', { name: en.saveAnnotation }))
    await waitFor(() => {
      expect(annotate).toHaveBeenCalledWith(
        expect.objectContaining({
          target: { kind: 'report', report: 'discuss' },
          text: 'What did this period leave unresolved?',
        }),
      ) },
    )
    expect(screen.getByText('Restart checks passed.')).toBeTruthy()
    expect(report.summary.progress).toEqual(['Restart checks passed.'])
  })
  it('requests leaf pause and resume without optimistic edits and reflects committed status changes', async () => {
    const treeRef: unknown = expect.objectContaining({ id: 'release' })
    const taskRef: unknown = expect.objectContaining({ id: 'check' })
    const pending = Promise.withResolvers<undefined>()
    requestTask.mockReturnValueOnce(pending.promise)
    const { rerender } = render(<Fixture />)
    fireEvent.click(screen.getByRole('button', { name: /Verify behavior\s*Active/ }))
    const pause = screen.getByRole('button', { name: en.pauseTask }) as HTMLButtonElement
    act(() => {
      pause.click()
      pause.click()
    })
    expect(requestTask).toHaveBeenCalledOnce()
    expect(requestTask).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'pause',
        tree: treeRef,
        task: taskRef,
      }),
    )
    expect(pause.disabled).toBe(true)
    expect(screen.getByText('Active')).toBeTruthy()
    pending.resolve(undefined)
    await waitFor(() => { expect(pause.disabled).toBe(false) })
    expect(screen.queryByRole('status')).toBeNull()
    const paused = {
      ...view,
      trees: [
        {
          ...tree,
          tasks: patchTasks(
            tree.tasks,
            [{ id: taskId.parse('check'), status: 'paused', note: 'User requested pause.' }],
            now + 1,
            10,
          ),
        },
      ],
    }
    rerender(<Fixture value={paused} />)
    expect(screen.getByText('Paused')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.resumeTask }))
    await waitFor(() => {
      expect(requestTask).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: 'resume', task: taskRef }),
      ) },
    )
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: en.resumeTask }).disabled).toBe(false) },
    )
    rerender(<Fixture />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.pauseTask }).disabled).toBe(false)
  })
  it('retains pending receipts across navigation, blocks overlapping requests, and exposes an explicit retry after a wait', async () => {
    const pending = annotationSchema.parse({
      id: randomUUID(),
      target: { kind: 'tree', tree: tree.id },
      text: 'Continue this plan.',
      createdAt: now,
      reply: null,
      control: { action: 'resume', delivery: 'accepted', outcome: null },
    })
    const paused = {
      ...view,
      annotations: [pending],
      trees: [{ ...tree, tasks: tree.tasks.map(task => ({ ...task, status: 'paused' as const })) }],
    }
    const { rerender } = render(<Fixture value={paused} />)
    const resume = screen.getByRole('button', { name: en.resumePending }) as HTMLButtonElement
    expect(resume.querySelector('[data-icon=play]')).not.toBeNull()
    expect(resume.disabled).toBe(true)
    fireEvent.click(resume)
    expect(requestTask).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Verify behavior\s*Paused/ }))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.resumePending }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.addAnnotation }).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: en.back }))
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.resumePending }).disabled).toBe(true)
    rerender(<Fixture value={paused} time={now + 180000} />)
    const retry = screen.getByRole('button', { name: en.retryResume }) as HTMLButtonElement
    expect(retry.disabled).toBe(false)
    expect(requestTask).not.toHaveBeenCalled()
    fireEvent.click(retry)
    await waitFor(() => { expect(requestTask).toHaveBeenCalledOnce() })
    expect(screen.queryByRole('status')).toBeNull()
  })
  it('shows an agent answer without claiming success and keeps the requested icon until plan confirmation', () => {
    const annotation = annotationSchema.parse({
      id: randomUUID(),
      target: { kind: 'task', tree: tree.id, task: 'check' },
      text: 'Pause this check.',
      createdAt: now,
      reply: { text: 'One operation still needs a safe checkpoint.', createdAt: now + 1 },
      control: { action: 'pause', delivery: 'accepted', outcome: { status: 'answered', at: now + 1 } },
    })
    const { rerender } = render(<Fixture value={{ ...view, annotations: [annotation] }} />)
    fireEvent.click(screen.getByRole('button', { name: /Verify behavior\s*Active/ }))
    const retry = screen.getByRole('button', { name: en.retryPause }) as HTMLButtonElement
    expect(retry.disabled).toBe(false)
    expect(retry.querySelector('[data-icon=pause]')).not.toBeNull()
    expect(screen.getByText(en.controlAnswered)).toBeTruthy()
    expect(screen.getByText('Active')).toBeTruthy()
    rerender(
      <Fixture
        value={{
          ...view,
          trees: [
            {
              ...tree,
              tasks: patchTasks(
                tree.tasks,
                [{ id: taskId.parse('check'), status: 'paused', note: 'Safe checkpoint reached.' }],
                now + 2,
                10,
              ),
            },
          ],
          annotations: [
            {
              ...annotation,
              control: { action: 'pause', delivery: 'accepted', outcome: { status: 'applied', at: now + 2 } },
            },
          ],
        }}
      />,
    )
    expect(screen.getByText(en.controlApplied)).toBeTruthy()
    expect(screen.queryByText(en.controlAnswered)).toBeNull()
    expect(
      screen.getByRole('button', { name: en.resumeTask }).querySelector('[data-icon=play]'),
    ).not.toBeNull()
  })
  it('places scoped pause/play beside overall progress and hides actions on empty or completed plans', async () => {
    const { rerender } = render(<Fixture />)
    const treeRef: unknown = expect.objectContaining({ id: 'release' })
    const pause = screen.getByRole('button', { name: en.pausePlan })
    expect(pause.textContent).toBe(en.pauseTask)
    expect(pause.parentElement?.nextElementSibling?.getAttribute('role')).toBe('progressbar')
    fireEvent.click(pause)
    await waitFor(() => {
      expect(requestTask).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'pause', tree: treeRef }),
      ) },
    )
    expect(requestTask.mock.calls[0]?.[0]).not.toHaveProperty('task')
    rerender(
      <Fixture
        value={{
          ...view,
          trees: [
            {
              ...tree,
              tasks: patchTasks(
                tree.tasks,
                [{ id: taskId.parse('check'), status: 'paused', note: 'A safe checkpoint.' }],
                now + 1,
                10,
              ),
            },
          ],
        }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: en.resumePlan }))
    await waitFor(() => {
      expect(requestTask).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: 'resume', tree: treeRef }),
      ) },
    )
    fireEvent.click(screen.getByRole('button', { name: /Read code\s*Done/ }))
    const completed = screen.getByRole('button', { name: en.taskCompleted }) as HTMLButtonElement
    expect(completed.disabled).toBe(true)
    const requests = requestTask.mock.calls.length
    fireEvent.click(completed)
    expect(requestTask).toHaveBeenCalledTimes(requests)
    expect(screen.queryByRole('button', { name: en.pauseTask })).toBeNull()
    expect(screen.getByRole('button', { name: en.addAnnotation })).toBeTruthy()
    cleanup()
    render(<Fixture value={{ ...view, trees: [{ ...tree, tasks: [] }] }} />)
    expect(screen.queryByRole('button', { name: en.resumePlan })).toBeNull()
    expect(screen.getByRole('progressbar', { name: 'Progress' }).getAttribute('aria-valuenow')).toBe('0')
  })
  it('keeps the task status and allows retry after an unconfirmed request', async () => {
    requestTask.mockRejectedValueOnce(new Error('Transport outcome unknown'))
    render(<Fixture />)
    fireEvent.click(screen.getByRole('button', { name: /Verify behavior\s*Active/ }))
    fireEvent.click(screen.getByRole('button', { name: en.pauseTask }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(en.taskRequestFailed) })
    expect(screen.getByText('Active')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.pauseTask }).disabled).toBe(false)
  })
  it('shows accepted interval settings while the Session projection remains idle', () => {
    const { rerender } = render(<Fixture />)
    fireEvent.click(screen.getByRole('tab', { name: /Reports/ }))
    expect(screen.getByRole('button', { name: '5m column' })).toBeTruthy()
    rerender(<Fixture factors={[2]} />)
    expect(screen.getByRole('button', { name: '2m column' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '5m column' })).toBeNull()
  })
  it('keeps task details tied to their tree when the agent selects another tree', () => {
    const other = treeSchema.parse({
      ...tree,
      id: 'other',
      title: 'Another plan',
      tasks: tree.tasks.map(task => ({
        ...task,
        title: `Other ${task.title}`,
        details: 'Different work.',
      })),
    })
    const props = {
      view: { ...view, trees: [tree, other], activeTreeId: other.id },
      target: { kind: 'task', tree: tree.id, task: taskId.parse('check') },
      decimals: 2,
      back: vi.fn(),
      open: vi.fn(),
      requestTask: vi.fn().mockResolvedValue(undefined),
      playback: { annotations: [], trees: view.trees, now },
      setPriority,
      annotate,
      t: (key: TimelineKey, values?: Record<string, string | number>) =>
        en[key].replace(/\{(\w+)\}/gu, (token, field: string) => String(values?.[field] ?? token)),
    } as ComponentProps<typeof Details>
    render(<Details {...props} />)
    expect(screen.getByRole('heading', { name: 'Verify behavior' })).toBeTruthy()
    expect(screen.getByText('Weight').nextElementSibling?.textContent).toBe('4')
    expect(screen.getByRole('button', { name: en.weightHint }).getAttribute('data-tooltip')).toBe(en.weightHint)
    expect(screen.getByText('Completed steps').nextElementSibling?.textContent).toBe('0 / 1')
    expect(screen.queryByText('Agent estimate')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(props.back).toHaveBeenCalledOnce()
  })
  it('updates displayed percentages and keeps bulk tree actions in a compact header menu', () => {
    const { rerender } = render(<Fixture />)
    expect(screen.getByRole('progressbar', { name: 'Progress' }).getAttribute('aria-valuetext')).toBe(
      '20.00%',
    )
    expect(screen.queryByText('Collapse all')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Task tree actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Collapse all' }))
    expect(screen.getByRole('button', { name: 'Review' }).getAttribute('aria-expanded')).toBe('false')
    rerender(<Fixture decimals={3} />)
    expect(screen.getByRole('progressbar', { name: 'Progress' }).getAttribute('aria-valuetext')).toBe(
      '20.000%',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Task tree actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Expand all' }))
    expect(screen.getByRole('button', { name: 'Review' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('uses calculated ETA and omits saved agent estimates from task details', () => {
    const { rerender } = render(<Fixture running />)
    expect(screen.getByText(/^Elapsed: 1m/)).toBeTruthy()
    expect(screen.getByText('Remaining: ≈4m')).toBeTruthy()
    const hint = screen
      .getByRole('button', { name: en.estimateHelp })
      .closest('[data-tooltip]')
      ?.getAttribute('data-tooltip')
    expect(hint).toContain(`${en.estimateCalculated}: ≈4m`)
    expect(hint).not.toContain('Agent estimate')
    rerender(<Fixture running time={now + 60000} />)
    expect(screen.getByText(/^Elapsed: 2m/)).toBeTruthy()
    expect(screen.getByText('Remaining: ≈8m')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Verify behavior\s*Active/ }))
    expect(openTab).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('tabpanel').textContent).toContain('Completed steps')
    expect(screen.queryByText('Agent estimate')).toBeNull()
    expect(screen.getByText('Weight').nextElementSibling?.textContent).toBe('4')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.queryByText('Completed steps')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Verify behavior\s*Active/ }))
  })
  it('uses the same formula when legacy agent estimates are missing', () => {
    const value = {
      ...view,
      trees: [{ ...tree, tasks: tree.tasks.map(task => ({ ...task, remaining: null })) }],
    }
    const { rerender } = render(<Fixture value={value} running />)
    expect(screen.getByText('Remaining: ≈4m')).toBeTruthy()
    const hint = screen
      .getByRole('button', { name: en.estimateHelp })
      .closest('[data-tooltip]')
      ?.getAttribute('data-tooltip')
    expect(hint).toContain(`${en.estimateCalculated}: ≈4m`)
    expect(hint).not.toContain('Agent estimate')
    expect(hint).toContain(en.estimateHint)
    rerender(<Fixture value={value} running time={now + 60000} />)
    expect(screen.getByText('Remaining: ≈8m')).toBeTruthy()
  })
  it.each(['pending', 'paused', 'blocked', 'done'] as const)(
    'stops the elapsed time at the last update and hides the estimate while the tree is %s, even during a turn',
    (status) => {
      const tasks = patchTasks(
        [],
        [{ id: taskId.parse('check'), title: 'Verify', status, note: 'Recorded state.' }],
        now,
        10,
      )
      render(<Fixture value={{ ...view, trees: [{ ...tree, tasks }] }} running time={now + 600000} />)
      expect(screen.getByText(`${en.elapsed}: 1m`)).toBeTruthy()
      expect(screen.queryByText(new RegExp(`^${en.remaining}`))).toBeNull()
      expect(screen.queryByRole('button', { name: en.estimateHelp })).toBeNull()
    },
  )
  it('stops the elapsed time and hides the estimate for an active tree while no turn is running', () => {
    const { rerender } = render(<Fixture time={now + 600000} />)
    expect(screen.getByText(`${en.elapsed}: 1m`)).toBeTruthy()
    expect(screen.queryByText(new RegExp(`^${en.remaining}`))).toBeNull()
    expect(screen.queryByRole('button', { name: en.estimateHelp })).toBeNull()
    rerender(<Fixture time={now + 1200000} />)
    expect(screen.getByText(`${en.elapsed}: 1m`)).toBeTruthy()
    rerender(<Fixture running time={now + 1200000} />)
    expect(screen.getByText(/^Elapsed: 21m/)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.estimateHelp })).toBeTruthy()
  })
  it('shows elapsed and remaining time to the minute', () => {
    const tasks = patchTasks(
      [],
      [
        { id: taskId.parse('saved'), title: 'Save', status: 'done', timeShare: 9 },
        { id: taskId.parse('check'), title: 'Verify', status: 'active' },
      ],
      now,
      10,
    )
    const recent = { ...tree, createdAt: now - 30000, tasks }
    const { rerender } = render(<Fixture value={{ ...view, trees: [recent] }} running />)
    expect(screen.getByText(/^Elapsed: <1m/)).toBeTruthy()
    expect(screen.getByText('Remaining: ≈1m')).toBeTruthy()
    rerender(<Fixture value={{ ...view, trees: [{ ...recent, createdAt: now - 7290000 }] }} running />)
    expect(screen.getByText(/^Elapsed: 2h 1m/)).toBeTruthy()
    expect(screen.getByText('Remaining: ≈14m')).toBeTruthy()
  })
  it('keeps the display unknown at zero progress even when an agent estimate is available', () => {
    const tasks = patchTasks(
      [],
      [{ id: taskId.parse('check'), title: 'Verify', status: 'active', remaining: 8 }],
      now,
      10,
    )
    render(<Fixture value={{ ...view, trees: [{ ...tree, tasks }] }} running />)
    expect(screen.getByText(/Remaining: Unknown/)).toBeTruthy()
    const hint = screen
      .getByRole('button', { name: en.estimateHelp })
      .closest('[data-tooltip]')
      ?.getAttribute('data-tooltip')
    expect(hint).toContain(`${en.estimateCalculated}: ${en.unknown}`)
    expect(hint).not.toContain('Agent estimate')
  })
  it('keeps task details inside their tab and restores branches and timetable position', () => {
    render(<Fixture />)
    fireEvent.click(screen.getByRole('button', { name: /Read code\s*Done/ }))
    expect(screen.getByRole('heading', { name: 'Read code' })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: /Reports/ }))
    fireEvent.scroll(screen.getByLabelText('History'), { target: { scrollTop: 3600 } })
    fireEvent.click(screen.getByRole('tab', { name: 'Task Tree' }))
    expect(screen.getByRole('heading', { name: 'Read code' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(screen.getByRole('button', { name: 'Review' }).getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(screen.getByRole('tab', { name: /Reports/ }))
    expect(screen.getByLabelText('History').scrollTop).toBeCloseTo(3600, 6)
    expect(screen.getByRole('button', { name: 'Back to now' })).toBeTruthy()
    fireEvent.click(screen.getByRole('tab', { name: 'Task Tree' }))
    expect(screen.getByRole('button', { name: 'Review' }).getAttribute('aria-expanded')).toBe('false')
    expect(openTab).not.toHaveBeenCalled()
  })
  it('shows weights with at most two decimals whatever the progress precision, without changing the stored weight', () => {
    const weighted = (timeShare: number) => ({
      ...view,
      trees: [
        {
          ...tree,
          tasks: tree.tasks.map(task => (task.id === 'check' ? { ...task, timeShare } : task)),
        },
      ],
    })
    const value = weighted(2.7564)
    const { rerender } = render(<Fixture value={value} decimals={0} />)
    fireEvent.click(screen.getByRole('button', { name: /Verify behavior\s*Active/ }))
    expect(screen.getByText('Weight').nextElementSibling?.textContent).toBe('2.76')
    rerender(<Fixture value={value} decimals={3} />)
    expect(screen.getByText('Weight').nextElementSibling?.textContent).toBe('2.76')
    rerender(<Fixture value={weighted(0.5)} decimals={0} />)
    expect(screen.getByText('Weight').nextElementSibling?.textContent).toBe('0.5')
    expect(value.trees[0]?.tasks.find(task => task.id === 'check')?.timeShare).toBe(2.7564)
  })
  it('drills into child reports and returns inside the Timeline container', () => {
    const child = reportSchema.parse({
      id: 'child',
      level: 0,
      start: now - 120000,
      end: now - 60000,
      policy: 'legacy-period',
      children: [],
      source: 'model',
      toolCount: 1,
      covered: 1,
      contextSeq: 1,
      summary: { progress: ['Recovery works after restart.'], uncertainties: [], userActions: [] },
    })
    const parent = reportSchema.parse({
      ...child,
      id: 'parent',
      level: 1,
      policy: '[60000,2]',
      start: now - 180000,
      children: [child.id, 'pruned-report'],
      workMs: 45000,
      summary: {
        ...child.summary,
        progress: [
          'Recovery checks passed.',
          'Saved tasks and discussions survived a fresh restart.',
          'No replacement plan was created.',
          'The confirmed result remains available for the next turn.',
        ],
      },
    })
    const notes = [
      annotationSchema.parse({ id: 'note-0000000000000001', target: { kind: 'report', report: child.id }, text: 'Check the backup too.', createdAt: now, reply: null }),
      annotationSchema.parse({ id: 'note-0000000000000002', target: { kind: 'tree', tree: tree.id }, text: 'Check plan scope.', createdAt: now, reply: null }),
    ]
    render(
      <Fixture value={{ ...view, reports: [child, parent], annotations: notes }} factors={[2]} initial={{ tab: 'timeline' }} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '2m column' }))
    expect(screen.queryByText('Saved tasks and discussions survived a fresh restart.')).toBeNull()
    const position = screen.getByLabelText('History').scrollTop
    const horizontal = document.querySelector<HTMLElement>('.timeline-table-scroll')
    expect(horizontal).toBeTruthy()
    fireEvent.scroll(horizontal as HTMLElement, { target: { scrollLeft: 40 } })
    fireEvent.click(screen.getByRole('button', { name: /Open report:.*Recovery checks passed/ }))
    for (const line of parent.summary.progress) expect(screen.getByText(line)).toBeTruthy()
    expect(screen.getByText(/Agent work time: 45s/)).toBeTruthy()
    fireEvent.click(screen.getByText(/Included reports/))
    fireEvent.click(screen.getByRole('button', { name: 'Recovery works after restart.' }))
    expect(screen.getByText('Check the backup too.')).toBeTruthy()
    expect(screen.queryByText('Check plan scope.')).toBeNull()
    expect(screen.queryByText('Recovery checks passed.')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByText('Recovery checks passed.')).toBeTruthy()
    const childLink = screen.getByRole('button', { name: 'Recovery works after restart.' })
    expect(document.activeElement).toBe(childLink)
    expect(childLink.closest('details')?.open).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('button', { name: '2m column' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByLabelText('History').scrollTop).toBe(position)
    expect(document.querySelector('.timeline-table-scroll')?.scrollLeft).toBe(40)
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /Open report:.*Recovery checks passed/ }),
    )
    expect(openTab).not.toHaveBeenCalled()
  })
  it('moves focus and selection with standard tab keyboard controls', () => {
    render(<Fixture />)
    const tasks = screen.getByRole('tab', { name: 'Task Tree' })
    fireEvent.keyDown(tasks, { key: 'ArrowRight' })
    const timeline = screen.getByRole('tab', { name: 'Reports' })
    expect(timeline.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(timeline)
    expect(screen.getByRole('tablist').getAttribute('aria-label')).toBe('Timeline')
    expect(screen.getByRole('tabpanel', { name: 'Reports' }).getAttribute('aria-labelledby')).toBe(timeline.id)
    fireEvent.keyDown(timeline, { key: 'Home' })
    expect(tasks.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tasks)
    fireEvent.keyDown(tasks, { key: 'End' })
    expect(timeline.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(timeline)
  })
})
