/**
 * Isolated real `dsh web` instance for the three-mode acceptance driver.
 *
 * The harness boots the shipped web profile in a private temp home and workspace and exposes the
 * shipped HTTP carrier. The model route is the deterministic keyless fixture beside this module;
 * execution, authorization, and the controller are the real ones. Nothing here reads a developer
 * profile, and nothing reaches a developer's running instance or its state.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseRemoteStreamServerMessage,
  type RemoteStreamServerMessage,
} from '@deepseek-ai/dsh-api-gateway/src/stream-protocol.ts'
import { execa } from 'execa'
import { expect, onTestFinished } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { WebSocket } from 'ws'

const dshBinScript = fileURLToPath(new URL('../../../../apps/cli/src/bin.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))
const fixtureName = fileURLToPath(new URL('./fixtures/base-llm.mjs', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))

/**
 * One decoded JSON object read from the real HTTP and mux carriers, or from a durable Session file.
 *
 * This driver reads envelopes the packages under test own, so it declares every field it inspects and
 * leaves each optional: a carrier that omits one reads as `undefined`. A field this declaration does not
 * name has to be declared before it can be read, which keeps a renamed carrier field from passing as a
 * silently missing answer.
 */
export interface Wire {
  readonly type?: string
  readonly streamId?: string
  readonly rpcId?: string
  readonly method?: string
  readonly seq?: number
  readonly turn?: number
  readonly id?: string
  readonly name?: string
  readonly arguments?: unknown
  readonly text?: string
  readonly kind?: string
  readonly code?: string
  readonly callId?: string
  readonly toolCallId?: string
  readonly isError?: boolean
  readonly ok?: boolean
  readonly opened?: boolean
  readonly pending?: boolean
  readonly sessionId?: string
  readonly shareId?: string
  readonly sessionMode?: string
  readonly sessionModeReason?: string
  readonly sessionTitle?: string
  readonly parentSession?: string
  readonly childSessionId?: string
  readonly isSeeded?: boolean
  readonly revokedAt?: string
  readonly createdAt?: string | number
  readonly link?: string
  readonly asOfSeq?: number
  /** The owner's or viewer's own verification state for one Relay address. */
  readonly state?: string
  readonly requestId?: string
  readonly messageOrigin?: string
  readonly authorizeUrl?: string
  readonly authorizationUrl?: string
  readonly expiresAt?: string | number
  readonly online?: boolean
  readonly readOnly?: boolean
  readonly allowed?: boolean
  readonly unsupportedPermissions?: readonly string[]
  readonly event?: Wire
  readonly data?: Wire
  readonly message?: Wire
  readonly header?: Wire
  readonly capabilities?: Wire
  readonly fork?: Wire
  readonly source?: Wire
  readonly actor?: Wire
  readonly reason?: Wire
  readonly error?: Wire
  readonly failure?: Wire
  readonly result?: Wire
  readonly value?: Wire
  readonly payload?: Wire
  readonly args?: unknown
  readonly records?: readonly Wire[]
  readonly content?: readonly Wire[]
  readonly shares?: readonly Wire[]
  readonly forks?: readonly Wire[]
  readonly queues?: Readonly<Record<string, Wire>>
  readonly jobs?: Readonly<Record<string, Wire>>
  readonly projections?: Readonly<Record<string, Wire>>
}

/**
 * Read one boundary value as a decoded JSON object.
 * @param value - Value a carrier, artifact, or fixture handed back.
 * @returns The object, or undefined when the value is not one.
 */
export function wireObject(value: unknown): Wire | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

/**
 * Read every element one decoded JSON array holds.
 * @param value - Value a carrier or artifact handed back.
 * @returns The elements in order, or an empty list when the value is not an array.
 */
export function wireList(value: unknown): readonly Wire[] {
  return Array.isArray(value) ? value as readonly Wire[] : []
}

/**
 * The independent outcomes one finished app process reports.
 *
 * A timeout, a signal, and an exit code are separate facts, so a reader that reports one of them must
 * read all three rather than infer one from another.
 */
interface ProcessOutcome {
  readonly exitCode?: number
  readonly signal?: string
  readonly timedOut?: boolean
}

/** Shield every diagnostic: the app's own startup line carries a real launch token. */
export function redact(text: string): string {
  return text.replace(/token=[A-Za-z0-9_-]+/gu, 'token=***')
}

/**
 * Join the assistant text one set of records carries.
 *
 * Both shapes the driver reads carry the same durable event: a row straight out of the artifact, and
 * a row the follow carrier nested under `event`. An empty answer here is a fact in itself, which is
 * why this returns text rather than asserting presence.
 * @param rows - Durable records, or follow records wrapping them.
 * @returns The concatenated text of every assistant text block, in order.
 */
