/** Replace only the external SDK; the harness selects source or built provider code. */
import { registerHooks } from 'node:module'

export const name = 'computer-use-native-fixture'
export const inject = ['computerUse', 'tools', 'systemPrompt']

export async function apply(ctx) {
  const fixture = new URL('../../../packages/experimental/computer-use-cua-driver-native/tests/fixtures/cua-driver.ts', import.meta.url).href
  ctx.effect(() => {
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        return specifier === '@trycua/cua-driver'
          ? { url: fixture, shortCircuit: true }
          : nextResolve(specifier, context)
      },
    })
    return () => hooks.deregister()
  }, 'computer-use-native-fixture.module')
  const provider = await import('@deepseek-ai/dsh-experimental-computer-use-cua-driver-native')
  await ctx.plugin(provider)
}
