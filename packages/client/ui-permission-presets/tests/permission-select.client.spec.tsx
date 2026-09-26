// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  PermissionCatalog, PermissionSelection,
} from '@deepseek-ai/dsh-permission-presets/client'
import {
  PermissionSelect, type PermissionSelectProps,
} from '../src/client/PermissionSelect.tsx'
import type { PermissionCatalogState } from '../src/client/catalog.ts'
import { accessZh } from '../src/client/locales.ts'

afterEach(cleanup)

const CATALOG: PermissionCatalog = {
  defaultPreset: 'read-only', defaultOptions: [{ value: 'read-only', name: 'read-only' }, { value: 'workspace-write', name: 'workspace-write' }, { value: 'danger-full-access', name: 'danger-full-access' }],
  options: [
    { value: 'read-only', name: 'read-only' },
    { value: 'workspace-write', name: 'workspace-write' },
    { value: 'danger-full-access', name: 'danger-full-access' },
    {
      value: 'auto',
      name: 'Auto review',
      description: 'Host English Auto description',
    },
  ],
}

const t: PermissionSelectProps['t'] = makeTranslate(accessZh)

function setup(options: {
  selection?: PermissionSelection | undefined
  catalog?: PermissionCatalog | null
  locked?: boolean
  select?: (preset: string) => Promise<boolean>
} = {}) {
  const selection = createSnapshotStore<{ value: PermissionSelection | undefined }>({
    value: 'selection' in options ? options.selection : { currentValue: 'workspace-write' },
  })
  const catalog = createSnapshotStore<PermissionCatalogState>({
    value: options.catalog === undefined ? CATALOG : options.catalog,
  })
  const useProjection = (_key: string, selector?: (value: unknown) => unknown) =>
    bindSnapshotSelector(selection)(state => (selector ?? (value => value))(state.value))
  const select = vi.fn(options.select ?? (() => Promise.resolve(true)))
  const props = {
    locked: options.locked ?? false,
    useProjection,
    usePermissionCatalog: bindSnapshotSelector(catalog),
    select,
    t,
  } as unknown as PermissionSelectProps
  const view = render(<PermissionSelect {...props} />)
  return { catalog, props, select, selection, view }
}

function trigger(): HTMLButtonElement {
  return screen.getByRole('button', { name: /^访问模式/ }) as HTMLButtonElement
}

