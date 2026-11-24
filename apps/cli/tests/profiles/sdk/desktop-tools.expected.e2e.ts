/**
 * Keyless comparison of the first model request of the shipped SDK profile with native tool execution and the Desktop
 * standard agent preset: tool names and schemas, system prompt sections, runtime context values, the session skill
 * catalog, the other injected messages, and the order of each sequence, for the top-level Agent with Team off and on.
 * Paths, clock readings and the time zone are normalized. Record differences in parity-exceptions.ts; unused
 * exceptions fail. Teammate scopes, PTC execution, SDK minimal, other presets, graphical context and optional runtime
 * payloads are outside this comparison.
 */
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { z } from 'zod'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { expect, it, type TestContext } from 'vitest'
import { profileEnvironment } from './fixtures/profile-environment.ts'
import { messagesResponse } from './fixtures/messages-response.ts'
import { assertParity, compareEntries, compareOrder, type ParityDifference } from './parity.ts'

const repo = fileURLToPath(new URL('../../../../../', import.meta.url))
const observer = new URL('./fixtures/tool-parity.mjs', import.meta.url).href
const probe = new URL('./fixtures/parity-probe.mjs', import.meta.url).href
const inventorySchema = z.object({
  tools: z.array(z.looseObject({ name: z.string() })).min(1),
  sections: z.array(z.object({ name: z.string(), text: z.string() })).min(1),
  contexts: z.array(z.object({ name: z.string(), text: z.string() })),
  hmr: z.boolean(),
})
type Observation = z.infer<typeof inventorySchema>
/** One side's model context: the assembly observation and the injected messages of its first model request. */
type Inventory = Observation & { skills: ReadonlyMap<string, string>; messages: ReadonlyMap<string, string> }
const runtimeLayers = ['tool', 'schema', 'section', 'skill', 'message', 'order'] as const
/** Both sides run in UTC, and the Desktop user message reports it as the browser time zone, as the GUI client does. */
const TIME_ZONE = 'UTC'
const TIMESTAMP = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)/g
/** Messages compared in other layers: the user prompt, the rendered runtime context entries and the skill catalog. */
const STRUCTURED_MESSAGES = ['Inspect tools', 'The following information describes your current session', 'A skill is a reusable set of task-specific instructions.']

const requestMessagesSchema = z.array(z.object({
  content: z.union([z.string(), z.array(z.looseObject({ type: z.string(), text: z.string().optional() }))]),
}))

/** The text blocks of a Messages API request's messages, in order. */
function texts(messages: unknown): string[] {
  return requestMessagesSchema.parse(messages).flatMap(({ content }) => typeof content === 'string'
    ? [content]
    : content.flatMap(block => block.type === 'text' && block.text !== undefined ? [block.text] : []))
}

/**
 * Read the session skill catalog that tool-skill sends as a user message rather than a prompt section.
 * @param messages - the first model request's messages.
 * @returns skill descriptions by name.
 */
