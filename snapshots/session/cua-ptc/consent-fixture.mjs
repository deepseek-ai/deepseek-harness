/** Own a private native substitute for the PTC result replay. */
import { chmod, copyFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startFixtureHost } from '../cua-native/fixture-host.mjs'
export const name = 'cua-ptc-fixture'
export const inject = ['userQuestions']

/** Prepare the helper and retire its service before removing the private executable. */
export async function apply(ctx) {
  const helper = join(process.cwd(), 'native-helper.mjs')
  await copyFile(new URL('../cua-native/workspace/native-helper.mjs', import.meta.url), helper)
  await chmod(helper, 0o700)
  const bridge = join(process.cwd(), 'cua-bridge.mjs')
  await writeFile(bridge, `export { connectCua } from ${JSON.stringify(import.meta.resolve('@deepseek-ai/dsh-cua/bridge'))};\n`)
  const close = await startFixtureHost(helper)
  ctx.effect(() => async () => {
    try { await close() } finally { await Promise.all([unlink(helper), unlink(bridge)]) }
  })
  ctx.on('user-questions/request', async request => ({ answers: request.questions.map(question => ({
    id: question.id, selected: ['Allow for this task'],
  })) }))
}
