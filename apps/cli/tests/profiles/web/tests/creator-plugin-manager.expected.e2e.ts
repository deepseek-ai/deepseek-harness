/** Built Web profile: MCP reaches existing/new Creator sessions and survives a process restart. */
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { readProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { startHttpMcpFixture } from '../../../../../../packages/mcp/mcp-client/tests/http-fixture.ts'

interface Observation {
  approvals: string[]
  permission: string
  before: string[]
  denied: { isError: boolean; content: unknown }
  afterDenied: string[]
  bundlesAfterDenied: { name: string }[]
  after: string[]
  other: string[]
  remaining: string[]
  result: unknown
  ping: unknown
  removed?: unknown
}

const repo = fileURLToPath(new URL('../../../../../../', import.meta.url))

it('configures MCP on a live profile, restores it on restart, and removes its tools', async (test) => {
  const root = await mkdtemp(join(tmpdir(), 'creator-manager-'))
  test.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const mcp = await startHttpMcpFixture()
  test.onTestFinished(mcp.close)
  await mkdir(join(root, 'workspace'))
  const bundle = join(root, 'demo-mcp')
  await mkdir(bundle)
  await writeFile(join(bundle, 'package.json'), JSON.stringify({ name: '@test/creator-mcp', version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'demo',
    name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'demo', transport: 'streamable-http',
      url: mcp.url, failOnStartupError: true },
  }] }]))
  const patch = join(root, 'test.patch.yml')
  await writeFile(patch, JSON.stringify([{ insert: [{ id: 'creator-manager-observer',
    name: new URL('./fixtures/creator-plugin-manager.mjs', import.meta.url).href, config: { bundle },
  }] }]))
  const start = async () => {
    const child = spawn(process.execPath, [join(repo, 'apps/cli/lib/bin.js'), '--profile', 'web', '--patch', patch,
      '--port', '0', '--no-open'], { cwd: join(root, 'workspace'),
      env: { ...process.env, DSH_HOME: join(root, 'home'), DSH_AGENTS_HOME: join(root, 'agents'),
        DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: 'keyless-no-model-calls' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    let output = ''
    const completion = new Promise<void>((resolve, reject) => {
      child.once('close', () => { resolve() })
      child.once('error', reject)
    })
    const stop = async () => { if (child.exitCode === null) child.kill('SIGTERM'); await completion }
    test.onTestFinished(stop)
    for (const stream of [child.stdout, child.stderr]) stream!.on('data', (data) => { output = (output + String(data)).slice(-30_000) })
    await expect.poll(() => {
      if (child.exitCode !== null) throw new Error(output)
      return output.includes('dsh web: http://')
    }, { timeout: 60_000 }).toBe(true)
    return { stop, request: (phase: string): Promise<Observation> => new Promise((resolve, reject) => {
      child.once('message', (value: { result: Observation; error?: string }) => {
        if (value.error !== undefined) reject(new Error(value.error))
        else resolve(value.result)
      })
      child.send(phase)
    }) }
  }
  const first = await start()
  const initial = await first.request('initial')
  expect(initial.before).toContain('plugin_manager')
  for (const retired of ['cordis_define', 'cordis_run', 'cordis_stop', 'cordis_undefine', 'cordis_inspect_self']) {
    expect(initial.before).not.toContain(retired)
  }
  expect(initial.before).not.toContain('mcp__demo__ping')
  expect(initial.denied.isError).toBe(true)
  expect(JSON.stringify(initial.denied.content)).toContain('the user rejected escalating')
  expect(initial.afterDenied).toEqual(initial.before)
  expect(initial.bundlesAfterDenied.map(bundle => bundle.name)).not.toContain('@test/creator-mcp')
  expect(initial.approvals).toEqual(['rejected', 'allowed-once'])
  expect(initial.permission).toBe('workspace-write')
  expect(initial.result).toMatchObject({ application: 'applied', changed: true })
  expect(initial.after).toContain('mcp__demo__ping')
  expect(initial.other).toContain('mcp__demo__ping')
  expect(JSON.stringify(initial.ping)).toContain('pong')
  const saved = readProfileManifest('dsh', join(root, 'home/profiles/web'))
  expect(saved.dsh?.profile?.bundles).toContain('@test/creator-mcp')
  expect(saved.dependencies).toHaveProperty('@test/creator-mcp')
  await first.stop()
  const second = await start()
  const restarted = await second.request('restart')
  expect(restarted.result).toEqual(expect.arrayContaining([expect.objectContaining({ name: '@test/creator-mcp' })]))
  expect(restarted.approvals).toEqual(['rejected', 'allowed-once'])
  expect(restarted.permission).toBe('workspace-write')
  expect(restarted.before).toContain('mcp__demo__ping')
  expect(JSON.stringify(restarted.ping)).toContain('pong')
  expect(restarted.removed).toMatchObject({ application: 'applied', changed: true })
  expect(restarted.remaining).not.toContain('mcp__demo__ping')
  expect(mcp.calls).toEqual(['ping', 'ping'])
  await second.stop()
})