export function assistantTextOf(rows: readonly Wire[]): string {
  return rows
    .filter(row => String((row?.event ?? row)?.type) === 'assistant/message')
    .flatMap(row => wireList((row?.event ?? row)?.data?.message?.content))
    .filter((block: Wire) => block?.type === 'text')
    .map((block: Wire) => String(block.text))
    .join('')
}

/** Names of the turn outcomes one set of records reports, in order. */
export function turnOutcomes(rows: readonly Wire[]): string[] {
  return rows
    .filter(row => String((row?.event ?? row)?.type) === 'turn/end')
    .map(row => (row?.event ?? row)?.data?.reason?.kind ?? 'n/a')
}

/** Every row one follow snapshot delivered, in order. */
export function snapshotRecords(snapshot: Wire | undefined): Wire[] {
  return [...wireList(snapshot?.records)]
}

/**
 * Read the stable code out of one refusal body.
 *
 * The owner answers a refused read with `{ok:false, error:{code, message, details}}` and a refused
 * viewer write with `{error: code, message}`, so both forms are read here rather than at each case.
 * @param body - Refusal body the owner (or the Relay) wrote back.
 * @returns The code, or undefined when the body names none.
 */
export function refusalCode(body: unknown): string | undefined {
  const error = wireObject(body)?.error
  if (typeof error === 'string' && error !== '') return error
  const code = error?.code
  return typeof code === 'string' && code !== '' ? code : undefined
}

/** The message one refusal body carries, or the empty string when it carries none. */
export function refusalMessage(body: unknown): string {
  const record = wireObject(body)
  const message = record?.message
  if (typeof message === 'string') return message
  const nested = record?.error?.message
  return typeof nested === 'string' ? nested : ''
}

/** One open logical stream on the shipped mux carrier and the frames it delivered. */
export interface StreamObservation {
  /** Every frame this socket delivered for the stream it opened, in arrival order. */
  readonly frames: Wire[]
  /** Close the socket and wait for it to be gone. */
  close(): Promise<void>
}

/** Options one stream observation opens with. */
export interface OpenStreamOptions {
  /** Origin the app serves the mux carrier on. */
  readonly origin: string
  /** Launch cookie the app issued. */
  readonly cookie: string
  /** Canonical Remote endpoint or gateway-owned stream name. */
  readonly endpoint: string
  /** Decoded carrier payload. */
  readonly args: object
  /** Stop waiting once this frame arrives; later frames keep collecting until the caller closes. */
  readonly until?: (frame: Wire, frames: readonly Wire[]) => boolean
  readonly timeoutMs?: number
}

/**
 * Open one logical stream through the real mux carrier and the gateway's own frame parser.
 *
 * The parser is the shipped one, so a frame this gateway would reject cannot pass as progress, and
 * only frames carrying this stream's own id are accepted.
 * @param options - Origin, cookie, endpoint, payload, and the stopping condition.
 * @returns The observation, already stopped at `until` or failed with the carrier's own error.
 */
export async function openStream(options: OpenStreamOptions): Promise<StreamObservation> {
  const streamId = `acceptance-${options.endpoint.replace(/\//gu, '-')}-${String(Date.now())}`
    + `-${Math.random().toString(36).slice(2)}`
  const socket = new WebSocket(`${options.origin.replace(/^http/u, 'ws')}/api/remote.mux`, {
    headers: { cookie: options.cookie },
  })
  const frames: Wire[] = []
  const closed = new Promise<void>((resolve) => { socket.once('close', () => { resolve() }) })
  onTestFinished(async () => {
    if (socket.readyState === WebSocket.CLOSED) return
    socket.terminate()
    await closed
  })
  const close = async (): Promise<void> => {
    if (socket.readyState !== WebSocket.CLOSED) socket.close()
    await closed
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`stream ${options.endpoint} produced no settled frame within`
          + ` ${String(options.timeoutMs ?? 60_000)}ms; frames=${JSON.stringify(frames).slice(0, 400)}`))
      }, options.timeoutMs ?? 60_000)
      const settle = (error?: Error): void => {
        clearTimeout(timer)
        if (error === undefined) resolve()
        else reject(error)
      }
      socket.once('error', (error: Error) => { settle(error) })
      socket.on('open', () => {
        socket.send(JSON.stringify({
          type: 'open',
          streamId,
          endpoint: options.endpoint,
          payload: { args: options.args },
        }))
      })
      socket.on('message', (data: unknown) => {
        let parsed: RemoteStreamServerMessage
        try {
          parsed = parseRemoteStreamServerMessage(String(data))
        } catch (error) {
          settle(new Error(`stream ${options.endpoint} sent an invalid frame:`
            + ` ${String(error)} raw=${redact(String(data)).slice(0, 300)}`))
          return
        }
        // Every server frame carries its stream id, and this socket opened exactly one stream.
        if (parsed.streamId !== streamId) {
          settle(new Error(`stream ${options.endpoint} received a frame for ${parsed.streamId}`))
          return
        }
        if (parsed.type === 'error') {
          settle(new Error(`stream ${options.endpoint} failed: ${JSON.stringify(parsed.error).slice(0, 300)}`))
          return
        }
        // The shipped parser validates the frame and leaves its carried value `unknown`; this driver
        // reads that value as decoded JSON, which is what the caller's predicates inspect.
        const frame: Wire = parsed.type === 'item'
          ? { type: 'item', streamId: parsed.streamId, ...(parsed.value === undefined ? {} : { value: parsed.value as Wire }) }
          : { type: 'end', streamId: parsed.streamId }
        frames.push(frame)
        if (frame.type === 'end') {
          settle(new Error(`stream ${options.endpoint} ended after ${String(frames.length)} frames`))
          return
        }
        if (options.until?.(frame, frames) === true) settle()
      })
      socket.once('close', () => {
        settle(new Error(`stream ${options.endpoint} socket closed before it settled;`
          + ` frames=${JSON.stringify(frames).slice(0, 400)}`))
      })
    })
  } catch (error) {
    await close()
    throw error
  }
  return { frames, close }
}

