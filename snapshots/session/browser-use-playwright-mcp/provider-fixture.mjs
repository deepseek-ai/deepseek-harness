/** Replace only the external MCP executable; retain the shipped provider and browser runtime. */
import { registerHooks } from 'node:module'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

export const name = 'browser-provider-fixture'
export const inject = ['browserUse', 'agents', 'tools']

export async function apply(ctx) {
  let replaced = false
  ctx.effect(() => {
    const hooks = registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier !== '@playwright/mcp/package.json') return nextResolve(specifier, context)
        replaced = true
        return { url: pathToFileURL(resolve('package.json')).href, shortCircuit: true }
      },
    })
    return () => hooks.deregister()
  }, 'browser-fixture.executable')
  const provider = await import('@deepseek-ai/dsh-experimental-browser-use-playwright-mcp')
  await ctx.plugin(provider, { mode: 'launch' })
  if (!replaced) throw new Error('Playwright snapshot did not replace the upstream executable')
  ctx.on('agent/pre-step', async (_payload, next) => {
    if (await readFile(resolve('.dsh/browser-fixture.started'), 'utf8') !== 'playwright-mcp\n') {
      throw new Error('Playwright snapshot did not start its fixture process')
    }
    return next()
  })
}