function skillCatalog(messages: unknown): Map<string, string> {
  const catalog = texts(messages).map(text => /<available_skills>\n([^]*?)<\/available_skills>/.exec(text)).find(match => match !== null)
  if (catalog === undefined) throw new Error('The first model request carries no skill catalog')
  return new Map([...catalog[1]!.matchAll(/^- `([^`]+)`: (.*)$/gm)].map(([, name, description]) => [name!, description!]))
}

/**
 * Key each injected text message of the first request by its first line up to a colon, with clock readings replaced.
 * @param messages - the first model request's messages.
 * @returns message text by first line, without the messages other layers compare.
 */
function injectedMessages(messages: unknown): Map<string, string> {
  const injected = new Map<string, string>()
  for (const text of texts(messages)) {
    const normalized = text.replaceAll(TIMESTAMP, '<time>')
    const label = normalized.replace(/^<system-reminder>\n/, '').split('\n', 1)[0]!.split(':', 1)[0]!
    if (STRUCTURED_MESSAGES.some(prefix => label.startsWith(prefix))) continue
    if (injected.has(label)) throw new Error(`Two injected messages start with ${JSON.stringify(label)}`)
    injected.set(label, normalized)
  }
  return injected
}

function names(inventory: Inventory): string[] {
  return inventory.tools.map(tool => tool.name)
}

function differences(sdk: Inventory, desktop: Inventory): ParityDifference[] {
  const prompt = (inventory: Inventory) => new Map<string, unknown>([
    ...inventory.sections.map(({ name, text }) => [name, text] as const),
    ...inventory.contexts.map(({ name, text }) => [`runtime-context/${name}`, text] as const),
  ])
  return [
    ...compareEntries('tool', 'schema', new Map(sdk.tools.map(tool => [tool.name, tool])), new Map(desktop.tools.map(tool => [tool.name, tool]))),
    ...compareEntries('section', 'section', prompt(sdk), prompt(desktop)),
    ...compareEntries('skill', 'skill', sdk.skills, desktop.skills),
    ...compareEntries('message', 'message', sdk.messages, desktop.messages),
    ...compareOrder('section', sdk.sections.map(({ name }) => name), desktop.sections.map(({ name }) => name)),
    ...compareOrder('runtime-context', sdk.contexts.map(({ name }) => name), desktop.contexts.map(({ name }) => name)),
    ...compareOrder('message', [...sdk.messages.keys()], [...desktop.messages.keys()]),
    ...compareOrder('tool', names(sdk), names(desktop)),
  ]
}

function assertContextParity(sdk: Inventory, desktop: Inventory): void {
  assertParity(runtimeLayers, differences(sdk, desktop))
}

async function fixture(test: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'sdk-desktop-tools-'))
  const requests: { tools: { name: string }[]; messages: unknown }[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      requests.push(JSON.parse(body) as { tools: { name: string }[]; messages: unknown })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(messagesResponse({ type: 'text', text: 'tools inspected' }, 'end_turn'))
    })
  })
  test.onTestFinished(async () => {
    try {
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      }))
    }
    finally { await rm(root, { recursive: true, force: true }) }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('model fixture has no TCP address')
  const env = { ...profileEnvironment(root, `http://127.0.0.1:${address.port}`), TZ: TIME_ZONE }

  async function collect(side: 'sdk' | 'desktop', mutations: object[] = []): Promise<Inventory> {
    const cwd = await mkdtemp(join(root, `${side}-`))
    const output = join(cwd, 'tools.json')
    const patch = join(cwd, 'observer.patch.yml')
    await writeFile(patch, JSON.stringify([
      { id: 'session-title-llm', disabled: true },
      { insert: [{ id: 'tool-parity-observer', name: observer,
        config: { output, cwd, directories: { '<cwd>': cwd, '<root>': root },
          ...(side === 'desktop' ? { preset: 'standard', clientTimeZone: TIME_ZONE } : {}) } }] },
      ...mutations,
    ]))
    const before = requests.length
    let inventory: Observation
    if (side === 'sdk') {
      const harness = new DeepSeekHarness({
        cwd, processCwd: cwd, dshHome: join(cwd, 'home'), env, model: 'deepseek-v4-pro',
        patches: [patch],
      })
      const abort = (): void => { void harness.close() }
      test.signal.addEventListener('abort', abort, { once: true })
      try {
        const result = await harness.session('tool-parity').run('Inspect tools')
        expect(result.finalResponse).toBe('tools inspected')
        inventory = inventorySchema.parse(JSON.parse(await readFile(output, 'utf8')))
      } finally {
        await harness.close()
        test.signal.removeEventListener('abort', abort)
      }
      expect(inventory.hmr).toBe(false)
    } else {
      // Desktop composes the Web template's bundles; the CLI reserves the `desktop` name for the Electron Host. The
      // rows that switch on that name and reach the model read DSH_PRIMARY_RUNTIME, which both sides leave empty.
      const child = execa(process.execPath, [join(repo, 'apps/cli/lib/bin.js'), '--profile', 'web',
        '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
        cwd, env: { ...env, DSH_HOME: join(cwd, 'home') }, extendEnv: false,
        ipc: true, stdin: 'ignore', reject: false, cancelSignal: test.signal, forceKillAfterDelay: 10_000,
      })
      let stdout = ''
      let stderr = ''
      const ready = Promise.withResolvers<true>()
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
        if (stdout.includes('dsh web: http://')) ready.resolve(true)
      })
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      void child.then((result) => { ready.reject(new Error(`Web exited: ${result.exitCode}\n${stderr}`)) })
      try {
        await ready.promise
        const reply = child.getOneMessage()
        await child.sendMessage('collect-tool-parity')
        const message = z.object({ result: inventorySchema.optional(), error: z.string().optional() }).parse(await reply)
        if (message.error !== undefined) throw new Error(message.error)
        inventory = inventorySchema.parse(message.result)
      } catch (error) {
        throw new Error(`Web collection failed\n${stdout}\n${stderr}`, { cause: error })
      } finally {
        // Ask the CLI to drain on Windows too, where an OS signal kills immediately.
        const watchdog = setTimeout(() => { child.kill('SIGKILL') }, 10_000)
        try {
          try { await child.sendMessage('stop-tool-parity') }
          catch (_closedChannel: unknown) {
            // A closed IPC channel cannot request graceful shutdown; fall back to the OS signal.
            child.kill('SIGTERM')
          }
          const result = await child
          expect(result.exitCode, result.stderr).toBe(0)
          expect(result.signal, result.stderr).toBeUndefined()
        } finally { clearTimeout(watchdog) }
      }
      expect(inventory.hmr).toBe(true)
    }
    expect(requests.length).toBeGreaterThan(before)
    const presented = requests[before]!.tools.map(tool => tool.name).sort()
    expect(presented).toEqual(inventory.tools.map(tool => tool.name))
    const { messages } = requests[before]!
    return { ...inventory, skills: skillCatalog(messages), messages: injectedMessages(messages) }
  }
  return collect
}