/** Options one acceptance instance boots with. */
export interface WebOwnerOptions {
  /** Profile bundles beyond the shipped base and web app. */
  readonly bundles?: readonly string[]
  /**
   * An instance directory this boot takes over instead of creating one.
   *
   * A restart has to serve the same DSH home, workspace, and session logs as the process it replaces,
   * so a resumed-session case boots the same tree twice rather than a second isolated one.
   */
  readonly existingCwd?: string
  /** Extra overlay entries appended to the profile patch. */
  readonly patchLines?: readonly string[]
  /**
   * Environment entries the app and its gateway worker receive. A function receives the private
   * temp directory, so an entry may name a file inside the instance this call creates.
   */
  readonly env?: Readonly<Record<string, string | undefined | ((cwd: string) => string | undefined)>>
}

/** One running acceptance instance and its observations. */
export interface WebOwner {
  /** Private temp directory the instance owns. */
  readonly cwd: string
  /** Private DSH home the instance owns. */
  readonly home: string
  /** Origin the app serves its own page and `/api` on. */
  readonly origin: string
  /** Launch cookie the app issued for its own page. */
  readonly cookie: string
  /** Collected evidence lines a caller reports when it finishes. */
  readonly facts: string[]
  /** Retrieve one authenticated `/api/<endpoint>` answer. */
  rpc(endpoint: string, args: object): Promise<Wire>
  /** Post one raw JSON body to an `/api` path the product itself posts to. */
  post(path: string, body: unknown): Promise<{ readonly status: number; readonly body: unknown }>
  /**
   * Create one Session.
   * @param workspace - Workspace root the Session runs in; defaults to the instance's own directory.
   * @returns The new Session's identity.
   */
  createSession(workspace?: string): Promise<string>
  /** Admit one prompt and require the acknowledgement. */
  prompt(sessionId: string, text: string, requestId: string): Promise<Wire>
  /** Read the durable records of the generation whose header carries this Session id. */
  records(sessionId: string): Promise<Wire[]>
  /**
   * Identify this Session's own generation file and hash its raw bytes.
   *
   * `records()` reports decoded rows; this reports the artifact on disk, which is what "unchanged"
   * has to mean when the claim is about bytes rather than about a re-serialization.
   */
  rawLog(sessionId: string): Promise<{ readonly file: string; readonly sha256: string; readonly size: number }>
  /** Sweep every durable generation until the predicate holds, then report why it never did. */
  waitFor(label: string, predicate: (records: Wire[]) => boolean): Promise<Wire[]>
  /** Poll one named Session's own durable log until the predicate holds, then report why it did not. */
  waitSession(sessionId: string, label: string, predicate: (records: Wire[]) => boolean): Promise<Wire[]>
  /** Every persisted Session whose header names this one as its parent, in file order. */
  childIds(sourceId: string): Promise<string[]>
  /** Every adapter call the fixture served, one line each. */
  fixtureCalls(): Promise<string>
  /** How many model calls the fixture has served, so a refusal can be shown to reach none. */
  modelCalls(): Promise<number>
  /** Everything the app wrote to stderr so far. */
  stderr(): string
  /**
   * Stop this instance and prove it is quiescent: it exited on its own with no signal and no timeout,
   * and its port refuses connections. A restart case calls this before booting its successor on the
   * same tree; the tree itself stays until the test's own cleanup removes it.
   */
  stop(): Promise<void>
}

/**
 * Boot one isolated web-profile instance and register its teardown.
 * @param options - Extra bundles, overlay entries, and environment the instance needs.
 * @returns The running instance and its observations.
 */
