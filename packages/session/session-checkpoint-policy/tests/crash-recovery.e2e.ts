import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SessionStore, {
  SessionId, TOOL_OUTCOME_UNKNOWN, interruptedTurnClosers,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const childScript = fileURLToPath(new URL('./fixtures/crash-child.ts', import.meta.url))
const tsxLoader = fileURLToPath(import.meta.resolve('tsx'))
const sessionId = SessionId('semantic-checkpoint-crash')
const roots: string[] = []
const CHILD_FAILPOINT_TIMEOUT_MS = 30_000

async function waitForMarker(path: string, expected: string): Promise<string> {
  // vi.waitFor retries every callback throw, so terminal states RESOLVE out
  // of the retry loop (complete marker, or content that can no longer become
  // the expected marker) and only the still-in-progress states throw-to-retry.
  const content = await vi.waitFor(async () => {
    const current = await readFile(path, 'utf8').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      throw new Error(`crash child did not publish failpoint ${JSON.stringify(expected)} at ${path}`, { cause: error })
    })
    if (current === expected || !expected.startsWith(current)) return current
    throw new Error(`crash child has not finished publishing failpoint ${JSON.stringify(expected)}`)
  }, { interval: 10, timeout: CHILD_FAILPOINT_TIMEOUT_MS })
  if (content !== expected) {
    throw new Error(`crash child wrote unexpected failpoint ${JSON.stringify(content)}`)
  }
  return content
}

async function crashAt(mode: 'request' | 'tool'): Promise<{ root: string; markerText: string }> {
  const root = await mkdtemp(join(tmpdir(), `dsh-semantic-${mode}-`))
  roots.push(root)
  const marker = join(root, 'failpoint')
  // Keep the open-before-write window deterministic: readiness is marker content, not path existence.
  await writeFile(marker, '')
  const expectedMarker = mode === 'request' ? 'request-dispatched' : 'tool-side-effect'
  // The SIGKILL-at-failpoint choreography stays custom: the child must die
  // mid-write, so no timeout or graceful termination may reach it first.
  const child = execa(process.execPath, ['--import', tsxLoader, childScript, mode, root, marker], {
    cwd: repoRoot,
    env: { TSX_TSCONFIG_PATH: join(repoRoot, 'tsconfig.json') },
    stdin: 'ignore',
    stdout: 'ignore',
    reject: false,
  })
  try {
    const markerText = await waitForMarker(marker, expectedMarker)
    child.kill('SIGKILL')
    const exit = await child
    expect({ code: exit.exitCode ?? null, signal: exit.signal ?? null }).toEqual({ code: null, signal: 'SIGKILL' })
    return { root, markerText }
  } catch (error: unknown) {
    child.kill('SIGKILL')
    throw new Error(`crash child failed: ${(await child).stderr}`, { cause: error })
  }
}

// Read the crashed durable log and balance it the way a resuming reader does:
// the stored events stay untouched; `interruptedTurnClosers` supplies the
// in-memory closers for the interrupted tail turn.
async function load(root: string): Promise<SessionEvent[]> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  try {
    const handle = await ctx.sessionPersistence.open(sessionId, 'read')
    try {
      const events = await handle.read()
      return [...events, ...interruptedTurnClosers(events)]
    } finally {
      await handle.close()
    }
  } finally {
    await ctx.fiber.dispose()
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe.skipIf(process.platform === 'win32')('semantic checkpoint hard-crash recovery', () => {
  it('persists the complete request before model dispatch', async () => {
    const crashed = await crashAt('request')
    expect(crashed.markerText).toBe('request-dispatched')
    const events = await load(crashed.root)
    expect(events.map(event => event.type)).toEqual([
      'agent/inbox/spliced', 'turn/start', 'agent/inbox/spliced',
      'step/start', 'user/message', 'request/header', 'request/context', 'step/end', 'turn/end',
    ])
    expect(events.at(-1)).toMatchObject({
      type: 'turn/end', data: { reason: { kind: 'interrupted' } },
    })
  })

  it('persists tool intent before a side effect and repairs its missing result as unknown', async () => {
    const crashed = await crashAt('tool')
    expect(crashed.markerText).toBe('tool-side-effect')
    const events = await load(crashed.root)
    expect(events.some(event => event.type === 'assistant/message')).toBe(true)
    expect(events.some(event => event.type === 'tool/call')).toBe(true)
    const result = events.find(event => event.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.error).toEqual({
      name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN,
    })
    if (result?.type !== 'tool/result' || result.data.message.content[0].content[0]?.type !== 'text') {
      throw new Error('expected a text tool result')
    }
    expect(result.data.message.content[0].content[0].text).toContain('Do not retry blindly.')
  })
})