describe('PermissionSelect', () => {
  it('renders only when both the Session selection and process catalog exist', () => {
    const missingSelection = setup({ selection: undefined })
    expect(missingSelection.view.container.innerHTML).toBe('')
    cleanup()
    const missingCatalog = setup({ catalog: null })
    expect(missingCatalog.view.container.innerHTML).toBe('')
  })

  it('renders process options and submits an ordinary choice optimistically', async () => {
    const submitted = Promise.withResolvers<boolean>()
    const { select } = setup({
      selection: { currentValue: 'read-only' },
      select: () => submitted.promise,
    })
    expect(trigger().textContent).toBe('仅可查看')
    expect([...trigger().querySelectorAll('svg')]
      .every(icon => icon.closest('[aria-hidden="true"]') !== null)).toBe(true)

    fireEvent.click(trigger())
    expect(screen.getAllByRole('menuitem').map(item => item.textContent))
      .toEqual(['仅可查看', '工作区内修改', '完全权限', 'Auto reviewEXP'])
    fireEvent.click(screen.getByRole('menuitem', { name: '工作区内修改' }))

    expect(select).toHaveBeenCalledExactlyOnceWith('workspace-write')
    expect(trigger().textContent).toBe('工作区内修改')
    expect(trigger().disabled).toBe(true)
    submitted.resolve(true)
    await act(async () => { await submitted.promise })
    expect(trigger().disabled).toBe(false)
  })

  it('preserves host labels and ignores the already-current row', () => {
    const catalog: PermissionCatalog = {
      defaultPreset: 'read-only', defaultOptions: [{ value: 'read-only', name: 'read-only' }, { value: 'workspace-write', name: 'workspace-write' }, { value: 'danger-full-access', name: 'danger-full-access' }],
      options: [
        { value: 'workspace-write', name: 'Project Files' },
        { value: 'danger-full-access', name: 'Operator Mode' },
        { value: 'custom-mode', name: 'custom-mode' },
        { value: '__proto__', name: '__proto__' },
      ],
    }
    const { select } = setup({ catalog })
    expect(trigger().textContent).toBe('Project Files')
    fireEvent.click(trigger())
    expect(screen.getAllByRole('menuitem').map(item => item.textContent))
      .toEqual(['Project Files', 'Operator Mode', 'Custom Mode', '__proto__'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Project Files' }))
    expect(select).not.toHaveBeenCalled()
  })

  it('closes an open menu on an outside pointer', () => {
    setup()
    fireEvent.click(trigger())
    expect(screen.getAllByRole('menuitem')).toHaveLength(4)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menuitem')).toBeNull()
  })

  it('requires and resets explicit acknowledgement for Full access', async () => {
    const { select } = setup()
    const open = () => {
      fireEvent.click(trigger())
      fireEvent.click(screen.getByRole('menuitem', { name: '完全权限' }))
    }
    open()
    const enable = screen.getByRole<HTMLButtonElement>('button', { name: '启用完全权限' })
    expect(enable.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: '我已了解风险，并愿意继续' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(select).not.toHaveBeenCalled()

    open()
    expect(screen.getByRole<HTMLInputElement>('checkbox').checked).toBe(false)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '启用完全权限' }))
    expect(select).toHaveBeenCalledExactlyOnceWith('danger-full-access')
    await act(async () => {})
  })

  it('marks Auto experimental and uses the current-session risk copy', async () => {
    const { select, selection } = setup()
    fireEvent.click(trigger())
    fireEvent.click(screen.getByRole('menuitem', { name: 'Auto review EXP' }))

    const dialog = screen.getByRole('dialog', { name: '确认启用 Auto review（实验）？' })
    expect(dialog.textContent).toContain('不使用沙箱')
    expect(dialog.textContent).toContain('误放行或误拒绝')
    fireEvent.click(screen.getByRole('checkbox', { name: '我已了解这些风险，并愿意继续' }))
    fireEvent.click(screen.getByRole('button', { name: '启用 Auto review' }))
    expect(select).toHaveBeenCalledExactlyOnceWith('auto')
    act(() => { selection.set({ value: { currentValue: 'auto' } }) })
    await act(async () => {})

    expect(trigger().getAttribute('aria-label')).toBe('访问模式，当前：Auto review EXP')
    expect(trigger().querySelector('sup')?.textContent).toBe('EXP')
    expect(trigger().getAttribute('title')).toBe('无沙箱运行；每次原生工具调用和 PTC 内层调用前由同一模型进行实验性审查。')
  })

  it('revokes open UI when locked or either source disappears', () => {
    const locked = setup()
    fireEvent.click(trigger())
    fireEvent.click(screen.getByRole('menuitem', { name: '完全权限' }))
    locked.view.rerender(<PermissionSelect {...locked.props} locked />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger().disabled).toBe(true)

    cleanup()
    const vanished = setup()
    fireEvent.click(trigger())
    act(() => { vanished.catalog.set({ value: null }) })
    expect(vanished.view.container.innerHTML).toBe('')

    cleanup()
    const missingSelection = setup()
    fireEvent.click(trigger())
    act(() => { missingSelection.selection.set({ value: undefined }) })
    expect(missingSelection.view.container.innerHTML).toBe('')
  })

  it('revokes Auto confirmation and its optimistic label when the catalog withdraws it', async () => {
    const submitted = Promise.withResolvers<boolean>()
    const { catalog, select, selection } = setup({ select: () => submitted.promise })
    const withoutAuto = { ...CATALOG, options: CATALOG.options.filter(option => option.value !== 'auto') }
    const chooseAuto = () => {
      fireEvent.click(trigger())
      fireEvent.click(screen.getByRole('menuitem', { name: 'Auto review EXP' }))
    }
    try {
      chooseAuto()
      fireEvent.click(screen.getByRole('checkbox'))
      act(() => { catalog.set({ value: withoutAuto }) })
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(select).not.toHaveBeenCalled()
      expect(trigger().disabled).toBe(false)

      act(() => { catalog.set({ value: CATALOG }) })
      expect(screen.queryByRole('dialog')).toBeNull()
      chooseAuto()
      expect(screen.getByRole<HTMLInputElement>('checkbox').checked).toBe(false)
      fireEvent.click(screen.getByRole('checkbox'))
      fireEvent.click(screen.getByRole('button', { name: '启用 Auto review' }))
      expect(select).toHaveBeenCalledExactlyOnceWith('auto')
      expect(trigger().textContent).toBe('Auto reviewEXP')

      act(() => {
        selection.set({ value: { currentValue: 'danger-full-access' } })
        catalog.set({ value: withoutAuto })
      })
      expect(trigger().textContent).toBe('完全权限')
      expect(trigger().disabled).toBe(true)
    } finally {
      submitted.resolve(false)
      await act(async () => { await submitted.promise })
    }
    expect(trigger().disabled).toBe(false)
  })

  it('falls back to an unknown current value and clears a rejected optimistic choice', async () => {
    const select = vi.fn(() => Promise.reject(new Error('rejected')))
    const { selection } = setup({ selection: { currentValue: 'custom' }, select })
    expect(trigger().textContent).toBe('Custom')
    expect(trigger().querySelectorAll('svg')).toHaveLength(1)

    fireEvent.click(trigger())
    fireEvent.click(screen.getByRole('menuitem', { name: '工作区内修改' }))
    expect(trigger().textContent).toBe('工作区内修改')
    await act(async () => {})
    expect(trigger().textContent).toBe('Custom')
    act(() => { selection.set({ value: { currentValue: 'workspace-write' } }) })
    expect(trigger().textContent).toBe('工作区内修改')
  })
})