export async function bootWebOwner(options: WebOwnerOptions = {}): Promise<WebOwner> {
  const cwd = options.existingCwd ?? await mkdtemp(join(tmpdir(), 'liveshare-web-'))
  const home = join(cwd, '.dsh')
  const sessionsRoot = join(home, 'sessions')
  const profileDir = join(home, 'profiles', 'web')
  // A restart reuses the tree its predecessor wrote, including the profile it composed.
  if (options.existingCwd === undefined) await mkdir(profileDir, { recursive: true })
  // Self-contained: the shipped bundles plus a keyless model. No user profile, personal plugin,
  // address, or side effect enters this instance.
  const extraBundles = [...options.bundles ?? []]
  // A restart reuses the profile its predecessor composed, links included.
  if (options.existingCwd === undefined) {
    for (const bundle of extraBundles) await installBundle(profileDir, bundle)
  }
  if (options.existingCwd === undefined) await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: Object.fromEntries(extraBundles.map(bundle => [bundle, 'workspace:^'])),
    dsh: {
      profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...extraBundles] },
    },
  }, undefined, 2) + '\n')
  if (options.existingCwd === undefined) await writeFile(join(profileDir, 'cordis.patch.yml'), [
    '- id: llm-deepseek',
    '  disabled: true',
    '- id: session-persistence-jsonl',
    '  config:',
    `    root: '${sessionsRoot}'`,
    '    compression: none',
    '- insert:',
    '    - id: base-fixture-llm',
    `      name: '${fixtureName}'`,
    ...options.patchLines ?? [],
    '',
  ].join('\n'))
  await writeFile(join(cwd, 'README.txt'), 'workspace root for the acceptance run\n')
  const configured = Object.fromEntries(Object.entries(options.env ?? {})
    .map(([key, value]) => [key, typeof value === 'function' ? value(cwd) : value]))
  const launch = resolveExampleLaunch({
    srcBin: dshBinScript,
    // `--port 0` lets the app pick; its own startup line carries the real origin.
    configArgs: ['--profile', 'web', '--port', '0', '--no-open'],
    tsconfigPath,
    sourceImport: 'tsx/esm',
    env: {
      DSH_HOME: home,
      DSH_AGENTS_HOME: join(cwd, '.agents'),
      DSH_TELEMETRY_DISABLED: '1',
      DEEPSEEK_API_KEY: '',
      // Diagnostic only: the fixture appends one line per adapter call to this temp file.
      BASE_LLM_LOG: join(cwd, 'base-llm.log'),
      // Diagnostic only: proves the loader activated the fixture plugin at all.
      BASE_LLM_LOADED: join(cwd, 'base-llm.loaded'),
      NODE_OPTIONS: '--disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      ...configured,
    },
  })
  const child = execa(launch.command, launch.args, {
    cwd,
    env: launch.env,
    reject: false,
    // The child inherits only what the launch helper composed: no ambient credential leaks in.
    extendEnv: false,
  })
  const facts: string[] = []
  let stderrText = ''
  child.stderr?.on('data', (chunk: Buffer) => { stderrText = (stderrText + chunk.toString()).slice(-8000) })
  // Real artifact evidence: `lib` mode spawns the built bin under plain Node, never tsx source.
  const launchBin = String(launch.args[0])
  facts.push(`launch: mode=${process.env.DSH_EXAMPLE_MODE ?? 'src'} bin=${launchBin}`
    + ` args=${JSON.stringify(launch.args.slice(1))} envKeys=${JSON.stringify(Object.keys(launch.env).sort())}`)
  if (process.env.DSH_EXAMPLE_MODE === 'lib') {
    expect(launchBin, 'built-lib launch').toContain('/lib/')
    expect(launch.args.some(argument => argument.includes('tsx')), 'no tsx loader in lib mode').toBe(false)
  }
  // One instance's own process facts. `stopped` only becomes true once this process is gone and its
  // port is refused; the tree's removal never waits on it.
  const release: { origin?: string; stopped: boolean; lifecycle: string[] } = {
    stopped: false,
    lifecycle: [],
  }
  const stopInstance = async (): Promise<void> => {
    if (release.stopped) return
    child.kill('SIGTERM')
    let timer: ReturnType<typeof setTimeout> | undefined
    const settled = await Promise.race([
      child.then(result => ({ result }), (error: unknown) => ({ error })),
      new Promise<{ reason: string }>((resolve) => {
        timer = setTimeout(() => { resolve({ reason: 'fallback' }) }, 5_000)
      }),
    ])
    clearTimeout(timer)
    let result: ProcessOutcome | undefined = 'result' in settled ? settled.result : undefined
    const usedFallback = result === undefined
    if (usedFallback) {
      child.kill('SIGKILL')
      result = await child.catch(() => undefined)
    }
    // The three process outcomes are separate facts; a signal is not a timeout.
    console.log(`child exit: pid=${String(child.pid)} exitCode=${String(result?.exitCode)}`
      + ` signal=${String(result?.signal)} timedOut=${String(result?.timedOut)}`
      + ` fallback=${String(usedFallback)}`)
    expect(usedFallback, 'the app needed the fallback kill').toBe(false)
    expect(result?.timedOut, 'the app hit its own timeout').toBe(false)
    expect(result?.exitCode, 'the app exited on its own').toBe(0)
    expect(result?.signal, 'the app reported a signal instead of an exit').toBeUndefined()
    // Only a refused connection proves the port is free; a timeout or a bare error does not.
    if (release.origin !== undefined) {
      const { port } = new URL(release.origin)
      const outcome = await new Promise<'refused' | 'open' | 'timeout'>((resolve) => {
        const socket = connect({ port: Number(port), host: '127.0.0.1' })
        let settledProbe = false
        const finish = (value: 'refused' | 'open' | 'timeout'): void => {
          if (settledProbe) return
          settledProbe = true
          clearTimeout(probeTimer)
          socket.once('close', () => { resolve(value) })
          socket.destroy()
        }
        const probeTimer = setTimeout(() => { finish('timeout') }, 2_000)
        socket.once('connect', () => { finish('open') })
        socket.once('error', (error: NodeJS.ErrnoException) => {
          finish(error.code === 'ECONNREFUSED' ? 'refused' : 'timeout')
        })
      })
      console.log(`port release: outcome=${outcome}`)
      expect(outcome, 'the app still accepts connections after exit').toBe('refused')
    }
    release.lifecycle.push('stopped')
    release.stopped = true
  }
  registerTeardown(cwd, release, stopInstance)
  // The app prints its own launch URL; the token comes from that line, never from the shell.
  const token = await new Promise<string>((resolve, reject) => {
    let seen = ''
    const fail = (why: string): void => {
      clearTimeout(timer)
      reject(new Error(`${why}\nstdout:\n${redact(seen.slice(-1500))}\nstderr:\n${redact(stderrText.slice(-1500))}`))
    }
    const timer = setTimeout(() => { fail('no launch line within 90s') }, 90_000)
    child.stdout?.on('data', (chunk: Buffer) => {
      seen += chunk.toString()
      const match = /(http:\/\/127\.0\.0\.1:\d+\/\?token=)([A-Za-z0-9_-]+)/u.exec(seen)
      if (match?.[0] === undefined) return
      clearTimeout(timer)
      resolve(match[0])
    })
    // execa's result is promise-like: early exit and spawn failure both surface through it.
    void child.then((result) => {
      fail(`app exited early code=${String(result?.exitCode)}`)
    }).catch((error: unknown) => {
      fail(`spawn failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  })
  const origin = new URL(token).origin
  release.origin = origin
  const page = await fetch(token, { redirect: 'manual' })
  expect(page.status, 'unexpected launch response').toBe(303)
  const cookie = page.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  expect(cookie.length).toBeGreaterThan(0)
  const served = await fetch(`${origin}/`, { headers: { cookie } })
  expect(served.status).toBe(200)
  expect(await served.text()).toContain('<html')

  // The shipped HTTP carrier: POST /api/<endpoint> with the client-request envelope.
  const rpc = async (endpoint: string, args: object): Promise<Wire> => {
    const response = await fetch(`${origin}/api/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `acceptance-${endpoint}-${String(Date.now())}-${Math.random().toString(36).slice(2)}`,
        method: endpoint,
        payload: { args },
      }),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${endpoint} HTTP ${String(response.status)}: ${text}`)
    return JSON.parse(text) as Wire
  }
  // Only a trailing partial line may be dropped; corrupt JSON in a complete frame fails.
  const readRecords = async (file: string): Promise<Wire[]> => {
    const text = await readFile(join(sessionsRoot, file), 'utf8')
    const frames = text.split('\n').filter(line => line !== '')
    const complete = text.endsWith('\n') ? frames : frames.slice(0, -1)
    return complete.map(line => JSON.parse(line) as Wire)
  }
  const generations = async (): Promise<Wire[][]> => {
    const files = (await readdir(sessionsRoot, { recursive: true })).filter(file => file.endsWith('.jsonl'))
    return Promise.all(files.map(readRecords))
  }
  const headerIdOf = (records: Wire[]): unknown => records.find((record: Wire) => record.type === 'session')?.id
  /** Read one named Session's own durable records, refusing an ambiguous match. */
  const recordsOf = async (sessionId: string): Promise<Wire[]> => {
    const matches = (await generations()).filter(records => headerIdOf(records) === sessionId)
    if (matches.length > 1) throw new Error(`session matched ${String(matches.length)} generations`)
    return matches[0] ?? []
  }

  const diagnose = async (label: string): Promise<never> => {
    const entries = await readdir(sessionsRoot, { withFileTypes: true })
      .then(list => list.slice(0, 20).map(entry => `${entry.isDirectory() ? 'd' : 'f'}:${entry.name}`), () => ['<unreadable>'])
    const inner: string[] = []
    for (const entry of await readdir(sessionsRoot, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue
      const dir = join(sessionsRoot, entry.name)
      for (const item of (await readdir(dir, { withFileTypes: true }).catch(() => [])).slice(0, 20)) {
        const full = join(dir, item.name)
        const size = await stat(full).then(value => value.size, () => -1)
        // The sessionId entry is a directory whose inner generation file carries the events.
        inner.push(`${item.isDirectory() ? 'd' : 'f'}:${item.name} size=${String(size)}`)
        if (item.isDirectory()) {
          const deep = await readdir(full).catch(() => [])
          inner.push(`  inner=${JSON.stringify(deep.slice(0, 10))}`)
        }
      }
    }
    const loaded = await stat(join(cwd, 'base-llm.loaded')).then(() => 'loaded', () => 'absent')
    const calls = await readFile(join(cwd, 'base-llm.log'), 'utf8').then(
      text => redact(text).split('\n').filter(Boolean).length, () => -1)
    throw new Error([
      `timeout waiting for ${label}`,
      `sessionsRootEntries=${JSON.stringify(entries)}`,
      `sessionFilesUnderWorkspace=${JSON.stringify(inner)}`,
      `fixtureLoadedMarker=${loaded}`,
      `fixtureAdapterCalls=${String(calls)}`,
      `stderr=${redact(stderrText.slice(-600))}`,
      ...facts,
    ].join('\n'))
  }

  return {
    cwd,
    home,
    origin,
    cookie,
    facts,
    rpc,
    // The share endpoints the product's own dialog posts to take the plain body, not an envelope.
    async post(path: string, body: unknown): Promise<{ readonly status: number; readonly body: unknown }> {
      const response = await fetch(`${origin}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(body),
      })
      const text = await response.text()
      return {
        status: response.status,
        // A host whose plugin did not mount answers plain text; keep it so the failure names itself.
        body: text === '' ? undefined : (() => {
          try {
            const parsed: unknown = JSON.parse(text)
            return parsed
          } catch {
            return redact(text).slice(0, 300)
          }
        })(),
      }
    },
    async createSession(workspace?: string): Promise<string> {
      const created = await rpc('session/create', { request: { cwd: workspace ?? cwd } })
      const sessionId = created?.result?.value?.sessionId
      expect(typeof sessionId, JSON.stringify(created).slice(0, 400)).toBe('string')
      return String(sessionId)
    },
    async prompt(sessionId: string, text: string, requestId: string): Promise<Wire> {
      const answer = await rpc('session/prompt', {
        request: { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] },
      })
      facts.push(`prompt ${requestId}: ${redact(JSON.stringify(answer?.result ?? answer)).slice(0, 400)}`)
      expect(answer?.result?.ok, JSON.stringify(answer).slice(0, 400)).toBe(true)
      return answer
    },
    async records(sessionId: string): Promise<Wire[]> {
      return await recordsOf(sessionId)
    },
    async childIds(sourceId: string): Promise<string[]> {
      const found: string[] = []
      for (const records of await generations()) {
        const header = records.find((record: Wire) => record.type === 'session')
        if (header?.parentSession === sourceId && typeof header.id === 'string') found.push(header.id)
      }
      return found
    },
    async rawLog(sessionId: string): Promise<{
      readonly file: string
      readonly sha256: string
      readonly size: number
    }> {
      const files = (await readdir(sessionsRoot, { recursive: true })).filter(file => file.endsWith('.jsonl'))
      const matches: string[] = []
      for (const file of files) {
        // Only the header line identifies the file; the bytes this returns stay unparsed.
        const text = await readFile(join(sessionsRoot, file), 'utf8')
        const first = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'))
        if (headerIdOf([JSON.parse(first) as Wire]) === sessionId) matches.push(file)
      }
      if (matches.length !== 1) {
        throw new Error(`session ${sessionId} matched ${String(matches.length)} generation files`)
      }
      const bytes = await readFile(join(sessionsRoot, matches[0] ?? ''))
      return {
        file: matches[0] ?? '',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.byteLength,
      }
    },
    async waitFor(label: string, predicate: (records: Wire[]) => boolean): Promise<Wire[]> {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        for (const candidate of await generations()) {
          if (predicate(candidate)) return candidate
        }
        await new Promise((resolve) => { setTimeout(resolve, 1_000) })
      }
      return await diagnose(label)
    },
    async waitSession(sessionId: string, label: string, predicate: (records: Wire[]) => boolean):
    Promise<Wire[]> {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const records = await recordsOf(sessionId)
        if (predicate(records)) return records
        await new Promise((resolve) => { setTimeout(resolve, 1_000) })
      }
      // The row types this Session actually reached are the cheapest evidence of how far it got.
      const reached = await recordsOf(sessionId).catch(() => [] as Wire[])
      facts.push(`timeout on ${sessionId}: lastRows=${JSON.stringify(reached.slice(-6).map(
        (record: Wire) => `${String(record.type)}@${String(record.seq)}`))}`
        + ` outcomes=${JSON.stringify(reached.filter((record: Wire) => record.type === 'turn/end')
          .map((record: Wire) => record.data?.reason?.kind))}`)
      return await diagnose(`${label} on ${sessionId}`)
    },
    async fixtureCalls(): Promise<string> {
      return await readFile(join(cwd, 'base-llm.log'), 'utf8').catch(() => '<absent>')
    },
    async modelCalls(): Promise<number> {
      const text = await readFile(join(cwd, 'base-llm.log'), 'utf8').catch(() => '')
      return text.split('\n').filter(Boolean).length
    },
    stderr: () => stderrText,
    async stop(): Promise<void> {
      // Quiescence first: exit, signal, timeout, and port release are all asserted inside, and the
      // tree stays for the successor this case boots next.
      await stopInstance()
      facts.push(`stopped pid=${String(child.pid)} at ${String(Date.now())}`)
    },
  }
}

