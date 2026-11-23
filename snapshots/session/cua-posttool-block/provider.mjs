/** This policy scenario holds native confirmation until the model has received the final tool error. */
import { installFixture } from '../cua-run-code/provider.mjs'
import { createNativeFixture } from '../cua-run-code/native-channel.mjs'
export { Config, inject, name } from '../cua-run-code/provider.mjs'

/** @param {import('@deepseek-ai/cordis').Context} ctx @param {import('@deepseek-ai/dsh-cua').CuaConfig} config */
export function apply(ctx, config) {
  const fixture = createNativeFixture()
  const release = fixture.controlNext('releaseHeldInputs')
  const remove = ctx.on('session/event', (_session, event) => {
    if (event.type !== 'turn/end') return
    remove()
    release.reply()
  })
  installFixture(ctx, config, fixture)
}
