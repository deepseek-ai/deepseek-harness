import { readFile, readdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  normalizeSessionLog,
  normalizeSessionSnapshot,
  normalizeSessionSnapshots,
  normalizeStdout,
  scrubRequestHeaders,
  type NormalizeContext,
} from '@deepseek-ai/dsh-session-snapshot'
import { prepareSessionEventNotificationsForComparison } from '@deepseek-ai/dsh-llm-replay'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import {
  decompressZstdFrame,
  scanZstdFrames,
} from '@deepseek-ai/dsh-session-persistence-jsonl/src/zstd.ts'
import { describe, expect, it } from 'vitest'

const goldensDir = fileURLToPath(new URL('./expected/', import.meta.url))
const goalScenarioDir = join(goldensDir, 'goal-tools')
const goalConfigPath = fileURLToPath(new URL('../goal-snapshot.patch.yml', import.meta.url))
const retryScenarioDir = join(goldensDir, 'provider-retry')
const retryConfigPath = fileURLToPath(new URL('../retry-snapshot.patch.yml', import.meta.url))
const credentialsScenarioDir = join(goldensDir, 'missing-credential')
const credentialsConfigPath = fileURLToPath(new URL('../credentials-snapshot.patch.yml', import.meta.url))
// Same keyless composition as the missing-credential scenario: the endpoint is
// never dialed either way, because a supplied-but-unusable key fails credential
// resolution exactly where an absent one does.
const invalidCredentialScenarioDir = join(goldensDir, 'invalid-credential')
const settlementScenarioDir = join(goldensDir, 'subagent-settlement')
const settlementConfigPath = fileURLToPath(new URL('../subagent-settlement-snapshot.patch.yml', import.meta.url))
const teamConfigPath = fileURLToPath(new URL('../team-snapshot.patch.yml', import.meta.url))
const startupFailureConfigPath = fileURLToPath(new URL('./fixtures/startup-activation-error/activation-error.patch.yml', import.meta.url))
const startupFailurePluginUrl = new URL('./fixtures/startup-activation-error/activation-error.mjs', import.meta.url).href
const startupFailureExpected = join(goldensDir, 'startup-activation-error', 'stderr.expected.txt')
const binScript = fileURLToPath(new URL('../../../../../../packages/test-support/loader-smoke/tests/fixtures/headless-driver.ts', import.meta.url))
const dshBinScript = fileURLToPath(new URL('../../../../src/bin.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../../../../tsconfig.json', import.meta.url))
const reasoningConfigPath = fileURLToPath(new URL('./fixtures/cli.patch.yml', import.meta.url))
const deepseekDefaultsConfigPath = fileURLToPath(new URL('./fixtures/deepseek-defaults.patch.yml', import.meta.url))
const piAiDefaultsConfigPath = fileURLToPath(new URL('./fixtures/pi-ai-defaults.patch.yml', import.meta.url))
const headlessOverlayPath = fileURLToPath(new URL('./fixtures/headless-profile.patch.yml', import.meta.url))
const headlessSessionExpected = join(goldensDir, 'headless-profile', 'session.expected.jsonl')
const headlessReasoningExpected = join(goldensDir, 'headless-profile', 'reasoning.stderr.expected.txt')
const headlessFailureExpected = join(goldensDir, 'headless-profile', 'stderr.expected.txt')
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'

interface JsonObject {
  [key: string]: unknown
}

interface PersistedLog {
  readonly content: string
  readonly header: JsonObject
}

interface DeepSeekDefaultsServer {
  readonly url: string
  readonly requests: JsonObject[]
  close(): Promise<void>
}

/** Compare one current Session with an older committed generation in memory. */
async function expectSessionSnapshot(
  actual: string,
  context: NormalizeContext,
  expectedPath: string,
): Promise<void> {
  const [normalizedActual] = normalizeSessionSnapshots([actual], context)
  const expected = await readFile(expectedPath, 'utf8')
  const [normalizedExpected] = normalizeSessionSnapshots([expected], context)
  expect(parseJsonl(normalizedActual ?? '')).toEqual(parseJsonl(normalizedExpected ?? ''))
}

