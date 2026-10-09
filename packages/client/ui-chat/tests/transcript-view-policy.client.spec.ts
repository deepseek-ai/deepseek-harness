// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import type { ChatSettings } from '../src/chat-settings.ts'
import { TranscriptViewPolicy } from '../src/client/transcript-view.ts'

afterEach(() => { vi.restoreAllMocks() })

describe('TranscriptViewPolicy', () => {
  it('defaults to completion and changes timing without reading or writing browser storage', () => {
    const storageReads = vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('"next-input"')
    const storageWrites = vi.spyOn(Storage.prototype, 'setItem')
    const storageRemovals = vi.spyOn(Storage.prototype, 'removeItem')
    const storageClears = vi.spyOn(Storage.prototype, 'clear')
    const host = stubConfigForm<ChatSettings>()
    const policy = new TranscriptViewPolicy(host.scope)
    const modeChanged = vi.fn()
    const timingChanged = vi.fn()
    const unsubscribeMode = policy.mode.subscribe(modeChanged)
    const unsubscribeTiming = policy.collapseTiming.subscribe(timingChanged)
    try {
      expect(policy.collapseTiming.getSnapshot()).toBe('completion')
      policy.setCollapseTiming('completion')
      expect(timingChanged).not.toHaveBeenCalled()
      policy.setCollapseTiming('next-input')
      expect(policy.collapseTiming.getSnapshot()).toBe('next-input')
      expect(timingChanged).toHaveBeenCalledTimes(1)
      policy.setCollapseTiming('next-input')
      expect(timingChanged).toHaveBeenCalledTimes(1)
      policy.setCollapseTiming('completion')
      expect(policy.collapseTiming.getSnapshot()).toBe('completion')
      expect(timingChanged).toHaveBeenCalledTimes(2)
      expect(policy.mode.getSnapshot()).toBe('detailed')
      expect(modeChanged).not.toHaveBeenCalled()
      expect(host.set).not.toHaveBeenCalled()
      expect(storageReads).not.toHaveBeenCalled()
      expect(storageWrites).not.toHaveBeenCalled()
      expect(storageRemovals).not.toHaveBeenCalled()
      expect(storageClears).not.toHaveBeenCalled()
    } finally {
      unsubscribeMode()
      unsubscribeTiming()
      policy.dispose()
    }
  })

  it('starts each instance with completion timing while adopting the accepted Host mode', () => {
    const host = stubConfigForm<ChatSettings>()
    host.publish({ status: 'ready', value: { linkOpening: 'sidebar', transcriptView: 'standard', performanceUsage: 'detailed' }, revision: 1, writable: true })
    const first = new TranscriptViewPolicy(host.scope)
    try {
      first.setCollapseTiming('next-input')
      const second = new TranscriptViewPolicy(host.scope)
      try {
        expect(first.collapseTiming.getSnapshot()).toBe('next-input')
        expect(second.collapseTiming.getSnapshot()).toBe('completion')
        expect(second.mode.getSnapshot()).toBe('standard')
        expect(host.set).not.toHaveBeenCalled()
      } finally {
        second.dispose()
      }
    } finally {
      first.dispose()
    }
    expect(host.listenerCount()).toBe(0)
  })

  it('adopts Host mode updates without overriding the local timing choice', () => {
    const host = stubConfigForm<ChatSettings>()
    const policy = new TranscriptViewPolicy(host.scope)
    try {
      policy.setCollapseTiming('next-input')
      host.publish({ status: 'ready', value: { linkOpening: 'sidebar', transcriptView: 'compact', performanceUsage: 'detailed' }, revision: 1, writable: true })
      expect(policy.mode.getSnapshot()).toBe('compact')
      expect(policy.collapseTiming.getSnapshot()).toBe('next-input')
      policy.setMode('verbose')
      expect(policy.collapseTiming.getSnapshot()).toBe('next-input')
      expect(host.set).toHaveBeenCalledExactlyOnceWith('transcriptView', 'verbose')
      host.publish({ value: { linkOpening: 'sidebar', transcriptView: 'standard', performanceUsage: 'detailed' }, revision: 2 })
      expect(policy.mode.getSnapshot()).toBe('standard')
      expect(policy.collapseTiming.getSnapshot()).toBe('next-input')
      expect(host.set).toHaveBeenCalledTimes(1)
    } finally {
      policy.dispose()
    }
  })

  it('defaults to Detailed and publishes explicit choices before persistence settles', () => {
    const host = stubConfigForm<ChatSettings>()
    const observed: string[] = []
    let current = (): string => 'unconstructed'
    const scope: typeof host.scope = {
      ...host.scope,
      set: (field, value) => {
        observed.push(`${field}=${String(value)}:${current()}`)
        return host.scope.set(field, value)
      },
    }
    const policy = new TranscriptViewPolicy(scope)
    current = () => policy.mode.getSnapshot()

    expect(policy.mode.getSnapshot()).toBe('detailed')
    policy.setMode('standard')
    expect(policy.mode.getSnapshot()).toBe('standard')
    expect(observed).toEqual(['transcriptView=standard:standard'])
    expect(host.set).toHaveBeenCalledWith('transcriptView', 'standard')
    policy.dispose()
  })

  it.each(['standard', 'detailed'] as const)('uses %s for missing preferences without writing a default', (defaultMode) => {
    const host = stubConfigForm<ChatSettings>()
    const policy = new TranscriptViewPolicy(host.scope, defaultMode)
    expect(policy.mode.getSnapshot()).toBe(defaultMode)
    host.publish({ value: { linkOpening: 'sidebar', performanceUsage: 'detailed' } })
    expect(policy.mode.getSnapshot()).toBe(defaultMode)
    host.publish({ value: { linkOpening: 'sidebar', transcriptView: 'compact', performanceUsage: 'detailed' } })
    expect(policy.mode.getSnapshot()).toBe('compact')
    host.publish({ value: { linkOpening: 'sidebar', transcriptView: null, performanceUsage: 'detailed' } })
    expect(policy.mode.getSnapshot()).toBe(defaultMode)
    expect(host.set).not.toHaveBeenCalled()
    policy.dispose()
  })

  it.each(['normal', 'expanded'] as const)('reads a later Host %s setting as Detailed without writing it back', (mode) => {
    const host = stubConfigForm<ChatSettings>()
    const policy = new TranscriptViewPolicy(host.scope, 'standard')

    host.publish({ status: 'ready', value: { linkOpening: 'sidebar', transcriptView: mode, performanceUsage: 'detailed' }, revision: 1, writable: true })
    expect(policy.mode.getSnapshot()).toBe('detailed')
    expect(host.set).not.toHaveBeenCalled()
    policy.setMode('detailed')
    expect(host.set).not.toHaveBeenCalled()

    policy.setMode('standard')
    expect(policy.mode.getSnapshot()).toBe('standard')
    expect(host.set).toHaveBeenCalledExactlyOnceWith('transcriptView', 'standard')

    host.publish({ value: { linkOpening: 'sidebar', transcriptView: 'compact', performanceUsage: 'detailed' }, revision: 2 })
    expect(policy.mode.getSnapshot()).toBe('compact')
    policy.dispose()
  })

  it.each(['normal', 'expanded'] as const)('reads an initial Host %s setting as Detailed without writing it back', (mode) => {
    const host = stubConfigForm<ChatSettings>()
    host.publish({ status: 'ready', value: { linkOpening: 'sidebar', transcriptView: mode, performanceUsage: 'detailed' }, revision: 1, writable: true })
    const policy = new TranscriptViewPolicy(host.scope, 'standard')
    expect(policy.mode.getSnapshot()).toBe('detailed')
    expect(host.set).not.toHaveBeenCalled()
    policy.dispose()
  })

  it.each(['compact', 'standard', 'detailed', 'verbose'] as const)('preserves an explicit %s setting without migration writes', (mode) => {
    const host = stubConfigForm<ChatSettings>()
    host.publish({ status: 'ready', value: { linkOpening: 'sidebar', transcriptView: mode, performanceUsage: 'detailed' }, revision: 1, writable: true })
    const policy = new TranscriptViewPolicy(host.scope)
    expect(policy.mode.getSnapshot()).toBe(mode)
    expect(host.set).not.toHaveBeenCalled()
    policy.dispose()
  })
})

it('releases its subscription when the consuming plugin unloads', () => {
  const host = stubConfigForm<ChatSettings>()
  const policy = new TranscriptViewPolicy(host.scope)
  expect(host.listenerCount()).toBe(1)
  policy.dispose()
  expect(host.listenerCount()).toBe(0)
})