it('compares the shipped model context and permits explicit opt-out', async (test) => {
  const collect = await fixture(test)
  const sdk = await collect('sdk')
  const desktop = await collect('desktop')
  assertContextParity(sdk, desktop)
  expect(names(sdk)).toContain('plugin_manager')
  const optOut = await collect('sdk', [{ id: 'tool-plugin-manager', disabled: true }])
  expect(names(optOut)).not.toContain('plugin_manager')
  expect(() => { assertContextParity(optOut, desktop) }).toThrow('tool plugin_manager (desktop only)')
})

it('compares the shipped top-level Agent context with Team on', async (test) => {
  const collect = await fixture(test)
  const team = [{ id: 'agent-team', config: { maxTasks: 256, defaultEnabled: true } }]
  const sdk = await collect('sdk', team)
  const desktop = await collect('desktop', team)
  for (const side of [sdk, desktop]) expect(names(side)).toEqual(expect.arrayContaining(['team_task_create', 'team_task_list']))
  assertContextParity(sdk, desktop)
})

it('detects missing shared tools', async (test) => {
  const collect = await fixture(test)
  const desktop = await collect('desktop')
  for (const [id, tool] of [['present', 'present'], ['tool-ask-user', 'ask_user_question'], ['tool-schedule', 'schedule_create']]) {
    const missing = await collect('sdk', [{ id, disabled: true }])
    expect(() => { assertContextParity(missing, desktop) }).toThrow(`tool ${tool} (desktop only)`)
  }
})

it('detects one-sided additions', async (test) => {
  const collect = await fixture(test)
  const sdk = await collect('sdk')
  const desktop = await collect('desktop')
  const addition = [{ insert: [{ id: 'parity-probe', name: probe }] }]
  const desktopExtra = await collect('desktop', addition)
  expect(() => { assertContextParity(sdk, desktopExtra) }).toThrow('tool parity_probe (desktop only)')
  const sdkExtra = await collect('sdk', addition)
  expect(() => { assertContextParity(sdkExtra, desktop) }).toThrow('tool parity_probe (sdk only)')
  assertContextParity(sdkExtra, desktopExtra)
})