/** Compare current headless session-event wrappers with a committed v1 stream. */
async function expectHeadlessStream(normalized: string, expectedPath: string): Promise<void> {
  const expected = prepareSessionEventNotificationsForComparison(await readFile(expectedPath, 'utf8'))
  expect(parseJsonl(normalized)).toEqual(parseJsonl(expected))
}

/** Serve one deterministic DeepSeek-compatible response while retaining its request body. */
async function deepseekDefaultsServer(): Promise<DeepSeekDefaultsServer> {
  const requests: JsonObject[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      requests.push(JSON.parse(body) as JsonObject)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      let keepAlives = 3
      const write = (): void => {
        if (keepAlives-- > 0) {
          response.write(': keep-alive\n\n')
          setTimeout(write, 60)
          return
        }
        response.end([
          'data: {"choices":[{"delta":{"content":"DEFAULTS_OK"}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
          'data: [DONE]',
          '',
        ].join('\n\n'))
      }
      setTimeout(write, 60)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('DeepSeek defaults snapshot server has no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise(resolve => server.close(() => { resolve() })),
  }
}

function parseJsonl(content: string): JsonObject[] {
  return content.split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as JsonObject)
}

function contextFromLogs(contents: readonly string[]): NormalizeContext {
  const headers = contents.map(content => parseJsonl(content)[0])
  return {
    sessionIds: headers.flatMap(header => typeof header?.id === 'string' ? [header.id] : []),
    cwd: typeof headers[0]?.cwd === 'string' ? headers[0].cwd : '\0no-cwd\0',
  }
}

function normalizeHeadlessStream(rawStdout: string, cwd: string): string {
  const records = parseJsonl(rawStdout)
  if (records.length === 0) throw new Error('headless snapshot emitted no stream-json records')
  const final = records.at(-1)
  if (final?.type !== 'result') throw new Error('headless snapshot did not end with a result record')
  if (records.slice(0, -1).some(record => record.type !== 'session_event')) {
    throw new Error('headless snapshot emitted a non-event record before its result')
  }

  const sessionIds = [...new Set(records.flatMap(record => typeof record.sessionId === 'string' ? [record.sessionId] : []))]
  if (sessionIds.length !== 1) throw new Error(`headless snapshot streamed ${sessionIds.length} main session ids`)
  const context: NormalizeContext = { sessionIds, cwd }
  const events = records.slice(0, -1).map((record) => {
    if (record.event === null || typeof record.event !== 'object' || Array.isArray(record.event)) {
      throw new Error('headless snapshot emitted an invalid session event')
    }
    return record.event as JsonObject
  })
  const normalizedEvents = parseJsonl(scrubRequestHeaders(normalizeSessionLog(
    `${events.map(event => JSON.stringify(event)).join('\n')}\n`,
    context,
  )))
  const normalizedRecords = records.map((record, index) => index < normalizedEvents.length
    ? { ...record, event: normalizedEvents[index] }
    : record)
  return normalizeStdout(`${normalizedRecords.map(record => JSON.stringify(record)).join('\n')}\n`, context)
}

/** Zero durable goal timestamps inside both metadata records and rendered XML JSON. */
function normalizeGoalTimestamps(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/("(?:createdAt|updatedAt|clearedAt)":)\d+/g, '$10')
  }
  if (Array.isArray(value)) return value.map(normalizeGoalTimestamps)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      ['createdAt', 'updatedAt', 'clearedAt'].includes(key) && typeof item === 'number'
        ? 0
        : normalizeGoalTimestamps(item),
    ]))
  }
  return value
}

/** Normalize the stream's durable goal timestamps after the shared scrubbers. */
function normalizeGoalStream(rawStdout: string, cwd: string): string {
  return parseJsonl(normalizeHeadlessStream(rawStdout, cwd))
    .map(record => JSON.stringify(normalizeGoalTimestamps(record)))
    .join('\n') + '\n'
}

async function scenarioPrompt(dir: string, label: string): Promise<string> {
  const input = JSON.parse(await readFile(join(dir, 'input.json'), 'utf8')) as {
    steps?: { op?: unknown; text?: unknown }[]
  }
  const prompt = input.steps?.find(step => step.op === 'prompt')?.text
  if (typeof prompt !== 'string') throw new Error(`${label} input has no prompt step`)
  return prompt
}

