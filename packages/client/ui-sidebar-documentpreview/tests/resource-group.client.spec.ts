import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { Resources, ResourceSnapshot } from '@deepseek-ai/dsh-client-resources/client'
import type { WorkspaceFileStat } from '@deepseek-ai/dsh-api-workspace-files/types'
import { ResourceGroup } from '../src/client/document/resource-group.ts'

function harness() {
  const state = createSnapshotStore<ResourceSnapshot<WorkspaceFileStat>>({ status: 'loading', value: undefined, failure: undefined })
  const release = vi.fn()
  const source = {
    getSnapshot: () => state.getSnapshot(),
    subscribe: (listener: () => void) => {
      const off = state.subscribe(listener)
      return () => { off(); release() }
    },
  }
  const resources: Resources = { source: () => source, register: () => () => {}, pin: () => {} }
  const changed = vi.fn()
  const group = new ResourceGroup(resources, changed)
  onTestFinished(() => { group.close() })
  const version = (version: string): void => {
    state.set({ status: 'live', value: { absolutePath: '/style.css', version }, failure: undefined })
  }
  return { group, changed, version, release, state }
}

describe('ResourceGroup', () => {
  it('uses initial metadata as a baseline and invalidates only on later changes', () => {
    const h = harness()
    h.group.add('style.css')
    h.version('v2')
    expect(h.changed).not.toHaveBeenCalled()
    h.version('v3')
    expect(h.changed).toHaveBeenCalledOnce()
    h.group.close()
  })

  it('subscribes to an existing member only once', () => {
    const h = harness()
    h.group.add('style.css')
    h.version('v2')
    h.group.add('style.css')
    expect(h.changed).not.toHaveBeenCalled()
    h.version('v3')
    expect(h.changed).toHaveBeenCalledOnce()
    h.group.close()
  })

  it('ignores repeated metadata and stops observing after close', () => {
    const h = harness()
    h.version('v1')
    h.group.add('style.css')
    h.version('v1')
    expect(h.changed).not.toHaveBeenCalled()
    h.version('v2')
    expect(h.changed).toHaveBeenCalledOnce()
    h.group.close()
    h.version('v3')
    expect(h.changed).toHaveBeenCalledOnce()
  })

  it('shares membership and releases members absent from the next document', () => {
    const h = harness()
    h.group.add('style.css')
    h.group.add('style.css')
    h.group.set(['style.css', 'script.js'])
    h.group.set(['script.js'])
    expect(h.release).toHaveBeenCalledOnce()
    h.group.close()
    h.group.close()
    expect(h.release).toHaveBeenCalledTimes(2)
  })

  it('invalidates on failure and recovery without repeating an unchanged failure', () => {
    const h = harness()
    h.group.add('style.css')
    h.version('v1')
    const failed = {
      ...h.state.getSnapshot(), status: 'failed' as const,
      failure: new RemoteError('workspace-file/not-found', 'File missing', { path: 'style.css' }),
    }
    h.state.set(failed)
    expect(h.changed).toHaveBeenCalledOnce()
    h.state.set({ ...failed })
    expect(h.changed).toHaveBeenCalledOnce()
    h.version('v1')
    expect(h.changed).toHaveBeenCalledTimes(2)
  })
})
