/** Real CUA registration with an isolated fixture at the native byte-stream boundary. */
import Schema from '@deepseek-ai/schemastery'
import { installCua } from '@deepseek-ai/dsh-cua'
import { CuaConfigFields } from '@deepseek-ai/dsh-cua/config'
import { COMMON_GUIDANCE } from '@deepseek-ai/dsh-cua/guidance'
import { createNativeFixture } from './native-channel.mjs'

export const name = 'cua-run-code-fixture'
export const inject = ['computerUse', 'tools', 'systemPrompt', 'subprocess', 'agents']
export const Config = Schema.object({ ...CuaConfigFields, confirmReleaseAtTurnEnd: Schema.boolean().default(false) })

/** @param {import('@deepseek-ai/cordis').Context} ctx @param {import('@deepseek-ai/dsh-cua').CuaConfig & { confirmReleaseAtTurnEnd: boolean }} config */
export function apply(ctx, { confirmReleaseAtTurnEnd, ...config }) {
  const fixture = createNativeFixture()
  if (confirmReleaseAtTurnEnd) {
    const release = fixture.controlNext('releaseHeldInputs')
    const remove = ctx.on('session/event', (_session, event) => {
      if (event.type !== 'turn/end') return
      remove()
      release.reply()
    })
  }
  installCua(ctx, config, {
    helperPath: process.execPath,
    heldInputState: true,
    createChannel: fixture.createChannel,
    getGuidance: () => COMMON_GUIDANCE,
    capabilities: { platform: 'macos', methods: ['getCapabilities', 'getApp', 'getState', 'click', 'screenshot', 'sendKeyEvent', 'toggleMouse'],
      appLevelAccessibility: true, keyboard: ['app'], browser: false, coordinateSpace: 'screenshot-pixels' },
    permissionParameters: (_method, permission, locale) => ({ permission, locale }),
  })
}
