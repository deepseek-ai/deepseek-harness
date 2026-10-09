/** Keyless SIGTERM regression for Agent cancellation during Web teardown. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'

it.each([
  { state: 'idle', cancelFirst: false },
  { state: 'running', cancelFirst: false },
  { state: 'idle', cancelFirst: true },
  { state: 'running', cancelFirst: true },
])('preserves Agent cleanup during Web shutdown ($state, cancel first: $cancelFirst)', { retry: 0 }, async ({ state, cancelFirst }) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-web-agent-shutdown-'))
  try {
    const patch = join(root, 'shutdown.patch.yml')
    const resultPath = join(root, 'result.json')
    const interrupt = join(root, 'interrupt')
    await writeFile(patch, [
      '- id: hmr',
      '  disabled: true',
      '- id: session-title-llm',
      '  disabled: true',
      '- insert:',
      `    - name: ${JSON.stringify(new URL('./fixtures/agent-shutdown.mjs', import.meta.url).href)}`,
      `      config: ${JSON.stringify({ root, result: resultPath, interrupt, running: state === 'running', cancelFirst })}`,
      '',
    ].join('\n'))
    const launch = resolveExampleLaunch({
      srcBin: fileURLToPath(new URL('../src/bin.ts', import.meta.url)),
      tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
      configArgs: ['--profile', 'web', '--patch', patch, '--no-open', '--port', '0'],
      env: {
        DSH_HOME: join(root, '.dsh'),
        DSH_AGENTS_HOME: join(root, '.agents'),
        DSH_TELEMETRY_DISABLED: '1',
      },
    })
    const child = execa(launch.command, launch.args, {
      cwd: root, env: launch.env, stdin: 'pipe',
      timeout: 90_000, killSignal: 'SIGKILL', reject: false,
    })
    const lines = createInterface({ input: child.stdout })
    try {
      const ready = Promise.withResolvers<undefined>()
      lines.on('line', (line) => {
        if (line === 'agent-shutdown: ready') ready.resolve(undefined)
      })
      await Promise.race([
        ready.promise,
        child.then((result) => { throw new Error(`Web exited before readiness: ${result.stderr}`) }),
      ])
      if (process.platform === 'win32') await writeFile(interrupt, '')
      else child.kill('SIGTERM')
      const result = await child
      expect(result.timedOut, result.stderr).toBe(false)
      expect(result.signal, result.stderr).toBeUndefined()
      expect(result.exitCode, result.stderr).toBe(0)
      expect(result.stderr).not.toMatch(/dsh: fatal|projection registration is not active/u)
      const evidence: unknown = JSON.parse(await readFile(resultPath, 'utf8'))
      expect(evidence).toMatchObject({
        abortHandled: 1,
        status: 'idle',
        nextStep: [],
        nextTurn: [],
        cancelled: [
          { data: { target: 'next-step', removedCount: 1 } },
          { data: { target: 'next-turn', removedCount: 1 } },
        ],
      })
      if (state === 'running') {
        expect(evidence).toMatchObject({
          lastEvent: { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: cancelFirst ? 'parent' : 'disposed' } } } },
        })
      }
    } finally {
      lines.close()
      child.kill('SIGKILL')
      await child
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
