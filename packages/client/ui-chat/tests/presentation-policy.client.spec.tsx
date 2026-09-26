// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { TranscriptViewMode } from '../src/chat-settings.ts'
import { derivePresentationPolicy, presentationPolicyFor } from '../src/client/presentation-policy.ts'

afterEach(cleanup)

describe('Chat presentation policy', () => {
  it.each([
    ['compact', true, 'collapsed', false, false],
    ['standard', true, 'collapsed', true, true],
    ['detailed', true, 'history', true, true],
    ['verbose', false, 'none', true, false],
  ] as const)('maps %s to stable presentation capabilities', (mode, foldCompletedTurns, stepGrouping, settledReasoningPreview, liveProcessDetail) => {
    const policy = presentationPolicyFor(mode)
    expect(policy).toEqual({ mode, foldCompletedTurns, stepGrouping, settledReasoningPreview, liveProcessDetail })
    expect(presentationPolicyFor(mode)).toBe(policy)
  })

  it('forwards mode notifications and removes the subscription on disposal', () => {
    const mode = createSnapshotStore<TranscriptViewMode>('compact')
    const policy = derivePresentationPolicy(mode)
    const listener = vi.fn()
    const dispose = policy.subscribe(listener)
    expect(policy.getSnapshot()).toBe(presentationPolicyFor('compact'))
    mode.set('detailed')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(policy.getSnapshot()).toBe(presentationPolicyFor('detailed'))
    dispose()
    mode.set('verbose')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('renders only consumers whose selected field changes', () => {
    const mode = createSnapshotStore<TranscriptViewMode>('compact')
    const usePresentation = bindSnapshotSelector(derivePresentationPolicy(mode))
    const foldRender = vi.fn()
    const previewRender = vi.fn()
    function Fold() {
      const fold = usePresentation(policy => policy.foldCompletedTurns)
      foldRender(fold)
      return <span>{String(fold)}</span>
    }
    function Preview() {
      const preview = usePresentation(policy => policy.settledReasoningPreview)
      previewRender(preview)
      return <span>{String(preview)}</span>
    }
    render(<><Fold /><Preview /></>)
    expect(foldRender).toHaveBeenCalledTimes(1)
    expect(previewRender).toHaveBeenCalledTimes(1)
    act(() => { mode.set('detailed') })
    expect(foldRender).toHaveBeenCalledTimes(1)
    expect(previewRender).toHaveBeenCalledTimes(2)
    act(() => { mode.set('standard') })
    expect(foldRender).toHaveBeenCalledTimes(1)
    expect(previewRender).toHaveBeenCalledTimes(2)
    act(() => { mode.set('compact') })
    expect(foldRender).toHaveBeenCalledTimes(1)
    expect(previewRender).toHaveBeenCalledTimes(3)
  })
})
