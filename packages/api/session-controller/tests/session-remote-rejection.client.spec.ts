/**
 * A rejection from the Remote face, which the generated client raises only for
 * an assembly fault (wrong arity, an unmounted method, a withdrawn
 * contribution), propagates out of the Session command unchanged and records no
 * prompt error. Carrier failures never reject: they arrive as folded results,
 * covered by session.client.spec.ts.
 */
import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { Session } from '../src/client/sessions/session.ts'
import type { SessionRemotes } from '../src/client/sessions/remotes.ts'

const SID = 'fk-s1' as SessionId
const PARENT = 'fk-parent' as SessionId

/** Every command rejects with `message`; nothing else on the face is reachable from prompt or cancel. */
function rejecting(message: string): SessionRemotes {
  const reject = (): Promise<never> => Promise.reject(new Error(message))
  return {
    $stream: () => { throw new Error('unused') },
    commands: { execute: reject },
    session: { prompt: reject, cancel: reject },
    subagents: { list: reject, prompt: reject, interruptByParent: reject },
  } as unknown as SessionRemotes
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
      parentAvailable: true,
    })
    await expect(session.prompt([{ type: 'text', text: 'x' }], 'queue')).rejects.toThrow('assembly fault')
    await expect(session.cancel()).rejects.toThrow('assembly fault')
    expect(session.getSnapshot().promptError).toBeNull()
  })
})
