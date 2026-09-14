/** Failure policy through the built Web process and native configuration watcher. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { FiberState } from '@deepseek-ai/cordis'

const repoRoot = fileURLToPath(new URL('../../../../../../', import.meta.url))
const bin = join(repoRoot, 'apps/cli/lib/bin.js')
const built = existsSync(bin) && existsSync(join(repoRoot, 'apps/web/dist/index.html'))
const failures = [
  ['import', 'missing.mjs'],
  ['module evaluation', 'matrix module evaluation'],
  ['schema', 'matrix schema failure'],
  ['config expression', 'matrix config expression'],
  ['disabled expression', 'matrix disabled expression'],
  ['sync apply', 'matrix sync apply'],
  ['async apply', 'matrix async apply'],
  ['dependency', 'matrixMissingService'],
] as const
type Failure = typeof failures[number][0]

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-web-failure-matrix-'))
  const home = join(root, 'home')
  mkdirSync(home)
  const events = join(root, 'events')
  const diagnostics = join(root, 'diagnostics')
  const serverUrl = join(root, 'server-url')
  const states = join(root, 'states')
  const stop = join(root, 'stop')
  const patch = join(home, 'cordis.patch.yml')
  const watcher = join(root, 'watcher.patch.yml')
  // Native delivery remains real; completed writes bypass Chokidar's 50 ms change suppression.
  writeFileSync(watcher, JSON.stringify([{ id: 'hmr', disabled: false, config: {
    root: [], awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
  } }]) + '\n')
  writeFileSync(events, '')
  writeFileSync(diagnostics, '')
  writeFileSync(states, '{}')
  const observerPath = join(root, 'observer.mjs')
  // HMR reports through Cordis logger exporters; WARN is above their default INFO threshold.
  writeFileSync(observerPath, [
    "import { appendFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'",
    "import { inspect } from 'node:util'",
    'export function apply(ctx, config) {',
    '  const report = message => appendFileSync(config.path, message.args.map(arg => inspect(arg)).join(" ") + "\\n")',
    '  ctx.logger.buffer.forEach(report)',
    '  ctx.logger.exporter({ levels: { default: 3 }, export: report })',
    '  const timer = setInterval(() => {',
    '    const loader = ctx.get("loader")',
    '    if (!loader) return',
    '    writeFileSync(config.states + ".tmp", JSON.stringify(Object.fromEntries([...loader.entries()].map(entry => [entry.options.id, entry.fiber?.state]))))',
    '    renameSync(config.states + ".tmp", config.states)',
    '  }, 20)',
    '  ctx.effect(() => () => { clearInterval(timer) })',
    '  ctx.inject(["webServer", "connection"], scope => {',
    '    writeFileSync(config.url, scope.connection.authenticatedUrl(`http://127.0.0.1:${scope.webServer.port}`))',
    '    scope.effect(() => () => { rmSync(config.url, { force: true }) })',
    '  })',
    '}',
    '',
  ].join('\n'))
  const observer = { id: 'matrix-log-observer', name: pathToFileURL(observerPath).href, config: { path: diagnostics, url: serverUrl, states } }
  const plugin = join(root, 'probe.mjs')
  writeFileSync(plugin, [
    "import { appendFileSync, existsSync } from 'node:fs'",
    'export const Config = { "~standard": { version: 1, vendor: "matrix", validate(value) {',
    '  return value.mode === "schema" ? { issues: [{ message: "matrix schema failure" }] } : { value }',
    '} } }',
    'export const apply = (ctx, config) => {',
    '  if (config.mode === "sync apply") throw new Error("matrix sync apply")',
    '  return activate(ctx, config)',
    '}',
    'async function activate(ctx, config) {',
    '  if (config.mode === "async apply") { await Promise.resolve(); throw new Error("matrix async apply") }',
    '  if (config.provider) ctx.provide(config.provider, true)',
    '  if (config.mode === "detached") setImmediate(() => { void Promise.reject(new Error("matrix detached failure")) })',
    '  appendFileSync(config.events, `${config.label} apply ${config.generation}\\n`)',
    '  const timer = setInterval(() => { if (existsSync(config.stop)) process.emit("SIGTERM") }, 20)',
    '  ctx.effect(() => () => { clearInterval(timer); appendFileSync(config.events, `${config.label} dispose ${config.generation}\\n`) })',
    '}',
    '',
  ].join('\n'))
  writeFileSync(join(root, 'evaluation.mjs'), 'throw new Error("matrix module evaluation")\n')
  const url = pathToFileURL(plugin).href
  const config = (label: string, generation: number, mode = '') => ({ label, generation, mode, events, stop })
  const witness = (generation: number) => ({ id: 'matrix-witness', name: url, config: config('witness', generation) })
  const target = (id: string, failure?: Failure, generation = 1) => ({
    id,
    name: failure === 'import' ? pathToFileURL(join(root, 'missing.mjs')).href
      : failure === 'module evaluation' ? pathToFileURL(join(root, 'evaluation.mjs')).href : url,
    ...(failure === 'dependency' ? { inject: ['matrixMissingService'] } : {}),
    config: config('target', generation, failure),
  })
  const render = (id: string, failure?: Failure, generation = 1) => {
    let text = `- insert: ${JSON.stringify([observer, witness(generation), target(id, failure, generation)])}`
    if (failure === 'config expression') text += `\n- id: ${id}\n  config: !!js "(() => { throw new Error('matrix config expression') })()"\n`
    if (failure === 'disabled expression') text += `\n- id: ${id}\n  disabled: !!js "(() => { throw new Error('matrix disabled expression') })()"\n`
    return text + '\n'
  }
  writeFileSync(patch, JSON.stringify([{ insert: [observer, witness(0)] }]) + '\n')
  return { root, home, events, diagnostics, serverUrl, states, observer, stop, patch, watcher, render, url, config, witness, target }
}

function start(f: ReturnType<typeof fixture>, extra: string[] = []) {
  const child = execa(process.execPath, [bin, '--profile', 'web', '--patch', f.watcher, ...extra, '--no-open', '--port', '0'], {
    cwd: f.root,
    env: { ...process.env, DSH_HOME: f.home, DSH_AGENTS_HOME: join(f.root, '.agents'), DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: 'keyless-matrix-no-call', NODE_NO_WARNINGS: '1' },
    input: '', reject: false, timeout: 110_000, killSignal: 'SIGKILL',
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8').on('data', (text: string) => { stdout += text })
  child.stderr?.setEncoding('utf8').on('data', (text: string) => { stderr += text })
  let exited = false
  void child.then(() => { exited = true })
  async function wait(predicate: () => boolean) {
    try {
      await expect.poll(() => {
        if (exited) throw new Error('Web process exited')
        return predicate()
      }, { timeout: 45_000 }).toBe(true)
    } catch (cause) { throw new Error(`Web condition failed\n${stdout}\n${stderr}\n${readFileSync(f.diagnostics, 'utf8')}\n${readFileSync(f.events, 'utf8')}`, { cause }) }
  }
  async function serves(currentServer = false) {
    await wait(() => /dsh web: http:\/\//u.test(stdout))
    const url = currentServer ? readFileSync(f.serverUrl, 'utf8') : /dsh web: (http:\/\/[^\s]+)/u.exec(stdout)?.[1]
    if (!url) throw new Error('Missing Web URL')
    const auth = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
    const cookie = auth.headers.get('set-cookie')?.split(';', 1)[0]
    if (!cookie) throw new Error('Missing Web authentication cookie')
    const response = await fetch(new URL('/', url), { headers: { cookie }, signal: AbortSignal.timeout(10_000) })
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('__DSH_BOOT__')
    const bundlePath = /<script src="(\/plugins\/[^"]+)"/u.exec(html)?.[1]?.replaceAll('&amp;', '&')
    if (!bundlePath) throw new Error('Missing bootstrap bundle URL')
    const bundle = await fetch(new URL(bundlePath, url), { headers: { cookie }, signal: AbortSignal.timeout(10_000) })
    expect(bundle.status).toBe(200)
    expect(await bundle.text()).not.toBe('')
  }
  async function close() {
    writeFileSync(f.stop, 'stop')
    // Assertions may fail before a probe applies; forceful teardown still awaits exit.
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    try {
      const result = await child
      return { timedOut: result.timedOut, signal: result.signal, exitCode: result.exitCode, stderr: result.stderr, events: readFileSync(f.events, 'utf8') }
    } finally {
      clearTimeout(timer)
      rmSync(f.root, { recursive: true, force: true })
    }
  }
  const state = (id: string) => (JSON.parse(readFileSync(f.states, 'utf8')) as Record<string, number | undefined>)[id]
  return { child, wait, serves, close, state, stderr: () => stderr, logs: () => readFileSync(f.diagnostics, 'utf8'), events: () => readFileSync(f.events, 'utf8') }
}

function exit(result: { timedOut: boolean; signal?: string | undefined; exitCode?: number | undefined; stderr: string }, code: number) {
  expect(result.timedOut, result.stderr).toBe(false)
  expect(result.signal, result.stderr).toBeUndefined()
  expect(result.exitCode, result.stderr).toBe(code)
}

describe.skipIf(!built)('Web process failure matrix', () => {
  for (const required of [false, true]) {
    const id = required ? 'acp' : 'matrix-optional'
    it.each(failures)(`${required ? 'required' : 'optional'} startup %s`, async (failure, diagnostic) => {
      const f = fixture()
      writeFileSync(f.patch, f.render(id, failure))
      const app = start(f)
      try {
        if (required) {
          const result = await app.child
          exit(result, 1)
          expect(result.stdout).not.toContain('dsh web: http://')
          expect(result.stderr).toContain('required startup failure')
          expect(app.events()).toBe('witness apply 1\nwitness dispose 1\n')
        } else {
          await app.serves()
          await app.wait(() => (app.stderr() + app.logs()).includes(diagnostic))
          expect(app.stderr()).toContain('warning: 1 entry did not activate')
          expect(app.events()).toBe('witness apply 1\n')
        }
        expect(app.stderr() + app.logs()).toContain(diagnostic)
      } finally {
        const result = await app.close()
        exit(result, required ? 1 : 0)
        expect(result.events).toContain('witness dispose 1\n')
      }
    })

    it.each(failures)(`${required ? 'required' : 'optional'} native HMR %s keeps siblings and recovers`, async (failure, diagnostic) => {
      const f = fixture()
      const app = start(f)
      try {
        await app.serves()
        writeFileSync(f.patch, f.render(id, failure))
        await app.wait(() => app.events().includes('witness apply 1\n') && (failure === 'dependency' ? app.state(id) === FiberState.PENDING : app.logs().includes(diagnostic)))
        expect(app.events()).not.toContain('witness dispose 1\n')
        expect(app.events()).not.toContain('target apply')
        expect(readFileSync(f.patch, 'utf8')).toBe(f.render(id, failure))
        await app.serves()
        if (failure === 'dependency') {
          writeFileSync(f.patch, JSON.stringify([
            { insert: [f.observer, f.witness(1), f.target(id, failure)] },
            { insert: [{ id: 'matrix-provider', name: f.url, config: { ...f.config('provider', 2), provider: 'matrixMissingService' } }] },
          ]) + '\n')
        } else writeFileSync(f.patch, f.render(id, undefined, 2))
        await app.wait(() => app.events().includes(`target apply ${failure === 'dependency' ? 1 : 2}\n`))
        await app.serves()
        expect(app.stderr()).not.toContain('required startup failure')
      } finally {
        const result = await app.close()
        exit(result, 0)
        expect(result.events).toContain(`witness dispose ${failure === 'dependency' ? 1 : 2}\n`)
        expect(result.events).toContain(`target dispose ${failure === 'dependency' ? 1 : 2}\n`)
      }
    })
  }

  it.each([
    ['missing', undefined, 'failed to read overlay'],
    ['unreadable directory', undefined, 'failed to read overlay'],
    ['malformed', 'invalid: [unclosed\n', 'failed to parse overlay'],
    ['non-array', 'entries: []\n', 'top-level YAML array'],
    ['non-mapping', '- null\n', 'must be a mapping'],
  ])('rejects a %s explicit overlay before readiness', async (_kind, content, diagnostic) => {
    const f = fixture()
    const overlay = join(f.root, 'invalid.patch.yml')
    if (_kind === 'unreadable directory') mkdirSync(overlay)
    else if (content !== undefined) writeFileSync(overlay, content)
    const app = start(f, ['--patch', overlay])
    try {
      const result = await app.child
      exit(result, 1)
      expect(result.stderr).toContain(diagnostic)
      expect(result.stdout).not.toContain('dsh web: http://')
      expect(app.events()).toBe('')
    } finally { exit(await app.close(), 1) }
  })

  it.each([
    ['malformed', 'invalid: [unclosed\n', 'failed to parse patches'],
    ['non-array', 'entries: []\n', 'top-level YAML array'],
    ['non-mapping', '- null\n', 'must be a mapping'],
  ])('native HMR rejects %s patches, preserves the app and accepts a correction', async (_kind, content, diagnostic) => {
    const f = fixture()
    const app = start(f)
    try {
      await app.serves()
      writeFileSync(f.patch, content)
      await app.wait(() => app.logs().includes(diagnostic))
      expect(app.events()).toBe('witness apply 0\n')
      await app.serves()
      writeFileSync(f.patch, f.render('matrix-optional'))
      await app.wait(() => app.events().includes('target apply 1\n'))
      await app.serves()
    } finally { exit(await app.close(), 0) }
  })

  it('native HMR schema failure retains the existing config until a valid correction', async () => {
    const f = fixture()
    writeFileSync(f.patch, f.render('acp', undefined, 1))
    const app = start(f)
    try {
      await app.serves()
      writeFileSync(f.patch, f.render('acp', 'schema', 2))
      await app.wait(() => app.logs().includes('matrix schema failure') && app.events().includes('witness apply 2\n'))
      expect(app.events()).toContain('target apply 1\n')
      expect(app.events()).not.toContain('target dispose 1\n')
      expect(app.events()).not.toContain('target apply 2\n')
      await app.serves()
      writeFileSync(f.patch, f.render('acp', undefined, 3))
      await app.wait(() => app.events().includes('target apply 3\n'))
      expect(app.events()).toContain('target dispose 1\n')
      await app.serves()
    } finally { exit(await app.close(), 0) }
  })

  it('ignores absent and explicitly disabled required entries at startup', async () => {
    const f = fixture()
    writeFileSync(f.patch, f.render('acp', 'import') + '- id: acp\n  disabled: true\n')
    const app = start(f)
    try {
      await app.serves()
      expect(app.stderr()).not.toContain('required startup failure')
      expect(app.stderr()).not.toContain('failed to import')
    } finally { exit(await app.close(), 0) }
  })

  it('detached rejection from a hot-loaded plugin terminates and disposes the app', async () => {
    const f = fixture()
    const app = start(f)
    try {
      await app.serves()
      writeFileSync(f.patch, JSON.stringify([{ insert: [f.observer, f.witness(0), {
        id: 'matrix-detached', name: f.url, config: f.config('detached', 1, 'detached'),
      }] }]) + '\n')
      const result = await app.child
      exit(result, 1)
      expect(result.stderr).toContain('fatal load failure: Error: matrix detached failure')
      expect(app.events()).toContain('witness dispose 0\n')
      expect(app.events()).toContain('detached dispose 1\n')
    } finally { exit(await app.close(), 1) }
  })

  it('native HMR reports a required Web server bind failure without terminating the process', async () => {
    const f = fixture()
    const blocker = createServer()
    const app = start(f)
    try {
      await new Promise<void>((resolve, reject) => {
        blocker.once('error', reject)
        blocker.listen(0, '127.0.0.1', resolve)
      })
      const address = blocker.address()
      if (!address || typeof address === 'string') throw new Error('Missing blocker address')
      await app.serves()
      writeFileSync(f.patch, f.render('matrix-optional') + `- id: webserver\n  config:\n    host: 127.0.0.1\n    port: ${address.port}\n`)
      await app.wait(() => app.logs().includes('EADDRINUSE') && app.events().includes('witness apply 1\n'))
      expect(app.stderr()).not.toContain('required startup failure')
      expect(app.events()).not.toContain('witness dispose 1\n')
      expect(existsSync(f.serverUrl)).toBe(false)
      writeFileSync(f.patch, f.render('matrix-optional', undefined, 2))
      await app.wait(() => app.events().includes('witness apply 2\n') && existsSync(f.serverUrl))
      await app.serves(true)
    } finally {
      try { exit(await app.close(), 0) } finally {
        await new Promise<void>((resolve, reject) => blocker.close((error) => { if (error) reject(error); else resolve() }))
      }
    }
  })

  it.each(['startup', 'HMR'])('optional HTTP bind failure at %s leaves Web serving', async (phase) => {
    const f = fixture()
    const blocker = createServer()
    let app: ReturnType<typeof start> | undefined
    try {
      const plugin = join(f.root, 'http.mjs')
      writeFileSync(plugin, [
        'import { createServer } from "node:http"',
        'export async function apply(ctx, config) {',
        '  const server = createServer()',
        '  ctx.effect(() => () => new Promise(resolve => server.close(() => resolve())))',
        '  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(config.port, "127.0.0.1", resolve) })',
        '}',
        '',
      ].join('\n'))
      await new Promise<void>((resolve, reject) => {
        blocker.once('error', reject)
        blocker.listen(0, '127.0.0.1', resolve)
      })
      const address = blocker.address()
      if (!address || typeof address === 'string') throw new Error('Missing blocker address')
      const patch = JSON.stringify([{ insert: [f.observer, f.witness(0), {
        id: 'matrix-optional-http', name: pathToFileURL(plugin).href, config: { port: address.port },
      }] }]) + '\n'
      if (phase === 'startup') writeFileSync(f.patch, patch)
      app = start(f)
      const running = app
      await app.serves()
      if (phase === 'HMR') writeFileSync(f.patch, patch)
      await app.wait(() => (running.logs() + running.stderr()).includes('EADDRINUSE'))
      expect(app.events()).toBe('witness apply 0\n')
      await app.serves()
    } finally {
      try {
        if (app) exit(await app.close(), 0)
        else rmSync(f.root, { recursive: true, force: true })
      } finally {
        if (blocker.listening) {
          await new Promise<void>((resolve, reject) => blocker.close((error) => { if (error) reject(error); else resolve() }))
        }
      }
    }
  })

  it.each(['modules', 'connection'])('native HMR recovers the shipped required %s entry', async (id) => {
    const f = fixture()
    const app = start(f)
    try {
      await app.serves()
      // Entry-level injection requirements are captured when the fiber is created.
      writeFileSync(f.patch, f.render('matrix-optional') + `- id: ${id}\n  disabled: true\n`)
      await app.wait(() => app.state(id) === FiberState.DISPOSED)
      const inject = id === 'connection' ? ['webRuntime', 'matrixMissingWebDependency'] : ['matrixMissingWebDependency']
      const pending = f.render('matrix-optional', undefined, 2) + `- id: ${id}\n  inject: ${JSON.stringify(inject)}\n`
      writeFileSync(f.patch, pending)
      await app.wait(() => app.state(id) === FiberState.PENDING && app.events().includes('witness apply 2\n'))
      expect(app.events()).not.toContain('witness dispose 2\n')
      expect(app.stderr()).not.toContain('required startup failure')
      writeFileSync(f.patch, pending + `- insert: ${JSON.stringify([{
        id: 'matrix-provider', name: f.url, config: { ...f.config('provider', 3), provider: 'matrixMissingWebDependency' },
      }])}\n`)
      await app.wait(() => app.state(id) === FiberState.ACTIVE && existsSync(f.serverUrl))
      await app.serves(true)
    } finally { exit(await app.close(), 0) }
  })
})
