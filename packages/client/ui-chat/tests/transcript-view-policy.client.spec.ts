// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import type { ChatSettings } from '../src/chat-settings.ts'
import { TranscriptViewPolicy } from '../src/client/transcript-view.ts'

describe('TranscriptViewPolicy', () => {
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
  })

  it.each(['normal', 'expanded'] as const)('reads an initial Host %s setting as Detailed without writing it back', (mode) => {
    const host = stubConfigForm<ChatSettings>()
    host.publish({ status: 'ready', value: { linkOpening: 'sidebar', transcriptView: mode, performanceUsage: 'detailed' }, revision: 1, writable: true })
    expect(new TranscriptViewPolicy(host.scope, 'standard').mode.getSnapshot()).toBe('detailed')
    expect(host.set).not.toHaveBeenCalled()
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
