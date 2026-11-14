/** Read persisted histories through the installed profile's persistence service. */
import { writeFile } from 'node:fs/promises'

/** Private profile reader label. */
export const name = 'python-sdk-session-reader'
/** Persistence must be mounted before this fixture reads histories. */
export const inject = ['sessionPersistence']

/**
 * Write complete logical histories after the SDK profile mounts persistence.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Installed SDK profile services.
 * @param {{ output: string }} config - Private JSON output file.
 */
export async function apply(ctx, config) {
  const sessions = {}
  for (const snapshot of await ctx.sessionPersistence.list()) {
    const handle = await ctx.sessionPersistence.open(snapshot.header.id, 'read')
    try {
      const { events } = await handle.read()
      sessions[handle.header.id] = [{ type: 'session', ...handle.header }, ...events]
    } finally {
      await handle.close()
    }
  }
  await writeFile(config.output, JSON.stringify(sessions), { mode: 0o600 })
}