async function readPersistedLog(file: string): Promise<string> {
  const content = await readFile(file)
  if (!file.endsWith('.zstd')) return content.toString('utf8')
  const scan = scanZstdFrames(content)
  if (scan.tornStart !== undefined) throw new Error(`persisted snapshot log has a torn Zstandard frame: ${file}`)
  const decoded: Buffer[] = []
  for (const frame of scan.frames) {
    decoded.push(await decompressZstdFrame(content.subarray(frame.start, frame.end)))
  }
  return Buffer.concat(decoded).toString('utf8')
}

async function persistedLogs(cwd: string, root: string = join(cwd, '.sessions')): Promise<PersistedLog[]> {
  const files = (await readdir(root, { recursive: true }))
    .filter(file => file.endsWith('.jsonl') || file.endsWith('.jsonl.zstd'))
  return Promise.all(files.map(async (file) => {
    const content = await readPersistedLog(join(root, file))
    return { content, header: parseJsonl(content)[0] ?? {} }
  }))
}

describe('headless stream-json snapshots', () => {

  it('runs one task through the product headless profile command', async () => {
    const task = 'Prove the product headless profile path with one real tool round trip.'
    const result = await runLoaderSmoke({
      label: 'product headless profile snapshot',
      tempDirPrefix: 'headless-snapshot-profile-',
      binScript: dshBinScript,
      configPath: headlessOverlayPath,
      binArgs: ['--profile', 'headless', '--patch', headlessOverlayPath, task],
      tsconfigPath,
      env: {
        DSH_PERMISSION_MODE: 'danger-full-access',
        DSH_TELEMETRY_DISABLED: '1',
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
      },
      inspect: async (cwd) => {
        const logs = await persistedLogs(cwd, join(cwd, '.dsh', 'sessions'))
        expect(logs).toHaveLength(1)
        const actual = logs[0]
        if (actual === undefined) throw new Error('the headless profile did not persist its session')
        const context = contextFromLogs([actual.content])
        const session = normalizeSessionSnapshot(actual.content, context)
        if (refreshing) await writeFile(headlessSessionExpected, session)
        await expectSessionSnapshot(session, context, headlessSessionExpected)
        expect(session).toContain(task)
        expect(session).toContain('CLI tool round trip complete: CLI_TOOL_ROUND_TRIP')
      },
    })

    expect(result.stdout).toBe('CLI tool round trip complete: CLI_TOOL_ROUND_TRIP\n')
    if (refreshing) await writeFile(headlessReasoningExpected, result.stderr)
    expect(result.stderr).toBe(await readFile(headlessReasoningExpected, 'utf8'))
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('prints a terminal model failure through the product headless profile command', async () => {
    const result = await runLoaderSmoke({
      label: 'product headless profile model failure snapshot',
      tempDirPrefix: 'headless-snapshot-profile-failure-',
      binScript: dshBinScript,
      configPath: headlessOverlayPath,
      binArgs: ['--profile', 'headless', '--patch', headlessOverlayPath, 'Trigger the keyless model failure.'],
      tsconfigPath,
      expectedExitCode: 1,
      env: {
        DSH_CLI_MOCK_FAILURE: '1',
        DSH_TELEMETRY_DISABLED: '1',
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
      },
    })

    expect(result.stdout).toBe('\n')
    await expect(result.stderr).toMatchFileSnapshot(headlessFailureExpected)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('prints the original Loader activation error through the assembled one-shot app', async () => {
    const result = await runLoaderSmoke({
      label: 'headless startup activation error snapshot',
      tempDirPrefix: 'headless-snapshot-startup-error-',
      binScript,
      libBinScript: binScript,
      configPath: startupFailureConfigPath,
      binArgs: [startupFailureConfigPath, 'unreachable task'],
      tsconfigPath,
      expectedExitCode: 1,
    })
    expect(result.stdout).toBe('')
    await expect(result.stderr.replace(startupFailurePluginUrl, './activation-error.mjs'))
      .toMatchFileSnapshot(startupFailureExpected)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('retries a transient provider failure through the one-shot app', async () => {
    const prompt = await scenarioPrompt(retryScenarioDir, 'provider-retry')
    const streamExpected = join(retryScenarioDir, 'stream-json.expected.jsonl')
    let runCwd = ''
    const result = await runLoaderSmoke({
      label: 'provider retry headless stream-json snapshot',
      tempDirPrefix: 'headless-snapshot-provider-retry-',
      binScript,
      libBinScript: binScript,
      configPath: retryConfigPath,
      binArgs: [retryConfigPath, prompt],
      tsconfigPath,
      env: {
        DSH_SNAPSHOT: 'replay',
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
      },
      prepare: (cwd) => { runCwd = cwd },
      inspect: async (cwd) => {
        const logs = await persistedLogs(cwd)
        expect(logs).toHaveLength(1)
        const records = parseJsonl(logs[0]?.content ?? '')
        const retries = records.filter(record => record.type === 'llm/retry')
        expect(retries).toHaveLength(1)
        expect(retries[0]?.data).toMatchObject({
          provider: 'deepseek-official',
          mode: 'normal',
          policyKey: '["normal",1,["RATE_LIMIT"],1,1,0]',
          retry: 1,
          maxRetries: 1,
          delayMs: 1,
          failure: { message: 'snapshot transient failure', code: 'RATE_LIMIT', status: 429 },
        })
      },
    })

    expect(result.stderr).toBe('')
    const normalized = normalizeHeadlessStream(result.stdout, runCwd)
    if (refreshing) await writeFile(streamExpected, normalized)
    await expectHeadlessStream(normalized, streamExpected)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('logs actionable missing-credential guidance through the one-shot app', async () => {
    const streamExpected = join(credentialsScenarioDir, 'stream-json.expected.jsonl')
    let runCwd = ''
    const result = await runLoaderSmoke({
      label: 'missing-credential headless stream-json snapshot',
      tempDirPrefix: 'headless-snapshot-missing-credential-',
      binScript,
      libBinScript: binScript,
      configPath: credentialsConfigPath,
      binArgs: [credentialsConfigPath, 'say pong'],
      tsconfigPath,
      env: {
        // First-run posture: no key in the environment, none under ./.dsh.
        DEEPSEEK_API_KEY: '',
        DEEPSEEK_BASE_URL: '',
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
      },
      prepare: (cwd) => { runCwd = cwd },
    })

    // The failure reaches the caller through the stream, not stderr; the
    // recorded transcript below pins the guidance text itself, which names
    // both places a credential can come from and nothing else.
    expect(result.stderr).toBe('')
    const normalized = normalizeHeadlessStream(result.stdout, runCwd)
    if (refreshing) await writeFile(streamExpected, normalized)
    await expectHeadlessStream(normalized, streamExpected)
    // The durable failure leads with the credential store — the path that
    // keeps the secret out of configuration files — then names the launching
    // environment, and stops there: configuration carries the reference, so
    // there is no literal-key escape hatch left to offer.
    expect(normalized).toContain(
      'store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it),',
    )
    expect(normalized).toContain('or export DEEPSEEK_API_KEY in the launching environment')
    expect(normalized).not.toContain('as a last resort')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('logs actionable invalid-credential guidance through the one-shot app', async () => {
    const streamExpected = join(invalidCredentialScenarioDir, 'stream-json.expected.jsonl')
    let runCwd = ''
    const result = await runLoaderSmoke({
      label: 'invalid-credential headless stream-json snapshot',
      tempDirPrefix: 'headless-snapshot-invalid-credential-',
      binScript,
      libBinScript: binScript,
      configPath: credentialsConfigPath,
      binArgs: [credentialsConfigPath, 'say pong'],
      tsconfigPath,
      env: {
        // A key that exists but no HTTP header can carry — the paste the
        // credential guard exists for: without it, `fetch` refuses to build
        // the header and the turn ends on a retried ByteString TypeError.
        DEEPSEEK_API_KEY: 'sk-\u{1F600}pasted-from-a-chat-window',
        DEEPSEEK_BASE_URL: '',
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
      },
      prepare: (cwd) => { runCwd = cwd },
    })

    expect(result.stderr).toBe('')
    const normalized = normalizeHeadlessStream(result.stdout, runCwd)
    if (refreshing) await writeFile(streamExpected, normalized)
    await expectHeadlessStream(normalized, streamExpected)
    // The durable failure names the reference to correct and the writer that
    // usually owns it, and stays true in a composition that mounts no Models
    // page at all.
    expect(normalized).toContain('the API key resolved from DEEPSEEK_API_KEY contains characters')
    expect(normalized).toContain('the web Models page writes it')
    // Neither the key nor its transport-level symptom (the ByteString error)
    // may reach the user: the code point of one character is still the key.
    expect(normalized).not.toContain('pasted-from-a-chat-window')
    expect(normalized).not.toContain('ByteString')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('logs the model default and a dynamic next-step reasoning effort', async () => {
    const result = await runLoaderSmoke({
      label: 'reasoning effort headless stream-json snapshot',
      tempDirPrefix: 'headless-snapshot-reasoning-effort-',
      binScript,
      libBinScript: binScript,
      configPath: reasoningConfigPath,
      binArgs: [reasoningConfigPath, 'prove dynamic reasoning effort'],
      tsconfigPath,
    })

    expect(result.stderr).toBe('')
    const headers = parseJsonl(result.stdout)
      .map(record => record.event)
      .filter((event): event is JsonObject => (
        event !== null
        && typeof event === 'object'
        && !Array.isArray(event)
        && 'type' in event
        && event.type === 'request/header'
      ))
      .map((event) => {
        const data = event.data as JsonObject
        return (data.header as JsonObject).config
      })
    expect(headers).toMatchInlineSnapshot(`
      [
        {
          "model": "cli-mock",
          "provider": "cli-mock",
          "reasoningEffort": "high",
        },
        {
          "model": "cli-mock",
          "provider": "cli-mock",
          "reasoningEffort": "off",
        },
      ]
    `)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('keeps provider comments alive and sends DeepSeek defaults through the one-shot app', async () => {
    const server = await deepseekDefaultsServer()
    try {
      const result = await runLoaderSmoke({
        label: 'DeepSeek adapter defaults headless stream-json snapshot',
        tempDirPrefix: 'headless-snapshot-deepseek-defaults-',
        binScript,
        libBinScript: binScript,
        configPath: deepseekDefaultsConfigPath,
        binArgs: [
          deepseekDefaultsConfigPath,
          'return the deterministic response',
        ],
        tsconfigPath,
        env: {
          // Configuration carries only the reference; the key rides the
          // launching environment, which is the whole credential plane here.
          DEEPSEEK_API_KEY: 'snapshot-key',
          DSH_SNAPSHOT_BASE_URL: server.url,
          NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
        },
      })

      expect(result.stderr).toBe('')
      expect(server.requests).toHaveLength(2)
      const agentRequest = server.requests.find(request => request.max_tokens === 256_000)
      const titleRequest = server.requests.find(request => request.max_tokens === 64)
      expect(agentRequest?.reasoning_effort).toBe('low')
      expect(titleRequest).toBeDefined()
      const header = (parseJsonl(result.stdout)
        .map(record => record.event)
        .find((event): event is JsonObject => (
          event !== null
          && typeof event === 'object'
          && !Array.isArray(event)
          && 'type' in event
          && event.type === 'request/header'
        ))?.data as JsonObject | undefined)?.header as JsonObject | undefined
      expect(header?.config).toMatchInlineSnapshot(`
        {
          "maxTokens": 256000,
          "model": "deepseek-v4-flash",
          "provider": "deepseek-official",
          "reasoningEffort": "low",
        }
      `)
      expect(header?.adapterDefaults).toEqual({
        maxTokens: true,
        reasoningEffort: true,
      })
    } finally {
      await server.close()
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('sends pi-ai DeepSeek compatibility through the one-shot app', async () => {
    const server = await deepseekDefaultsServer()
    try {
      const result = await runLoaderSmoke({
        label: 'pi-ai DeepSeek compatibility headless stream-json snapshot',
        tempDirPrefix: 'headless-snapshot-pi-ai-defaults-',
        binScript,
        libBinScript: binScript,
        configPath: piAiDefaultsConfigPath,
        binArgs: [
          piAiDefaultsConfigPath,
          'return the deterministic response',
        ],
        tsconfigPath,
        env: {
          DEEPSEEK_API_KEY: 'snapshot-key',
          DSH_SNAPSHOT_BASE_URL: server.url,
          NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
        },
      })

      expect(result.stderr).toBe('')
      expect(server.requests).toHaveLength(2)
      const agentRequest = server.requests.find(request => request.max_tokens === 1024)
      const titleRequest = server.requests.find(request => request.max_tokens === 64)
      expect(agentRequest).not.toHaveProperty('max_completion_tokens')
      expect(titleRequest).toBeDefined()
      const header = (parseJsonl(result.stdout)
        .map(record => record.event)
        .find((event): event is JsonObject => (
          event !== null
          && typeof event === 'object'
          && !Array.isArray(event)
          && 'type' in event
          && event.type === 'request/header'
        ))?.data as JsonObject | undefined)?.header as JsonObject | undefined
      expect(header?.config).toMatchInlineSnapshot(`
        {
          "maxTokens": 1024,
          "model": "deepseek-v4-flash",
          "provider": "deepseek",
          "reasoningEffort": "low",
        }
      `)
      expect(header?.adapterDefaults).toEqual({
        maxTokens: true,
        reasoningEffort: true,
      })
    } finally {
      await server.close()
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('runs a keyless Agent Team with peer mail, dependent tasks, waiting, and Lead aggregation', async () => {
    let projection: unknown
    const result = await runLoaderSmoke({
      label: 'Agent Teams headless snapshot',
      tempDirPrefix: 'headless-snapshot-agent-team-',
      binScript,
      libBinScript: binScript,
      configPath: teamConfigPath,
      binArgs: [
        teamConfigPath,
        '请明确使用 Agent Teams，把调研和实现拆给两个 teammate，等待完成后汇总。',
      ],
      tsconfigPath,
      processTimeoutMs: 60_000,
      env: {
        DSH_SNAPSHOT: 'team',
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
      },
      inspect: async (cwd) => {
        const logs = await persistedLogs(cwd)
        const parent = logs.find(log => typeof log.header.parentSession !== 'string')
        if (parent === undefined) throw new Error('Agent Teams snapshot did not persist its Lead')
        const rows = parseJsonl(parent.content)
        const members = rows.filter(row => row.type === 'team/member')
          .map(row => ((row.data as JsonObject).member as JsonObject))
        const tasks = rows.filter(row => row.type === 'team/task')
          .map(row => ((row.data as JsonObject).task as JsonObject))
        const latestTasks = Object.values(Object.fromEntries(tasks.map(task => [String(task.subject), task])))
        const implementer = logs.find(log => typeof log.header.parentSession === 'string'
          && parseJsonl(log.content).some((row) => {
            if (row.type !== 'user/message') return false
            const content: unknown = (row.data as JsonObject).content
            return Array.isArray(content) && content.some((block: unknown) => (
              typeof block === 'object' && block !== null && !Array.isArray(block)
              && (block as JsonObject).type === 'text'
              && typeof (block as JsonObject).text === 'string'
              && ((block as JsonObject).text as string).includes('IMPLEMENTER_MARK')
            ))
          }))
        if (implementer === undefined) throw new Error('Agent Teams snapshot did not persist the implementer')
        const implementerRows = parseJsonl(implementer.content)
        const steeredInboxIndex = implementerRows.findIndex((row) => {
          if (row.type !== 'agent/inbox/spliced') return false
          const data = row.data as JsonObject
          const inserted: unknown = data.inserted
          return data.target === 'next-step' && Array.isArray(inserted)
            && inserted.some((message: unknown) => {
              if (typeof message !== 'object' || message === null || Array.isArray(message)) return false
              const source = (message as JsonObject).source
              return typeof source === 'object' && source !== null && !Array.isArray(source)
                && (source as JsonObject).kind === 'team-message'
            })
        })
        const steeredMessageIndex = implementerRows.findIndex((row) => {
          if (row.type !== 'user/message') return false
          const source = (row.data as JsonObject).source
          return typeof source === 'object' && source !== null && !Array.isArray(source)
            && (source as JsonObject).kind === 'team-message'
        })
        const openTurnStart = implementerRows.findLastIndex((row, index) => (
          index < steeredMessageIndex && row.type === 'turn/start'
        ))
        const openTurnEnd = implementerRows.findLastIndex((row, index) => (
          index < steeredMessageIndex && row.type === 'turn/end'
        ))
        const completionAfterSteer = implementerRows.some((row, index) => {
          if (index <= steeredMessageIndex || row.type !== 'tool/call') return false
          const data = row.data as JsonObject
          if (data.name !== 'team_task_update' || typeof data.arguments !== 'string') return false
          return (JSON.parse(data.arguments) as JsonObject).action === 'complete'
        })
        projection = {
          sessions: logs.length,
          memberEdges: members.length,
          activeMembers: members.filter(member => member.phase === 'active').map(member => member.name).sort(),
          tasks: latestTasks.map(task => ({
            subject: task.subject,
            revision: task.revision,
            status: task.status,
          })).sort((left, right) => String(left.subject).localeCompare(String(right.subject))),
          queuedMessages: rows.filter(row => row.type === 'team/message/queued').length,
          deliveredMessages: rows.filter(row => row.type === 'team/message/delivered').length,
          waited: rows.some(row => row.type === 'tool/call'
            && (row.data as JsonObject).name === 'wait_agent'),
          checkedRoster: rows.some(row => row.type === 'tool/call'
            && (row.data as JsonObject).name === 'list_agents'),
          steerEvidence: {
            nextStepInbox: steeredInboxIndex >= 0,
            messageEntered: steeredMessageIndex > steeredInboxIndex,
            enteredOpenTurn: openTurnStart > openTurnEnd,
            completedAfterMessage: completionAfterSteer,
          },
        }
      },
    })
    expect(result.stderr).toBe('')
    expect(parseJsonl(result.stdout).at(-1)).toMatchObject({
      type: 'result',
      output: 'TEAM_WORKFLOW_OK: both teammates and dependent tasks completed.',
    })
    expect(projection).toMatchInlineSnapshot(`
      {
        "activeMembers": [
          "implementer",
          "researcher",
        ],
        "checkedRoster": true,
        "deliveredMessages": 2,
        "memberEdges": 4,
        "queuedMessages": 2,
        "sessions": 3,
        "steerEvidence": {
          "completedAfterMessage": true,
          "enteredOpenTurn": true,
          "messageEntered": true,
          "nextStepInbox": true,
        },
        "tasks": [
          {
            "revision": 3,
            "status": "completed",
            "subject": "Implementation",
          },
          {
            "revision": 3,
            "status": "completed",
            "subject": "Research",
          },
        ],
        "waited": true,
      }
    `)
  }, 75_000)

  it('replays persisted goal tools through the one-shot app', async () => {
    const prompt = await scenarioPrompt(goalScenarioDir, 'goal-tools')
    const streamExpected = join(goalScenarioDir, 'stream-json.expected.jsonl')
    let runCwd = ''
    const result = await runLoaderSmoke({
      label: 'goal tools headless stream-json snapshot',
      tempDirPrefix: 'headless-snapshot-goal-tools-',
      binScript,
      libBinScript: binScript,
      configPath: goalConfigPath,
      binArgs: [goalConfigPath, prompt],
      tsconfigPath,
      env: {
        DSH_SNAPSHOT: 'replay',
        DSH_SNAPSHOT_FILE: join(goalScenarioDir, 'session.jsonl'),
        DSH_SNAPSHOT_OVERRIDE: join(goalScenarioDir, 'replay.override.json'),
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
      },
      prepare: (cwd) => { runCwd = cwd },
      inspect: async (cwd) => {
        const logs = await persistedLogs(cwd)
        expect(logs).toHaveLength(1)
        const records = parseJsonl(logs[0]?.content ?? '')
        const calls = records.filter(record => record.type === 'tool/call')
          .map(record => (record.data as JsonObject | undefined)?.name)
        expect(calls).toEqual(['update_goal', 'create_goal', 'get_goal'])
        const probeResult = records.find((record) => {
          if (record.type !== 'tool/result') return false
          const data = record.data as JsonObject | undefined
          const message = data?.message as JsonObject | undefined
          const source = message?.source as JsonObject | undefined
          return source?.callId === 'call_goal_probe'
        })
        const probeData = probeResult?.data as JsonObject | undefined
        const probeMessage = probeData?.message as JsonObject | undefined
        const probeContent = probeMessage?.content as JsonObject[] | undefined
        expect(probeContent?.[0]?.isError).toBe(true)
        expect((probeData?.error as JsonObject | undefined)?.code).toBe('GOAL_NOT_FOUND')
        const goalChanges = records.filter(record => record.type === 'goal/change')
        expect(goalChanges).toHaveLength(1)
        const data = goalChanges[0]?.data as JsonObject | undefined
        const goal = data?.goal as JsonObject | undefined
        expect(data?.operation).toBe('create')
        expect(goal).toMatchObject({
          objective: 'Finish the headless goal-tool snapshot proof',
          phase: 'active',
          maxGoalRounds: 7,
        })
      },
    })

    expect(result.stderr).toBe('')
    const normalized = normalizeGoalStream(result.stdout, runCwd)
    if (refreshing) await writeFile(streamExpected, normalized)
    await expectHeadlessStream(normalized, streamExpected)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('delivers a continuable child result without parent polling', async () => {
    const parentReplay = join(settlementScenarioDir, 'parent.replay.jsonl')
    const parentOverride = join(settlementScenarioDir, 'parent.override.json')
    const childReplay = join(settlementScenarioDir, 'child.replay.jsonl')
    const childExpected = join(settlementScenarioDir, 'child.expected.jsonl')
    const streamExpected = join(settlementScenarioDir, 'stream-json.expected.jsonl')
    const task = 'Start one continuable background subagent and answer from its completion notice. Do not call list_agents, send_message, job_output, or job_list.'
    let runCwd = ''
    const result = await runLoaderSmoke({
      label: 'continuable settlement headless stream-json snapshot',
      tempDirPrefix: 'headless-snapshot-subagent-settlement-',
      binScript,
      libBinScript: binScript,
      configPath: settlementConfigPath,
      binArgs: [settlementConfigPath, task],
      tsconfigPath,
      env: {
        // The override fully supplies the parent script; the child fixture
        // remains separate so replay binds it to the fresh child Session.
        DSH_SNAPSHOT_FILE: parentReplay,
        DSH_SNAPSHOT_OVERRIDE: parentOverride,
        DSH_SNAPSHOT_CHILD_FILES: childReplay,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
      },
      prepare: (cwd) => { runCwd = cwd },
      inspect: async (cwd) => {
        const logs = await persistedLogs(cwd)
        expect(logs).toHaveLength(2)
        const parent = logs.find(log => typeof log.header.parentSession !== 'string')
        const child = logs.find(log => typeof log.header.parentSession === 'string')
        if (parent === undefined || child === undefined) throw new Error('missing persisted parent or child log')

        const parentRecords = parseJsonl(parent.content)
        const calls = parentRecords.filter(record => record.type === 'tool/call')
        expect(calls.map(record => (record.data as JsonObject | undefined)?.name)).toEqual(['subagent'])
        const callArguments = (calls[0]?.data as JsonObject | undefined)?.arguments
        if (typeof callArguments !== 'string') throw new Error('subagent call did not persist its arguments')
        expect(JSON.parse(callArguments)).not.toHaveProperty('run_in_background')

        const notices = parentRecords.flatMap((record) => {
          if (record.type !== 'agent/inbox/spliced') return []
          const inserted = (record.data as JsonObject | undefined)?.inserted
          if (!Array.isArray(inserted)) return []
          return (inserted as JsonObject[]).filter((message) => {
            const source = message.source as JsonObject | undefined
            return source?.kind === 'subagent-settled'
          })
        })
        expect(notices).toHaveLength(1)
        expect(JSON.stringify(notices[0])).toContain('CHILD_RESULT')

        const context = contextFromLogs([parent.content, child.content])
        const normalizedChild = normalizeSessionSnapshot(child.content, context)
        if (refreshing) await writeFile(childExpected, normalizedChild)
        await expectSessionSnapshot(normalizedChild, context, childExpected)
        expect(normalizedChild).toContain('CHILD_RESULT')
        expect(normalizedChild).not.toContain('"name":"report"')
      },
    })

    expect(result.stderr).toBe('')
    const records = parseJsonl(result.stdout)
    expect(records.at(-1)).toMatchObject({
      type: 'result',
      output: 'PARENT_RECEIVED_CHILD_RESULT',
    })
    const normalized = normalizeHeadlessStream(result.stdout, runCwd)
    if (refreshing) await writeFile(streamExpected, normalized)
    await expectHeadlessStream(normalized, streamExpected)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
