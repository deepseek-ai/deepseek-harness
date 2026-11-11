/** The shipped cua-mcp bundle: the real CLI loads a profile that selects only this bundle and serves Computer Use programs over stdio. */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it, onTestFinished } from 'vitest'
import { clearAmbientProxyEnv } from '../../../../../scripts/test-proxy-environment.ts'
import { startProbe, type McpProbe } from './probe.ts'

const root = fileURLToPath(new URL('../../../../../', import.meta.url))
const bin = join(root, 'apps/cli/lib/bin.js')
const fixturePatch = fileURLToPath(new URL('./fixture.patch.yml', import.meta.url))
const execFileAsync = promisify(execFile)

interface CallResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
  isError?: boolean
}

function textOf(block: CallResult['content'][number] | undefined): string {
  if (block?.type !== 'text') throw new Error(`expected a text block, got ${JSON.stringify(block)}`)
  return block.text
}

describe.skipIf(!existsSync(bin))('cua-mcp profile', { retry: 0 }, () => {
  it('serves programs over stdio from a profile that selects only this bundle, and exits on EOF', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'dsh-cua-mcp-profile-'))
    const home = join(temporary, 'home')
    // The directory the client launches the server from; programs must not start there.
    const launch = join(temporary, 'launch')
    const owned: { probe?: McpProbe } = {}
    onTestFinished(async () => {
      try { await owned.probe?.terminate() } finally { await rm(temporary, { recursive: true, force: true }) }
    })
    const env: NodeJS.ProcessEnv = {
      ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: 'danger-full-access', DSH_CUA_CONSENT: 'allow',
    }
    clearAmbientProxyEnv(env)
    // The default workspace is under test, whatever the developer's shell exports.
    delete env.DSH_CUA_WORKSPACE
    await execFileAsync(process.execPath, ['-e', 'require("node:fs").mkdirSync(process.argv[1], { recursive: true })', launch])
    // The profile manifest the README documents: the installation's shipped bundle as the only layer, no pnpm step.
    const profileDir = join(home, 'profiles', 'cua-mcp')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'package.json'), `${JSON.stringify({
      name: 'dsh-profile-cua-mcp', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-cua-mcp'] } },
    }, null, 2)}\n`)

    const probe = owned.probe = startProbe({ args: [bin, '--profile', 'cua-mcp', '--patch', fixturePatch], cwd: launch, env })
    const initialized = await probe.request('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cua-mcp-e2e', version: '1' },
    }) as { serverInfo: { name: string; version: string }; instructions: string; capabilities: object }
    probe.notify('notifications/initialized')
    expect(initialized.serverInfo.name).toBe('dsh_cua')
    expect(initialized.capabilities).toMatchObject({ tools: { listChanged: false } })
    await expect(`${initialized.instructions}\n`).toMatchFileSnapshot('./expected/instructions.txt')
    const listed = await probe.request('tools/list') as { tools: { name: string }[] }
    await expect(`${JSON.stringify(listed.tools, null, 2)}\n`).toMatchFileSnapshot('./expected/tools.json')

    const reference = await probe.request('tools/call', { name: 'cua_get_api_reference', arguments: {} }) as CallResult
    expect(reference.isError).toBeUndefined()
    expect(reference.content).toHaveLength(1)
    await expect(`${textOf(reference.content[0])}\n`).toMatchFileSnapshot('./expected/reference.md')

    const first = await probe.request('tools/call', { name: 'cua_run_code', arguments: {
      code: 'globalThis.visits = 1; var app = await cua.getApp("test.fixture"); var win = await app.getWindow("7"); '
        + 'await win.getAccessibilityTree(); await win.click("0"); '
        + 'inspect(JSON.stringify({ visits, window: win.windowId, pid: process.pid, cwd: process.cwd() }), await win.getScreenshot())',
      description: 'Open the fixture window',
    } }) as CallResult
    expect(first.isError).toBeUndefined()
    expect(first.content.map(block => block.type)).toEqual(['text', 'image'])
    const state = JSON.parse(textOf(first.content[0])) as { visits: number; window: string; pid: number; cwd: string }
    expect(state).toMatchObject({ visits: 1, window: '7' })
    // Without DSH_CUA_WORKSPACE the profile creates its workspace inside the Harness home and starts programs there.
    // Both spellings are resolved: the temporary directory is a symlink on macOS and an 8.3 short name on Windows.
    const programDirectory = await realpath(state.cwd)
    expect(programDirectory).toBe(await realpath(join(home, 'cua-mcp', 'workspace')))
    expect(programDirectory).not.toBe(await realpath(launch))
    const image = first.content[1]
    if (image?.type !== 'image') throw new Error('expected an image block')
    expect(image.mimeType).toMatch(/^image\//)
    expect(Buffer.from(image.data, 'base64').length).toBeGreaterThan(0)

    const second = await probe.request('tools/call', { name: 'cua_run_code', arguments: {
      code: 'globalThis.visits++; inspect(JSON.stringify({ visits, sameWindow: win.windowId === "7", pid: process.pid }))', description: 'Count another visit',
    } }) as CallResult
    expect(second.content).toHaveLength(1)
    expect(JSON.parse(textOf(second.content[0]))).toEqual({ visits: 2, sameWindow: true, pid: state.pid })

    const reset = await probe.request('tools/call', { name: 'cua_reset', arguments: {} }) as CallResult
    expect(reset.isError).toBeUndefined()
    expect(textOf(reset.content[0])).toContain('Program environment cleared')
    const third = await probe.request('tools/call', { name: 'cua_run_code', arguments: {
      code: 'inspect(JSON.stringify({ visits: globalThis.visits ?? null, hasWindow: typeof win !== "undefined", pid: process.pid }))', description: 'Inspect the fresh environment',
    } }) as CallResult
    expect(third.content).toHaveLength(1)
    const afterReset = JSON.parse(textOf(third.content[0])) as { visits: null; hasWindow: boolean; pid: number }
    expect(afterReset).toMatchObject({ visits: null, hasWindow: false })
    expect(afterReset.pid).not.toBe(state.pid)

    expect(await probe.close()).toEqual({ code: 0, signal: null })
    expect(probe.stderr()).not.toContain('MCP startup failed')
    expect(() => process.kill(afterReset.pid, 0)).toThrow()
  })
})
