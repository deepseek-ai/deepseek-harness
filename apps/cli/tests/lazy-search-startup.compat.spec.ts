/**
 * Node 24 startup-output smoke for the shipped Web CLI composition.
 *
 * Only the dedicated Node compatibility gate opts this test in after building
 * both artifacts; ordinary Vitest inventory deterministically skips it.
 * The child runs built artifacts under plain Node with the real shipped
 * web profile (dsh-base + dsh-web-app bundle patches, auto-initialized).
 * Its URL line follows the settled profile boot; SIGTERM then exercises the
 * shipped quiescent disposer.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const builtBin = join(repoRoot, 'apps/cli/lib/bin.js')
const webDist = join(repoRoot, 'apps/web/dist/index.html')
// Full-text session search ships off (`openAt: never` on both layers): the
// base patch carries the default, and the web restatement must not re-enable it.
const baseConfigPath = join(repoRoot, 'packages/bundle/base/cordis.patch.yml')
const webConfigPath = join(repoRoot, 'packages/bundle/web-app/cordis.patch.yml')
const requireBuiltArtifacts = process.env.DSH_REQUIRE_BUILT_CLI_SMOKE === '1'

interface ConfigRow {
  id?: string
  disabled?: unknown
  config?: { openAt?: unknown }
}

interface PatchEntry extends ConfigRow {
  insert?: ConfigRow[]
}

const jsExprType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: value => String(value),
})
const configSchema = yaml.JSON_SCHEMA.extend(jsExprType)

/** Boot the built Web CLI, wait for its settled URL, then dispose through SIGTERM. */
function runBuiltWeb(cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolveRun, rejectRun) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DEEPSEEK_API_KEY: 'dsh-cli-smoke-dummy-key',
      DSH_HOME: join(cwd, '.dsh'),
    }
    delete env.DEEPSEEK_BASE_URL
    delete env.NODE_OPTIONS
    delete env.NODE_NO_WARNINGS
    const child = spawn(process.execPath, [
      builtBin,
      'web',
      '--no-open',
      '--host',
      '127.0.0.1',
      '--port',
      '0',
    ], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (!settled && /dsh web: http:\/\/127\.0\.0\.1:\d+/u.test(stdout)) {
        settled = true
        child.kill('SIGTERM')
      }
    })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectRun(new Error(`built Web CLI did not settle and dispose within 60s\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 60_000)
    child.on('error', (error) => {
      clearTimeout(timer)
      rejectRun(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (!settled) {
        rejectRun(new Error(`built Web CLI exited before settled startup (code ${String(code)})\nstdout:\n${stdout}\nstderr:\n${stderr}`))
        return
      }
      resolveRun({ stdout, stderr, code: code ?? -1 })
    })
  })
}

describe.skipIf(!requireBuiltArtifacts)('built CLI lazy-search startup', () => {
  it('boots and disposes the shipped composition with full-text search off by default', async () => {
    expect(existsSync(builtBin), `missing built CLI ${resolve(builtBin)}; run pnpm build`).toBe(true)
    expect(existsSync(webDist), `missing Web dist ${resolve(webDist)}; run pnpm run build:web`).toBe(true)
    const baseRows = (yaml.load(await readFile(baseConfigPath, 'utf8'), { schema: configSchema }) as PatchEntry[])
      .flatMap(entry => entry.insert ?? [entry])
    const webRows = (yaml.load(await readFile(webConfigPath, 'utf8'), { schema: configSchema }) as PatchEntry[])
      .flatMap(entry => entry.insert ?? [entry])
    const baseRow = baseRows.find(row => row.id === 'session-query-sqlite')
    const webRow = webRows.find(row => row.id === 'session-query-sqlite')
    expect(baseRow?.config?.openAt).toBe('never')
    expect(baseRow?.disabled).toBeUndefined()
    // The web restatement keeps the shipped default; opting in is a later layer's override.
    expect(webRow?.config?.openAt).toBe('never')
    expect(webRow?.disabled).toBeUndefined()

    const cwd = await mkdtemp(join(tmpdir(), 'dsh-cli-lazy-search-'))
    try {
      const result = await runBuiltWeb(cwd)
      expect(result.stdout).toMatch(/dsh web: http:\/\/127\.0\.0\.1:\d+/u)
      expect(result.code).toBe(0)
      expect(result.stderr).not.toMatch(/ExperimentalWarning: SQLite/u)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, 70_000)
})
