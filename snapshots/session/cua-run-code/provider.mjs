/** Real CUA registration with an isolated fixture at the native byte-stream boundary. */
import { CuaConfig, installCua } from '@deepseek-ai/dsh-cua'
import { COMMON_GUIDANCE } from '@deepseek-ai/dsh-cua/guidance'
import { createNativeFixture } from './native-channel.mjs'

export const name = 'cua-run-code-fixture'
export const inject = ['computerUse', 'tools', 'systemPrompt', 'subprocess', 'agents']
export const Config = CuaConfig

/** @param {import('@deepseek-ai/cordis').Context} ctx @param {import('@deepseek-ai/dsh-cua').CuaConfig} config */
export function apply(ctx, config) {
  const fixture = createNativeFixture()
  installCua(ctx, config, {
    helperPath: process.execPath,
    createChannel: fixture.createChannel,
    getGuidance: () => COMMON_GUIDANCE,
    capabilities: { platform: 'macos', methods: ['getCapabilities', 'getApp', 'getState', 'click', 'screenshot'],
      appLevelAccessibility: true, keyboard: ['app'], browser: false, coordinateSpace: 'screenshot-pixels' },
    permissionParameters: (_method, permission, locale) => ({ permission, locale }),
  })
}
