import { describe, expect, it } from 'vitest'
import { createChatStore } from '../src/client/stores.ts'

describe('createChatStore', () => {
  it('starts without a selected Chat target', () => {
    const store = createChatStore().create()
    expect(store.store.getSnapshot()).toEqual({ selection: null, turnProcesses: [] })
  })

  it('selects and clears one Chat details target', () => {
    const store = createChatStore().create()
    store.actions.select({ turnSeq: 3, callId: 'c1', toolName: 'bash' })
    expect(store.store.getSnapshot().selection)
      .toEqual({ turnSeq: 3, callId: 'c1', toolName: 'bash' })
    store.actions.select(null)
    expect(store.store.getSnapshot().selection).toBeNull()
  })

  it('creates independent instances', () => {
    const handle = createChatStore()
    const first = handle.create()
    const second = handle.create()
    first.actions.select({ turnSeq: 1 })
    expect(second.store.getSnapshot().selection).toBeNull()
  })

  it('stores only manually expanded Turn-process answers', () => {
    const store = createChatStore().create()
    store.actions.setTurnProcessOpen(2, 3, true)
    expect(store.store.getSnapshot().turnProcesses).toEqual([{ turn: 2, answerStep: 3 }])

    store.actions.setTurnProcessOpen(2, 4, true)
    expect(store.store.getSnapshot().turnProcesses).toEqual([{ turn: 2, answerStep: 4 }])

    store.actions.setTurnProcessOpen(2, 4, false)
    expect(store.store.getSnapshot().turnProcesses).toEqual([])
  })

  it('closes only the requested Turn-process entry', () => {
    const store = createChatStore().create()
    store.actions.setTurnProcessOpen(2, 3, true)
    store.actions.setTurnProcessOpen(3, 4, true)

    store.actions.setTurnProcessOpen(2, 3, false)
    store.actions.setTurnProcessOpen(9, 10, false)

    expect(store.store.getSnapshot().turnProcesses).toEqual([{ turn: 3, answerStep: 4 }])
  })
})