/**
 * Terminate the instance, prove the port is released, then remove the tree.
 * @param cwd - Private temp directory to remove last.
 * @param child - The app process to terminate first.
 * @returns A handle whose `origin` the boot fills in once the app reports it.
 */
function registerTeardown(
  cwd: string,
  state: { origin?: string; stopped: boolean; lifecycle: string[] },
  stopInstance: () => Promise<void>,
): void {
  // Vitest runs these hooks in reverse registration order, so the tree's removal is registered first
  // and therefore runs after the process is gone. Each is separate, so a failed stop still cleans up.
  onTestFinished(() => {
    expect(state.lifecycle, 'the instance stopped before its tree was removed')
      .toEqual(['stopped', 'removed'])
  })
  onTestFinished(async () => {
    await rm(cwd, { recursive: true, force: true })
    const removed = await stat(cwd).then(() => false, () => true)
    console.log(`temp tree removed: ${String(removed)}`)
    state.lifecycle.push('removed')
    expect(removed, 'the temp tree is gone').toBe(true)
  })
  onTestFinished(async () => {
    // A process this case already stopped and proved quiescent needs nothing further.
    if (!state.stopped) await stopInstance()
  })
}

/**
 * Install one workspace bundle into a profile the way `dsh plugin install` would.
 *
 * The profile's own `node_modules` is the second anchor bundle resolution reads, so a bundle this
 * checkout provides has to appear there; the profile manifest declares the dependency it links.
 * @param profileDir - Profile directory the bundle is installed into.
 * @param packageName - Workspace package name the profile lists as a bundle.
 */
