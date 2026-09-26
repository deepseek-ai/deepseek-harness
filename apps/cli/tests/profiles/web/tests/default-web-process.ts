/** Built-process owner shared by the Host and browser default-Web isolation smokes. */

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { request as httpRequest } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import ts from 'typescript'
import { expect } from 'vitest'
import type { TestContext } from 'vitest'
import { PROCESS_SHUTDOWN_TIMEOUT_MS } from '../../../../src/process-shutdown.ts'
import type { RuntimeRoster } from './runtime-roster.ts'

const repoRoot = fileURLToPath(new URL('../../../../../../', import.meta.url))

/** Live process whose IPC observer reports independently collected runtime state. */
interface DefaultWeb {
  root: string
  url: string
  request: (command: 'roster' | 'mount-experimental' | 'mount-experimental-entry') => Promise<RuntimeRoster>
}

/**
 * Boot the built Web profile under plain Node and dispose it to quiescence after an assertion callback.
 * @param test - owning Vitest case, including its timeout, cancellation, and cleanup hooks.
 * @param inspect - assertions against the running process and its ephemeral loopback URL.
 * @param options - additional profile patches and test data prepared before startup.
 */
export async function withDefaultWeb(
  test: TestContext,
  inspect: (app: DefaultWeb) => Promise<void>,
  options: { patches?: readonly string[]; prepare?: (root: string) => Promise<void> } = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-web-default-isolation-'))
  let removal: Promise<void> | undefined
  const removeRoot = (): Promise<void> => removal ??= rm(root, { recursive: true, force: true })
  test.onTestFinished(removeRoot)
  try {
    await options.prepare?.(root)
    await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }) + '\n')
    for (const relative of ['runtime-roster.ts', 'fixtures/runtime-roster-observer.ts']) {
      const source = await readFile(new URL(relative, import.meta.url), 'utf8')
      const output = ts.transpileModule(source, {
        fileName: relative,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true },
      }).outputText
      const path = join(root, relative.replace(/\.ts$/, '.js'))
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, output)
    }
    const patch = join(root, 'observer.patch.yml')
    await writeFile(patch, JSON.stringify([{ insert: [{
      id: 'runtime-roster-observer',
      name: pathToFileURL(join(root, 'fixtures/runtime-roster-observer.js')).href,
      config: { negativeControl: pathToFileURL(join(repoRoot, 'packages/experimental/client-ui-agent-team/lib/index.js')).href },
    }] }]) + '\n')
    const launch = resolveExampleLaunch({
      srcBin: join(repoRoot, 'apps/cli/src/bin.ts'),
      mode: 'lib',
      configArgs: [
        '--profile', 'web', ...options.patches?.flatMap(path => ['--patch', path]) ?? [],
        '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open',
      ],
      env: {
        NODE_OPTIONS: undefined,
        NODE_PATH: undefined,
        TSX_TSCONFIG_PATH: undefined,
        DSH_HOME: join(root, 'home'),
        DSH_AGENTS_HOME: join(root, '.agents'),
        DSH_TELEMETRY_DISABLED: '1',
        DEEPSEEK_API_KEY: 'keyless-default-web-no-call',
        NODE_NO_WARNINGS: '1',
      },
    })
    test.signal.throwIfAborted()
    const args = ['--no-experimental-strip-types', ...launch.args]
    const child = spawn(launch.command, args, {
      cwd: root,
      env: { ...process.env, ...launch.env },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    const completion = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>()
    let exited = false
    let processError: Error | undefined
    const pending = new Map<string, ReturnType<typeof Promise.withResolvers<RuntimeRoster>>>()
    const rejectPending = (error: Error): void => {
      for (const request of pending.values()) request.reject(error)
      pending.clear()
    }
    child.once('error', (error) => { processError = error; rejectPending(error) })
    child.once('close', (code, signal) => {
      exited = true
      rejectPending(new Error(`Web exited (code ${String(code)}, signal ${String(signal)})\n${stdout}\n${stderr}`))
      completion.resolve({ code, signal })
    })
    child.once('disconnect', () => { rejectPending(new Error(`Web IPC disconnected\n${stdout}\n${stderr}`)) })
    child.on('message', (message: { command?: string; roster?: RuntimeRoster; error?: string }) => {
      if (message.command === undefined) return
      const request = pending.get(message.command)
      if (request === undefined) return
      pending.delete(message.command)
      if (message.error !== undefined) request.reject(new Error(message.error))
      else if (message.roster !== undefined) request.resolve(message.roster)
      else request.reject(new Error('Web observer returned no runtime roster'))
    })
    const send = (command: string): Promise<void> => new Promise((resolve, reject) => {
      child.send(command, (error: Error | null) => { if (error) reject(error); else resolve() })
    })
    const request = async (command: string): Promise<RuntimeRoster> => {
      test.signal.throwIfAborted()
      if (exited || !child.connected) throw new Error(`Web is not connected during ${command}`)
      const reply = Promise.withResolvers<RuntimeRoster>()
      pending.set(command, reply)
      void send(command).catch((error: unknown) => {
        if (pending.get(command) !== reply) return
        pending.delete(command)
        reply.reject(error)
      })
      return reply.promise
    }
    let forced = false
    let closing: Promise<Awaited<typeof completion.promise>> | undefined
    const close = (): Promise<Awaited<typeof completion.promise>> => closing ??= (async () => {
      const force = (): void => {
        if (exited || child.pid === undefined) return
        forced = true
        child.kill('SIGKILL')
      }
      // The CLI owns its 5-second graceful deadline; the outer watchdog also allows that process exit to settle.
      const kill = setTimeout(force, PROCESS_SHUTDOWN_TIMEOUT_MS * 2)
      try {
        if (!exited && child.connected) {
          try { await send('stop') } catch (_closedChannel: unknown) { force() }
        } else force()
        return await completion.promise
      } finally { clearTimeout(kill) }
    })()
    const abort = (): void => {
      rejectPending(new Error('Web isolation test was cancelled', { cause: test.signal.reason }))
      void close()
    }
    test.signal.addEventListener('abort', abort, { once: true })
    test.onTestFinished(async () => { await close() })
    try {
      await expect.poll(() => {
        test.signal.throwIfAborted()
        if (exited) throw new Error(`Web exited before readiness\n${stdout}\n${stderr}`)
        return /dsh web: (http:\/\/[^\s]+)/u.exec(stdout)?.[1]
      }, { timeout: test.task.timeout }).toBeDefined()
      const url = /dsh web: (http:\/\/[^\s]+)/u.exec(stdout)![1]!
      await inspect({ root, url, request })
    } finally {
      const result = await close()
      test.signal.removeEventListener('abort', abort)
      expect(test.signal.aborted, stderr).toBe(false)
      expect(processError, stderr).toBeUndefined()
      expect(forced, stderr).toBe(false)
      expect(result.signal, stderr).toBeNull()
      expect(result.code, stderr).toBe(0)
    }
  } finally {
    await removeRoot()
  }
}

/**
 * Read an owned loopback response without inheriting Node's process-start proxy dispatcher.
 * @param url - URL of the test-owned Web process.
 * @param signal - owning test cancellation signal.
 * @param headers - optional authentication cookie.
 * @returns complete response after its stream ends.
 */
export function webGet(
  url: string | URL, signal: AbortSignal, headers: Record<string, string> = {},
): ReturnType<typeof webRequest> {
  return webRequest(url, signal, { method: 'GET', headers })
}

/**
 * Send one public-protocol request directly to the test-owned loopback process.
 * @param url - Exact URL of the owned process.
 * @param signal - Owning test cancellation signal.
 * @param options - HTTP method, headers, and optional serialized request body.
 * @returns Complete response after its stream ends.
 */
export function webRequest(
  url: string | URL,
  signal: AbortSignal,
  options: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string },
): Promise<{ status: number | undefined; headers: IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: options.method, headers: options.headers, agent: false, signal }, (response) => {
      response.setEncoding('utf8')
      let text = ''
      response.on('data', (chunk: string) => { text += chunk })
      response.once('error', reject)
      response.once('end', () => { resolve({ status: response.statusCode, headers: response.headers, text }) })
    })
    request.once('error', reject)
    request.end(options.body)
  })
}
