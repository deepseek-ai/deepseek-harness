/** Directory collaborator for consumer-only tests with structural Agent stubs. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'

/**
 * Supply fixed directory values without filesystem checks or durable changes.
 * The workspace root equals the directory, which is the Session's only anchor; a Session without a
 * recorded directory has no anchor, so consumers fall back as they do with the real service.
 * @param ctx - context owning this test collaborator.
 * @param defaultDirectory - fallback for fixtures without a Session directory.
 */
export function provideWorkingDirectoryFixture(ctx: Context, defaultDirectory = process.cwd()): void {
  const get = (session: Session): string => session.header.cwd ?? defaultDirectory
  ctx.provide('workingDirectory', {
    defaultDirectory,
    get,
    rootOf: get,
    anchorsOf: (session: Session): readonly string[] => session.header.cwd === undefined ? [] : [get(session)],
    ensure: (agent: Agent): Promise<string> => Promise.resolve(get(agent.session)),
  })
}
