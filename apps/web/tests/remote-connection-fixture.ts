/** Isolated built Web profile with an OS-allocated listener and disposable TLS material. */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { materializeTlsFixture } from '../../../packages/host/webserver/tests/tls-fixture.ts'
import { REPO_ROOT } from './support.ts'

/** One real CLI process, including its private persistence and certificate directory. */
export interface RemoteConnectionFixture {
  /** Token provider's published startup URL, independent of Remote-issued credentials. */
  readonly authenticatedUrl: string
  /** Advertised clean root shared with the new mobile browser. */
  readonly url: string
  /** Private working directory; no user workspace or credentials are read. */
  readonly root: string
  /** Stop the CLI, await its exit, then remove all owned files. */
  close(): Promise<void>
}

async function stop(child: ChildProcess, closed: Promise<void>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return closed
  const escalation = setTimeout(() => { child.kill('SIGKILL') }, 10_000)
  child.kill('SIGTERM')
  try {
    await closed
  } finally {
    clearTimeout(escalation)
  }
}

/**
 * Launch the built `dsh web` profile; browsers map qr-login.test to its loopback listener.
 * The fixture certificate is self-signed and deliberately accepted only by test browser contexts.
 * @param secure - whether the actual listener uses TLS; false exercises HTTP login and cookies.
 * @param ticketLifetimeMs - invitation lifetime for expiry scenarios; omitted keeps the shipped default.
 * @returns the settled CLI and ownership-aware cleanup.
 */
export async function launchRemoteConnectionFixture(secure: boolean, ticketLifetimeMs?: number): Promise<RemoteConnectionFixture> {
  const bin = join(REPO_ROOT, 'apps/cli/lib/bin.js')
  if (!existsSync(bin)) throw new Error('Build the CLI and Web artifacts before running the remote-connection browser test.')
  const root = await mkdtemp(join(tmpdir(), 'dsh-web-qr-'))
  let child: ChildProcess | undefined
  let closed: Promise<void> | undefined
  try {
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const overlay = join(root, 'remote-connection.overlay.yml')
    await writeFile(overlay, [
      '- id: web-runtime',
      '  inject: [webStartup, webServer]',
      '  config:',
      '    openBrowser: false',
      "    publicUrl: !!js ctx.webServer.getOrigin().replace('127.0.0.1', 'qr-login.test')",
      '- id: workspace-controller',
      '  config:',
      `    documentsDirectory: ${JSON.stringify(join(root, 'documents'))}`,
      '- id: ui-settings-general',
      '  config:',
      "    welcomeNoticeVersion: '2026-09-28.1'",
      ...ticketLifetimeMs === undefined ? [] : [
        '- id: remote-connection',
        '  config:',
        `    ticketLifetimeMs: ${ticketLifetimeMs}`,
      ],
      '- id: llm-deepseek',
      '  disabled: true',
      '- id: llm-pi-ai',
      '  disabled: true',
      '- id: session-title-llm',
      '  disabled: true',
      '- id: agent-instructions',
      '  disabled: true',
      '',
    ].join('\n'))
    const tls = secure ? await materializeTlsFixture(root) : undefined
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_HOME: join(root, 'home'),
      DSH_AGENTS_HOME: join(root, 'agents'),
      DSH_TELEMETRY_DISABLED: '1',
    }
    delete env.NODE_OPTIONS
    delete env.DEEPSEEK_API_KEY
    delete env.DEEPSEEK_BASE_URL
    const processHandle = spawn(process.execPath, [
      bin, 'web',
      '--patch', join(REPO_ROOT, 'apps/web/tests/pin-browse-picker.overlay.yml'),
      '--patch', overlay,
      '--no-open', '--host', '127.0.0.1', '--port', '0',
      '--trusted-host', 'qr-login.test',
      ...tls === undefined ? [] : ['--tls-cert', tls.certFile, '--tls-key', tls.keyFile],
    ], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child = processHandle
    closed = new Promise<void>((resolve) => { processHandle.once('close', () => { resolve() }) })
    let output = ''
    const authenticatedUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error(`Web QR fixture did not start:\n${output}`)) }, 90_000)
      const settle = (value: string | Error): void => {
        clearTimeout(timer)
        if (value instanceof Error) reject(value)
        else resolve(value)
      }
      processHandle.stdout.setEncoding('utf8')
      processHandle.stderr.setEncoding('utf8')
      processHandle.stdout.on('data', (chunk: string) => {
        output += chunk
        const published = /dsh web: (https?:\/\/qr-login\.test:\d+\/[^\s]*)/.exec(output)?.[1]
        if (published !== undefined) settle(published)
      })
      processHandle.stderr.on('data', (chunk: string) => { output += chunk })
      processHandle.once('error', settle)
      processHandle.once('exit', (code, signal) => {
        settle(new Error(`Web QR fixture exited before readiness (${String(code)}, ${String(signal)}):\n${output}`))
      })
    })
    const url = new URL(authenticatedUrl)
    if (url.searchParams.getAll('token').length !== 1 || !url.searchParams.get('token')) {
      throw new Error('Web QR fixture did not receive the Token provider login URL.')
    }
    url.search = ''
    const whenClosed = closed
    let closing: Promise<void> | undefined
    return {
      authenticatedUrl, url: url.href, root,
      close() {
        closing ??= (async () => {
          await stop(processHandle, whenClosed)
          await rm(root, { recursive: true, force: true })
        })()
        return closing
      },
    }
  } catch (error) {
    if (child !== undefined && closed !== undefined) await stop(child, closed)
    await rm(root, { recursive: true, force: true })
    throw error
  }
}
