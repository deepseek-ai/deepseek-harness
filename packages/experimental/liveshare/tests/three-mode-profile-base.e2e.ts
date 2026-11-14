/**
 * Minimal real-profile base for the three-mode acceptance driver.
 *
 * A normal `dsh` profile starts with real Session, controller, Agent, permissions and file tools in
 * a private temp home; one completed turn runs through that pipeline with a deterministic keyless
 * model, and the real `write` tool must have created a file inside the run's workspace before every
 * resource is reclaimed. Only the model is a fixture: execution, authorization, the controller and
 * the tools are the shipped ones, under the default permission configuration.
 *
 * The mode cases (view / write, prefix selection, narrowing, out-of-scope files)
 * attach on top of this base and are not claimed here.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'

const dshBinScript = fileURLToPath(new URL('../../../../apps/cli/src/bin.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))
const fixturePlugin = pathToFileURL(fileURLToPath(new URL('./fixtures/base-llm.mjs', import.meta.url))).href

/** One `dsh` run against the private home; the model is the only fixture. */
async function run(cwd: string, home: string, args: readonly string[]) {
  const launch = resolveExampleLaunch({
    srcBin: dshBinScript,
    configArgs: ['--profile', 'headless', ...args],
    tsconfigPath,
    // Source diagnostics use the hook the launch contract names; artifact acceptance uses built lib.
    sourceImport: 'tsx/esm',
    env: {
      DSH_HOME: home,
      DSH_AGENTS_HOME: join(cwd, '.agents'),
      DSH_TELEMETRY_DISABLED: '1',
      DEEPSEEK_API_KEY: '',
      NODE_OPTIONS: [
        process.env.NODE_OPTIONS,
        '--disable-warning=ExperimentalWarning',
        '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      ].filter(Boolean).join(' '),
    },
  })
  return await execa(launch.command, launch.args, {
    cwd,
    env: launch.env,
    input: '',
    timeout: 120_000,
    killSignal: 'SIGKILL',
    reject: false,
  })
}

/** Sanitized session facts: event types, tool names, and whether the target file exists. */
async function observe(sessions: string, cwd: string) {
  const files = (await readdir(sessions, { recursive: true })).filter(file => file.endsWith('.jsonl'))
  const records = files.length === 0
    ? []
    : (await readFile(join(sessions, files[0]!), 'utf8')).split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as {
        type?: string
        sessionId?: string
        data?: unknown
        id?: string
        parentSession?: string
      })
  const target = await stat(join(cwd, 'note.txt')).then(() => true, () => false)
  // The physical header line carries `id`; a session without `parentSession` is the root one.
  const headers = records.filter(record => record.type === 'session')
  return {
    files,
    records,
    eventTypes: records.map(record => record.type),
    toolNames: records.filter(record => record.type === 'tool/call')
      .map(record => (record.data as { name?: string } | undefined)?.name),
    targetWritten: target,
    rootSessionId: headers.find(header => header.parentSession === undefined)?.id,
  }
}

describe('three-mode acceptance: real-profile base', () => {
  it('completes one real turn, writes through the real tool, and reclaims the workspace', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'liveshare-profile-'))
    try {
      const home = join(cwd, '.dsh')
      const sessions = join(home, 'sessions')
      const profileDir = join(home, 'profiles', 'headless')
      await mkdir(profileDir, { recursive: true })
      await writeFile(join(profileDir, 'package.json'), JSON.stringify({
        name: 'dsh-profile-headless',
        private: true,
        dependencies: { '@deepseek-ai/dsh-experimental-liveshare': 'workspace:^' },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
      }, undefined, 2) + '\n')
      await writeFile(join(profileDir, 'cordis.patch.yml'), [
        '- id: llm-deepseek',
        '  disabled: true',
        '- id: session-persistence-jsonl',
        '  config:',
        `    root: '${sessions}'`,
        '    compression: none',
        '- insert:',
        '    - id: base-fixture-llm',
        `      name: '${fixturePlugin}'`,
        '',
      ].join('\n'))

      const first = await run(cwd, home, ['写一个 note.txt'])
      const after = await observe(sessions, cwd)
      const seen = `timedOut=${String(first.timedOut)} signal=${String(first.signal)} exit=${String(first.exitCode)}`
        + `\nstdout:\n${first.stdout}\nstderr:\n${first.stderr}`
        + `\nevents=${after.eventTypes.join(',')}\ntools=${after.toolNames.join(',')}`
        + `\ntargetWritten=${String(after.targetWritten)}`
      // The three process facts are asserted separately: a timeout is not an exit code.
      expect(first.timedOut, seen).toBe(false)
      expect(first.signal, seen).toBeUndefined()
      expect(first.exitCode, seen).toBe(0)
      expect(first.stdout).toContain('BASE_TURN_2')
      expect(after.toolNames).toContain('write')
      expect(after.targetWritten, seen).toBe(true)
      expect(await readFile(join(cwd, 'note.txt'), 'utf8')).toContain('hello from the real write tool')

      // A second user turn needs this CLI's real continuation mechanism; `--resume` is not an
      // option here, so the base claims one real turn plus the real tool side effect only.
      expect(typeof after.rootSessionId, seen).toBe('string')
      expect(after.eventTypes).toContain('user/message')
    } finally {
      // Every resource this case owns lives under `cwd`: private home, profile, workspace, logs.
      await rm(cwd, { recursive: true, force: true })
    }
  }, 300_000)
})