async function installBundle(profileDir: string, packageName: string): Promise<void> {
  for (const group of await readdir(join(repositoryRoot, 'packages'))) {
    for (const directory of await readdir(join(repositoryRoot, 'packages', group)).catch(() => [])) {
      const source = join(repositoryRoot, 'packages', group, directory)
      const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8').catch(() => '{}')) as Wire
      if (manifest.name !== packageName) continue
      const target = join(profileDir, 'node_modules', ...packageName.split('/'))
      await mkdir(dirname(target), { recursive: true })
      await symlink(source, target, 'dir')
      return
    }
  }
  throw new Error(`no workspace package is named ${packageName}`)
}

/** One viewer's carrier: exactly the operations the served page uses over the Relay. */
export interface ViewerCarrier {
  /** Post one carrier request and return the Relay's status and the owner's decoded answer. */
  send(request: unknown): Promise<{ readonly status: number; readonly body: unknown }>
  /** Fetch one `/api` path the way the page's Connection layer does. */
  call(path: string, body: unknown): Promise<{ readonly status: number; readonly body: unknown }>
  /** Open `session/follow` on one Session and return its opening snapshot frame. */
  snapshot(sessionId: string, streamId?: number): Promise<Wire | undefined>
}

/**
 * Build one viewer's carrier over a Relay request function.
 *
 * The page posts the Connection envelope its own transport builds, numbers its own logical streams,
 * and polls them until the owner answers; this mirrors that so a case drives the product's carrier
 * rather than a private shortcut.
 * @param send - One `POST {basePath}/__share/rpc` request returning the Relay's status and JSON body.
 * @returns The carrier operations a case reads through.
 */
