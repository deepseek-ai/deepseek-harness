// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import type { ChatSettings } from '../src/chat-settings.ts'
import { TranscriptViewPolicy } from '../src/client/transcript-view.ts'

describe('TranscriptViewPolicy', () => {
  it('defaults to Standard and publishes explicit choices before persistence settles', () => {
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

    expect(policy.mode.getSnapshot()).toBe('standard')
    policy.setMode('detailed')
    expect(policy.mode.getSnapshot()).toBe('detailed')
    expect(observed).toEqual(['transcriptView=detailed:detailed'])
    expect(host.set).toHaveBeenCalledWith('transcriptView', 'detailed')
  })

  it('adopts Host state, reads normal as Standard, and ignores identical writes', () => {
    const host = stubConfigForm<ChatSettings>()
    const policy = new TranscriptViewPolicy(host.scope)

    host.publish({ status: 'ready', value: { linkOpening: 'sidebar', transcriptView: 'normal', performanceUsage: 'detailed' }, revision: 1, writable: true })
    expect(policy.mode.getSnapshot()).toBe('standard')
    policy.setMode('standard')
    expect(host.set).not.toHaveBeenCalled()

    host.publish({ value: { linkOpening: 'sidebar', transcriptView: 'compact', performanceUsage: 'detailed' }, revision: 2 })
    expect(policy.mode.getSnapshot()).toBe('compact')
  })

  it('adopts an accepted section standing at construction', () => {
    const host = stubConfigForm<ChatSettings>()
    host.publish({ status: 'ready', value: { linkOpening: 'sidebar', transcriptView: 'expanded', performanceUsage: 'detailed' }, revision: 1, writable: true })
    expect(new TranscriptViewPolicy(host.scope).mode.getSnapshot()).toBe('detailed')
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
