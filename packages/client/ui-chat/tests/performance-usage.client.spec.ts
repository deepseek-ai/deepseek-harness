// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import type { ChatSettings } from '../src/chat-settings.ts'
import { PerformanceUsagePolicy } from '../src/client/performance-usage.ts'

describe('PerformanceUsagePolicy', () => {
  it('keeps explicit choices live when a memory-only scope cannot persist them', () => {
    const host = stubConfigForm<ChatSettings>()
    host.publish({ mode: 'memory', status: 'ready' })
    const policy = new PerformanceUsagePolicy(host.scope)
    expect(policy.mode.getSnapshot()).toBe('detailed')
    policy.setMode('compact')
    expect(policy.mode.getSnapshot()).toBe('compact')
    expect(host.set).toHaveBeenCalledWith('performanceUsage', 'compact')
    host.publish({ value: undefined, writable: false })
    expect(policy.mode.getSnapshot()).toBe('compact')
    policy.setMode('compact')
    expect(host.set).toHaveBeenCalledTimes(1)
  })

  it('adopts accepted Host settings at construction and after updates', () => {
    const host = stubConfigForm<ChatSettings>()
    host.publish({ value: { linkOpening: 'sidebar', transcriptView: 'normal', performanceUsage: 'compact' } })
    const policy = new PerformanceUsagePolicy(host.scope)
    expect(policy.mode.getSnapshot()).toBe('compact')
    host.publish({ value: { linkOpening: 'sidebar', transcriptView: 'normal', performanceUsage: 'detailed' } })
    expect(policy.mode.getSnapshot()).toBe('detailed')
  })
})

it('releases its subscription when the consuming plugin unloads', () => {
  const host = stubConfigForm<ChatSettings>()
  const policy = new PerformanceUsagePolicy(host.scope)
  expect(host.listenerCount()).toBe(1)
  policy.dispose()
  expect(host.listenerCount()).toBe(0)
})