export function createViewerCarrier(
  send: (request: unknown) => Promise<{ readonly status: number; readonly body: unknown }>,
): ViewerCarrier {
  return {
    send,
    async call(path, body) {
      return await send({ op: 'call', path, body })
    },
    async snapshot(sessionId, streamId = 3) {
      const opened = await send({
        op: 'stream-open',
        id: streamId,
        endpoint: 'session/follow',
        payload: { args: { request: { address: { kind: 'session', sessionId }, maxMessages: 200 } } },
      })
      expect(opened.status, JSON.stringify(opened.body).slice(0, 300)).toBe(200)
      expect(wireObject(opened.body)?.opened, JSON.stringify(opened.body).slice(0, 300)).toBe(true)
      let snapshot: Wire | undefined
      for (let attempt = 0; attempt < 10 && snapshot === undefined; attempt += 1) {
        const next = await send({ op: 'stream-next', id: streamId })
        const body = wireObject(next.body)
        expect(body?.failure, JSON.stringify(next.body).slice(0, 300)).toBeUndefined()
        if (body?.pending !== true) snapshot = body?.value
      }
      await send({ op: 'stream-cancel', id: streamId })
      expect(snapshot?.type, 'the viewer stream carries a snapshot').toBe('snapshot')
      return snapshot
    },
  }
}

