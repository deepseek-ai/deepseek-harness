// @vitest-environment jsdom
import { contextMenuHook } from '@deepseek-ai/dsh-client-test-runtime'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSyncExternalStore } from 'react'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionMarkdownCopyState } from '../src/client/copy-controller.ts'
import { SessionMarkdownCopyToast } from '../src/client/CopyToast.tsx'
import type { SessionMarkdownCopyToastProps } from '../src/client/CopyToast.tsx'
import { en } from '../src/client/locales.ts'

const unused = (): never => { throw new Error('This isolated component does not consume framework hooks') }
const standard: GlobalStandardProps = {
  useSessions: unused, useSessionStatus: unused, useSessionRetainInfo: unused,
  useSessionAccess: () => true, useRemoteAccess: () => true, useWorkspaceAccess: () => true,
  usePanelInfo: unused, useContextMenu: contextMenuHook(), useResource: unused, useWorkspaces: unused,
}

function bindSnapshot(store: ObservableSnapshot<SessionMarkdownCopyState>) {
  return function useSessionMarkdownCopy<T>(selector: (state: SessionMarkdownCopyState) => T): T {
    return useSyncExternalStore(
      listener => store.subscribe(listener),
      () => selector(store.getSnapshot()),
    )
  }
}

function bench(notice: SessionMarkdownCopyState['notice']) {
  const store = createSnapshotStore<SessionMarkdownCopyState>({ copying: false, notice })
  const dismiss = vi.fn()
  const dictionary: Record<string, string> = en
  const props: SessionMarkdownCopyToastProps = {
    ...standard,
    useSessionMarkdownCopy: bindSnapshot(store),
    dismiss,
    t: key => dictionary[key] ?? key,
  }
  return { ...render(<SessionMarkdownCopyToast {...props} />), store, dismiss }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('Session Markdown copy toast', () => {
  it('shows the success outcome and dismisses after the banner completes', () => {
    vi.useFakeTimers()
    const b = bench({ kind: 'success', seq: 1 })
    expect(b.getByRole('alert').textContent).toBe('Session copied as Markdown.')
    act(() => { vi.advanceTimersByTime(4_000) })
    expect(b.dismiss).toHaveBeenCalledOnce()
  })

  it('shows separate preparation and clipboard failure copy', () => {
    const preparation = bench({ kind: 'preparationFailed', seq: 2 })
    expect(preparation.getByRole('alert').textContent).toBe(
      'Could not read the Session for copying. Try again.',
    )
    cleanup()
    const clipboard = bench({ kind: 'clipboardFailed', seq: 3 })
    expect(clipboard.getByRole('alert').textContent).toBe(
      'Could not write to the clipboard. Check clipboard permission and try again.',
    )
  })

  it('renders nothing while no notice shows', () => {
    const b = bench(null)
    expect(b.container.childElementCount).toBe(0)
  })
})
