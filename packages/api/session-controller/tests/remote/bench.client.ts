/** Session objects owned by a client test's explicitly started Gateway assembly. */
import { onTestFinished } from 'vitest'
import type { RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import type { TestClient } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Session, type SessionOptions } from '../../src/client/sessions/session.ts'
import { sessionWorld } from './session.client.ts'

/**
 * Create a Session after installing its default Remote responses.
 * @param mock - this case's Remote responses.
 * @param start - the fixture's lazy client startup.
 * @param sessionId - Session identity.
 * @param options - addressed child and parent availability, when applicable.
 * @returns the Session, disposed at the end of the case.
 */
export async function sessionBench(
  mock: RemoteMock,
  start: () => Promise<TestClient>,
  sessionId: SessionId,
  options: SessionOptions = {},
): Promise<Session> {
  mock.load(sessionWorld)
  const client = await start()
  const session = new Session(sessionId, client.ctx.remote, options)
  onTestFinished(() => session.dispose())
  return session
}