/**
 * Build the Connection envelope the page's own RPC caller posts for one endpoint.
 * @param endpoint - Canonical Remote endpoint.
 * @param args - Decoded carrier arguments.
 * @param rpcId - Exact call identity, so a case can post the same logical request twice.
 * @returns The envelope the page posts.
 */
export function viewerEnvelope(endpoint: string, args: object, rpcId?: string): Wire {
  return {
    type: 'client-request',
    rpcId: rpcId ?? `acceptance-viewer-${endpoint}-${String(Date.now())}-${Math.random().toString(36).slice(2)}`,
    method: endpoint,
    payload: { args },
  }
}

/** What one accepted share reports back to the owner host. */
export interface PublishedShare {
  readonly shareId: string
  readonly sessionMode: string
}

/**
 * Verify the owner against one Relay and publish one share through the owner's Remote.
 *
 * This mirrors the owner's dialog: the credential still arrives over its own sign-in route, and the
 * share is created with the same request the page sends through `liveshareShares/create`.
 * @param owner - Running owner instance.
 * @param options - Session to share, the mode the owner chose, and the title to publish.
 * @param mint - Owner credential already minted against the Relay the owner is configured for.
 * @returns The published share's identity and the mode the owner stored.
 */
export async function publishShare(
  owner: WebOwner,
  options: { readonly sessionId: string; readonly sessionMode: string; readonly title: string; readonly allowsFork?: boolean },
  mint: string,
): Promise<PublishedShare> {
  const credential = await owner.post('/api/liveshare.ownerCredential', { credential: mint })
  // A host whose plugin failed to mount answers these paths with a plain 404, so the app's own
  // diagnostics travel with the failure rather than being discovered later.
  const why = (answer: { readonly status: number; readonly body: unknown }): string =>
    `status=${String(answer.status)} body=${JSON.stringify(answer.body).slice(0, 300)}`
    + ` stderr=${redact(owner.stderr().slice(-800)) || '<empty>'}`
  expect(credential.status, why(credential)).toBe(200)
  const created = await owner.rpc('liveshareShares/create', {
    request: {
      sessionId: options.sessionId,
      sessionTitle: options.title,
      accessMode: 'open',
      sessionMode: options.sessionMode,
      ...(options.allowsFork === undefined ? {} : { allowsFork: options.allowsFork }),
    },
  })
  const createdBody = wireObject(wireObject(created?.result)?.value)
  const createdWhy = `result=${JSON.stringify(created).slice(0, 400)}`
    + ` stderr=${redact(owner.stderr().slice(-800)) || '<empty>'}`
  expect(createdBody, createdWhy).toBeDefined()
  const shareId = String(createdBody?.shareId)
  expect(shareId.length, 'the share reports an id').toBeGreaterThan(0)
  expect(createdBody?.sessionMode, 'the share carries the mode the owner chose')
    .toBe(options.sessionMode)
  return { shareId, sessionMode: String(createdBody?.sessionMode) }
}

/** The Relay request function one viewer carrier posts through. */
export interface RelayRequests {
  request(path: string, options: RequestInit): Promise<Response>
}

/**
 * Build one viewer's carrier for a share it signed in to.
 * @param relay - Running Relay fixture.
 * @param shareId - Share this page was served for.
 * @param cookie - Viewer session cookie from the Relay's own login.
 * @returns The carrier the page's protocol uses.
 */
export function relayCarrier(relay: RelayRequests, shareId: string, cookie: string): ViewerCarrier {
  return createViewerCarrier(async (request) => {
    const response = await relay.request(`/__share/rpc?shareId=${encodeURIComponent(shareId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(request),
    })
    // A Relay that dropped the share answers plain text; keep it so the caller names the refusal.
    const text = await response.text()
    return {
      status: response.status,
      body: (() => {
        try {
          const parsed: unknown = JSON.parse(text)
          return parsed
        } catch {
          return redact(text).slice(0, 300)
        }
      })(),
    }
  })
}
