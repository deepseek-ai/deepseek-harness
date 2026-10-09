/** Exercise the published webhook example from an isolated installed Web profile. */
import { createHmac } from 'node:crypto'
import { existsSync, globSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import yaml from 'js-yaml'
import { expect, it } from 'vitest'
import { assertInstalledTree, createPackedInstallation } from './packed-installation.ts'

const root = fileURLToPath(new URL('../../../..', import.meta.url))
const adapter = '@deepseek-ai/dsh-webhook-github'
const runtime = '@deepseek-ai/dsh-webhook'
const built = existsSync(join(root, 'apps/cli/lib/bin.js'))
  && existsSync(join(root, 'packages/experimental/webhook-github/lib/index.js'))
const secret = 'packed-webhook-test-secret'

it.skipIf(!built)('loads the packed GitHub example with its explicitly installed runtime peer', {
  // Packing and installing the complete product closure owns this budget; no model request runs.
  timeout: 360_000,
  retry: 0,
}, async () => {
  const { temporary, installation, home, profile, environment, tarballs, members, externalVersions, packageCommand }
    = await createPackedInstallation('dsh-webhook-packed-', [runtime, adapter])
  Object.assign(environment, { DSH_GITHUB_WEBHOOK_SECRET: secret, DSH_GITHUB_WEBHOOK_PORT: '0' })
  expect(existsSync(join(installation, 'node_modules', runtime))).toBe(false)
  expect(existsSync(join(installation, 'node_modules', adapter))).toBe(false)
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'packed-webhook-profile', private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }))
  const profileDependencies = new Set([runtime, adapter])
  for (const name of profileDependencies) {
    const member = members.get(name)
    if (member === undefined) throw new Error(`missing packed dependency ${name}`)
    for (const [dependency, range] of Object.entries(member.manifest.dependencies as Record<string, string> | undefined ?? {})) {
      if (range.startsWith('workspace:')) profileDependencies.add(dependency)
    }
  }
  await writeFile(join(profile, 'pnpm-workspace.yaml'), yaml.dump({
    packages: ['.'], nodeLinker: 'hoisted', autoInstallPeers: false,
    overrides: {
      ...externalVersions,
      ...Object.fromEntries([...profileDependencies].map(name => [name, `file:${tarballs.get(name)!}`])),
    },
  }))
  const adapterArchive = tarballs.get(adapter)
  const runtimeArchive = tarballs.get(runtime)
  if (adapterArchive === undefined || runtimeArchive === undefined) throw new Error('webhook tarballs were not packed')
  await packageCommand(['add', runtimeArchive, adapterArchive, '--prefer-offline', '--ignore-scripts'], profile)
  const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
  expect(Object.keys(manifest.dependencies).sort()).toEqual([runtime, adapter].sort())
  await assertInstalledTree(profile)

  const example = join(profile, 'node_modules', adapter, 'examples/github-review/cordis.yml')
  expect(existsSync(example)).toBe(true)
  expect(existsSync(join(dirname(example), 'github-ready-review-rule.mjs'))).toBe(true)
  const observer = join(temporary, 'observe-ingress.mjs')
  await writeFile(observer, `export const name = 'observe-packed-ingress'
export const inject = ['webServer', 'webhookRuntime']
export function apply(ctx) {
  process.stdout.write('PACKED_WEBHOOK_READY=http://127.0.0.1:' + ctx.webServer.port + '\\n')
}
`)
  const patch = join(temporary, 'test.patch.yml')
  await writeFile(patch, yaml.dump([
    { id: 'session-telemetry-otel', disabled: true },
    { id: 'github-webhook-ingress', insert: [{ id: 'observe-packed-ingress', name: observer }] },
  ]))
  const child = execa(process.execPath, [
    join(installation, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'web', '--patch', example, '--patch', patch, '--no-open', '--port', '0',
  ], { cwd: temporary, env: environment, extendEnv: false, reject: false, timeout: 90_000 })
  try {
    const ready = new Promise<string>((resolveReady, rejectReady) => {
      let output = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString()
        const origin = /PACKED_WEBHOOK_READY=(http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1]
        if (origin !== undefined && output.includes('dsh web: ')) resolveReady(origin)
      })
      void child.then((result) => {
        rejectReady(new Error(`Web profile exited before readiness:\n${result.stdout}\n${result.stderr}`))
      })
    })
    const origin = await ready
    expect((await fetch(`${origin}/api`, { signal: AbortSignal.timeout(10_000) })).status).toBe(404)
    const body = JSON.stringify({ zen: 'A signed ping does not start an Agent.' })
    const response = await fetch(`${origin}/github`, {
      method: 'POST', body, signal: AbortSignal.timeout(10_000),
      headers: {
        'content-type': 'application/json', 'x-github-event': 'ping', 'x-github-delivery': 'packed-ping',
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
      },
    })
    expect(response.status, await response.text()).toBe(202)
  } finally {
    child.kill('SIGTERM')
    const result = await child
    expect(result.timedOut, `${result.stdout}\n${result.stderr}`).toBe(false)
    expect(result.exitCode === 0 || result.signal === 'SIGTERM', result.stderr).toBe(true)
  }
  expect(globSync('sessions/**/*.jsonl*', { cwd: home })).toEqual([])
})
