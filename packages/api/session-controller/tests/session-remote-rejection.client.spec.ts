/**
 * A rejection from the Remote face, which the generated client raises only for
 * an assembly fault (wrong arity, an unmounted method, a withdrawn
 * contribution), propagates out of the Session command unchanged and records no
 * prompt error. Carrier failures never reject: they arrive as folded results,
 * covered by session.client.spec.ts.
 */
import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { Session } from '../src/client/sessions/session.ts'
import type { SessionRemotes } from '../src/client/sessions/remotes.ts'

const SID = 'fk-s1' as SessionId
const PARENT = 'fk-parent' as SessionId

/** Calls used by Session prompt and cancel reject with `message`. */
function rejecting(message: string): SessionRemotes {
  const reject = (): Promise<never> => Promise.reject(new Error(message))
  const { remote } = RemoteMock.create()
  remote.commands.execute.mockImplementation(reject)
  remote.session.prompt.mockImplementation(reject)
  remote.session.cancel.mockImplementation(reject)
  remote.subagents.prompt.mockImplementation(reject)
  remote.subagents.interruptByUser.mockImplementation(reject)
  return {
    $stream: () => { throw new Error('unused') },
    commands: remote.commands,
    session: remote.session,
    subagents: remote.subagents,
  }
}

describe('Session over a rejecting Remote face', () => {
  it('propagates the rejection from prompt and cancel and records no prompt error', async () => {
    const session = new Session(SID, rejecting('assembly fault'))
    await expect(session.prompt([{ type: 'text', text: 'x' }], 'queue')).rejects.toThrow('assembly fault')
    await expect(session.cancel()).rejects.toThrow('assembly fault')
    expect(session.getSnapshot().promptError).toBeNull()
  })

  it('propagates the rejection from a subagent continuation prompt and interrupt', async () => {
    const session = new Session(SID, rejecting('assembly fault'), {
      address: { parentSessionId: PARENT, childSessionId: SID, mode: 'continuable' },
    })
    await expect(session.prompt([{ type: 'text', text: 'x' }], 'queue')).rejects.toThrow('assembly fault')
    await expect(session.cancel()).rejects.toThrow('assembly fault')
    expect(session.getSnapshot().promptError).toBeNull()
  })
})
