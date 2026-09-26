/** Built Web-profile acceptance for best-effort initial plugin activation. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../../../../', import.meta.url))
const dshBin = join(repoRoot, 'apps/cli/lib/bin.js')
const frontendIndex = join(repoRoot, 'apps/web/dist/index.html')
const builtArtifactsExist = existsSync(dshBin) && existsSync(frontendIndex)

interface Fixture {
  root: string
  home: string
  patch: string
  events: string
  stop: string
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-web-best-effort-'))
  const home = join(root, 'home')
  const events = join(root, 'events.log')
  const stop = join(root, 'stop')
  mkdirSync(home)
  writeFileSync(events, '')
  writeFileSync(join(root, 'good.mjs'), [
    "import { appendFileSync, existsSync } from 'node:fs'",
    'export function apply(ctx, config) {',
    "  appendFileSync(config.events, 'good apply\\n')",
    '  let stopping = false',
    '  const watcher = setInterval(() => {',
    '    if (stopping || !existsSync(config.stop)) return',
    '    stopping = true',
    "    process.emit('SIGTERM')",
    '  }, 20)',
    '  ctx.effect(() => () => {',
    '    clearInterval(watcher)',
    "    appendFileSync(config.events, 'good dispose\\n')",
    '  })',
    '}',
    '',
  ].join('\n'))
  writeFileSync(join(root, 'sync-failure.mjs'), 'export function apply() { throw new Error("web sync apply failure") }\n')
  writeFileSync(join(root, 'async-failure.mjs'), [
    'export async function apply() {',
    '  await Promise.resolve()',
    '  throw new Error("web async apply failure")',
    '}',
    '',
  ].join('\n'))
  writeFileSync(join(root, 'pending.mjs'), [
    "export const inject = ['webProbeMissingService']",
    'export function apply() {}',
    '',
  ].join('\n'))
  const patch = join(root, 'failures.patch.yml')
  writeFileSync(patch, [
    '- id: tool-todo',
    '  disabled: false',
    '  config: {}',
    '- insert:',
    '    - id: web-probe-good',
    `      name: ${pathToFileURL(join(root, 'good.mjs')).href}`,
    '      config:',
    `        events: ${JSON.stringify(events)}`,
    `        stop: ${JSON.stringify(stop)}`,
    '    - id: web-probe-import-failure',
    `      name: ${pathToFileURL(join(root, 'missing.mjs')).href}`,
    '    - id: web-probe-sync-failure',
    `      name: ${pathToFileURL(join(root, 'sync-failure.mjs')).href}`,
    '    - id: web-probe-async-failure',
    `      name: ${pathToFileURL(join(root, 'async-failure.mjs')).href}`,
    '    - id: web-probe-pending',
    `      name: ${pathToFileURL(join(root, 'pending.mjs')).href}`,
    '    - id: web-probe-disabled-failure',
    `      name: ${pathToFileURL(join(root, 'good.mjs')).href}`,
    '      disabled: !!js "JSON.parse(\'invalid\')"',
    '',
  ].join('\n'))
  return { root, home, patch, events, stop }
}

async function waitForStartup(
  stdout: Readable | null,
  stderr: Readable | null,
  completion: PromiseLike<{ exitCode?: number }>,
): Promise<{ url: string; stderr: string }> {
  if (stdout === null || stderr === null) throw new Error('Web child pipes are unavailable')
  stdout.setEncoding('utf8')
  stderr.setEncoding('utf8')
  let stdoutText = ''
  let stderrText = ''
  let url: string | undefined
  const ready = Promise.withResolvers<{ url: string; stderr: string }>()
  let settled = false
  const finish = (): void => {
    if (settled || url === undefined) return
    if (!stderrText.includes('dsh: warning: 6 entries did not activate')) return
    if (!stderrText.includes('web async apply failure')) return
    if (!stderrText.includes('webProbeMissingService')) return
    settled = true
    clearTimeout(timer)
    ready.resolve({ url, stderr: stderrText })
  }
  stdout.on('data', (chunk: string) => {
    stdoutText += chunk
    url ??= /dsh web: (http:\/\/[^\s]+)/u.exec(stdoutText)?.[1]
    finish()
  })
  stderr.on('data', (chunk: string) => {
    stderrText += chunk
    finish()
  })
  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    ready.reject(new Error(`Web profile did not report ready and failed entries\nstdout:\n${stdoutText}\nstderr:\n${stderrText}`))
  }, 60_000)
  void completion.then((result) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    ready.reject(new Error(`Web profile exited before readiness (code ${String(result.exitCode)})\nstdout:\n${stdoutText}\nstderr:\n${stderrText}`))
  })
  return ready.promise
}

describe.skipIf(!builtArtifactsExist)('dsh Web profile best-effort startup', () => {
  it('serves the full Web app while unrelated entries fail to start', async () => {
    const fixture = createFixture()
    const child = execa(process.execPath, [
      dshBin,
      '--profile', 'web',
      '--patch', fixture.patch,
      '--no-open',
      '--port', '0',
    ], {
      cwd: fixture.root,
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: 'keyless-web-best-effort-no-call',
        DSH_AGENTS_HOME: join(fixture.root, '.agents'),
        DSH_HOME: fixture.home,
        DSH_TELEMETRY_DISABLED: '1',
        NODE_NO_WARNINGS: '1',
      },
      input: '',
      reject: false,
      timeout: 90_000,
      killSignal: 'SIGKILL',
    })

    let result: Awaited<typeof child>
    let events = ''
    try {
      const startup = await waitForStartup(child.stdout, child.stderr, child)
      const auth = await fetch(startup.url, { redirect: 'manual' })
      const cookie = auth.headers.get('set-cookie')?.split(';', 1)[0]
      if (cookie === undefined) throw new Error('Web authentication response did not set a cookie')
      const page = await fetch(new URL('/', startup.url), { headers: { cookie } })
      const html = await page.text()
      expect(html).toContain('<div id="root"></div>')
      expect(html).toContain('__DSH_BOOT__')
      expect(readFileSync(fixture.events, 'utf8')).toBe('good apply\n')
      expect(startup.stderr).toContain('web-probe-import-failure')
      expect(startup.stderr).toContain('@deepseek-ai/dsh-tool-todo')
      expect(startup.stderr).toContain('web sync apply failure')
      expect(startup.stderr).toContain('web async apply failure')
      expect(startup.stderr).toContain('pending (waiting for service: webProbeMissingService)')
      expect(startup.stderr).toContain('web-probe-disabled-failure')
      expect(startup.stderr).toContain('disabled expression failed: SyntaxError')
    } finally {
      writeFileSync(fixture.stop, 'stop')
      result = await child
      events = readFileSync(fixture.events, 'utf8')
      rmSync(fixture.root, { recursive: true, force: true })
    }

    expect(result.signal).toBeUndefined()
    expect({
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      events,
    }).toMatchInlineSnapshot(`
      {
        "events": "good apply
      good dispose
      ",
        "exitCode": 0,
        "timedOut": false,
      }
    `)
  })

  it.each([
    ['modules', 'missing dependency'],
    ['connection', 'missing dependency'],
    ['modules', 'disabled expression'],
    ['connection', 'disabled expression'],
  ])('fails the full Web profile on required %s %s failure', async (id, failure) => {
    const fixture = createFixture()
    const patch = failure === 'disabled expression'
      ? 'disabled: !!js "JSON.parse(\'invalid\')"'
      : 'inject: [webProbeMissingRequiredService]'
    const diagnostic = failure === 'disabled expression'
      ? 'disabled expression failed: SyntaxError'
      : 'webProbeMissingRequiredService'
    writeFileSync(fixture.patch, `${readFileSync(fixture.patch, 'utf8')}- id: ${id}\n  ${patch}\n`)
    try {
      const result = await execa(process.execPath, [
        dshBin,
        '--profile', 'web',
        '--patch', fixture.patch,
        '--no-open',
        '--port', '0',
      ], {
        cwd: fixture.root,
        env: {
          ...process.env,
          DEEPSEEK_API_KEY: 'keyless-web-required-no-call',
          DSH_AGENTS_HOME: join(fixture.root, '.agents'),
          DSH_HOME: fixture.home,
          DSH_TELEMETRY_DISABLED: '1',
          NODE_NO_WARNINGS: '1',
        },
        input: '',
        reject: false,
        timeout: 90_000,
        killSignal: 'SIGKILL',
      })
      expect(result.timedOut).toBe(false)
      expect(result.signal).toBeUndefined()
      expect(result.exitCode).toBe(1)
      expect(result.stdout).not.toContain('dsh web: http://')
      expect(result.stderr).toContain('startup failed:')
      expect(result.stderr).toContain(`${id} (required)`)
      expect(result.stderr).toContain(diagnostic)
      expect(readFileSync(fixture.events, 'utf8')).toBe('good apply\ngood dispose\n')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it.each([false, true])('fails the full Web profile when its required HTTP server cannot bind (logs blocked: %s)', async (logsBlocked) => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-web-required-bind-'))
    const home = join(root, 'home')
    mkdirSync(home)
    if (logsBlocked) writeFileSync(join(home, 'logs'), 'blocked')
    const blocker = createServer()
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error): void => { reject(error) }
      blocker.once('error', fail)
      blocker.listen(0, '127.0.0.1', () => {
        blocker.off('error', fail)
        resolve()
      })
    })
    const address = blocker.address()
    if (address === null || typeof address === 'string') {
      throw new Error('port blocker did not bind a TCP address')
    }

    try {
      const result = await execa(process.execPath, [
        dshBin,
        '--profile', 'web',
        '--no-open',
        '--port', String(address.port),
      ], {
        cwd: root,
        env: {
          ...process.env,
          DEEPSEEK_API_KEY: 'keyless-web-required-bind-no-call',
          DSH_AGENTS_HOME: join(root, '.agents'),
          DSH_HOME: home,
          DSH_TELEMETRY_DISABLED: '1',
          NODE_NO_WARNINGS: '1',
        },
        input: '',
        reject: false,
        timeout: 90_000,
        killSignal: 'SIGKILL',
      })
      expect(result.timedOut).toBe(false)
      expect(result.signal).toBeUndefined()
      expect(result.exitCode).toBe(1)
      expect(result.stdout).not.toContain('dsh web: http://')
      expect(result.stderr).toContain('startup failed:')
      expect(result.stderr).toContain('dsh: startup failed: 2 required plugins did not activate')
      expect(result.stderr).toContain('Failed plugins (1):')
      expect(result.stderr).toContain('  webserver (required)\n    Package: @deepseek-ai/dsh-host-webserver')
      expect(result.stderr).toContain('Plugins waiting for services (')
      expect(result.stderr).toMatch(/connection \(required\) +webRuntime/u)
      expect(result.stderr).toContain('at Server.setupListenHandle')
      const summary = result.stderr.split(/\n\n(?:Full diagnostics:|dsh: warning:)/u)[0]!
      expect(summary.match(/EADDRINUSE/gu)).toHaveLength(1)
      expect(summary).not.toMatch(/dsh: warning:|\[cause\]|at boot \(|at runCli \(|Node\.js v/u)
      let report: string
      if (logsBlocked) {
        expect(result.stderr).toContain('dsh: warning: could not write startup diagnostics:')
        expect(result.stderr).not.toMatch(/Full diagnostics: [^\r\n]/u)
        report = result.stderr.split('Full diagnostics:\n')[1]!
        expect(readFileSync(join(home, 'logs'), 'utf8')).toBe('blocked')
      } else {
        const path = /Full diagnostics: ([^\r\n]+)/u.exec(result.stderr)?.[1]
        expect(path).toBeDefined()
        expect(dirname(path!)).toBe(join(home, 'logs'))
        report = readFileSync(path!, 'utf8')
      }
      expect(report).toContain("profile: 'web'")
      expect(report).toContain('nodeVersion:')
      expect(report).toContain('dshVersion:')
      expect(report).toContain('configurationPath:')
      expect(report).toContain("code: 'EADDRINUSE'")
      expect(report).toContain(`port: ${String(address.port)}`)
      expect(report).toContain("module: '@deepseek-ai/dsh-client-connection'")
      expect(report).toContain('at auditStartupEntries')
    } finally {
      await new Promise<void>((resolve, reject) => {
        blocker.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails and cleans up when detached work rejects after application startup', async () => {
    const fixture = createFixture()
    const plugin = join(fixture.root, 'detached.mjs')
    writeFileSync(plugin, [
      'export function apply(ctx) {',
      '  ctx.effect(() => ctx.get("appReady").onReady(() => {',
      '    void Promise.reject(new Error("detached Web failure"))',
      '  }))',
      '}',
      '',
    ].join('\n'))
    writeFileSync(fixture.patch, readFileSync(fixture.patch, 'utf8') + [
      '- insert:',
      '    - id: detached-probe',
      `      name: ${pathToFileURL(plugin).href}`,
      '',
    ].join('\n'))
    try {
      const result = await execa(process.execPath, [
        dshBin,
        '--profile', 'web',
        '--patch', fixture.patch,
        '--no-open',
        '--port', '0',
      ], {
        cwd: fixture.root,
        env: {
          ...process.env,
          DEEPSEEK_API_KEY: 'keyless-web-detached-no-call',
          DSH_AGENTS_HOME: join(fixture.root, '.agents'),
          DSH_HOME: fixture.home,
          DSH_TELEMETRY_DISABLED: '1',
          NODE_NO_WARNINGS: '1',
        },
        input: '',
        reject: false,
        timeout: 90_000,
        killSignal: 'SIGKILL',
      })
      expect(result.timedOut).toBe(false)
      expect(result.signal).toBeUndefined()
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('fatal load failure: Error: detached Web failure')
      expect(readFileSync(fixture.events, 'utf8')).toBe('good apply\ngood dispose\n')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })
})
