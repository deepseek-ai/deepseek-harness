/** Stateful behavior of the app-owned RemoteMock scenario. */

import { expect, it } from 'vitest'
import { createAssembledRemote } from './assembled-remote.ts'

it('advances turns and updates the Session summary after accepted prompts', async () => {
  const { mock } = createAssembledRemote()
  await mock.dispatch('session/create', [{ request: { cwd: '/work' } }])
  await mock.dispatch('session/prompt', [{
    request: { sessionId: 'fx-1', requestId: 'request-1', mode: 'queue', content: [] },
  }])
  await mock.dispatch('session/prompt', [{
    request: { sessionId: 'fx-1', requestId: 'request-2', mode: 'queue', content: [] },
  }])

  const listed = await mock.dispatch('session/list', []) as {
    readonly ok: true
    readonly value: {
      readonly items: readonly { readonly sessionId: string; readonly blank: boolean; readonly running: boolean }[]
    }
  }
  expect(listed.ok).toBe(true)
  expect(listed.value.items.find(item => item.sessionId === 'fx-1')).toMatchObject({
    blank: false,
    running: true,
  })

  const iterator = mock.open('session/follow', [{
    request: { address: { kind: 'session', sessionId: 'fx-1' } },
  }], new AbortController().signal)[Symbol.asyncIterator]()
  await expect(iterator.next()).resolves.toMatchObject({
    done: false,
    value: {
      records: [
        { event: { type: 'turn/start', data: { turn: 0 } } },
        { event: { type: 'user/message' } },
        { event: { type: 'turn/start', data: { turn: 1 } } },
        { event: { type: 'user/message' } },
      ],
    },
  })
  await iterator.return?.()
  mock.assertNoUnmatched()
})
