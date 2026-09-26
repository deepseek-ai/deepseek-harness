/**
 * Keyless REAL-composition coverage for dynamic child routing and parent cwd
 * inheritance across the SDK wire. A test-only patch boots through the
 * Loader, a scripted model selects provider/model/reasoning, tool config adds
 * maxTokens, and a COMPLETE second harness runtime echoes the effective route
 * and cwd. The same path also verifies model-visible child-failure diagnostics
 * remain separate from partial output.
 */

import { existsSync, realpathSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type SessionEvent } from '@deepseek-ai/dsh-session'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const fixtureDir = new URL('./fixtures/loader/', import.meta.url)
const driver = fileURLToPath(new URL('driver.ts', fixtureDir))
const configPath = fileURLToPath(new URL('dsh-sdk.patch.yml', fixtureDir))
const childConfigPath = fileURLToPath(new URL('child.patch.yml', fixtureDir))
const childMockPath = fileURLToPath(new URL('child-mock-llm.ts', fixtureDir))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

async function jsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return jsonlFiles(path)
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : []
  }))
  return paths.flat()
}

async function sessionEvents(log: string): Promise<SessionEvent[]> {
  const lines = (await readFile(log, 'utf8')).trimEnd().split('\n')
  return lines.slice(1).map(line => JSON.parse(line) as SessionEvent)
}

function toolResultText(events: SessionEvent[]): string {
  const results = events.filter(event => event.type === 'tool/result')
  expect(results).toHaveLength(1)
  return results[0]!.data.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

async function childLaunch(failure = false): Promise<{
  childHome: string
  env: Record<string, string>
}> {
  const childHome = await mkdtemp(join(tmpdir(), 'dsh-sdk-subagent-home-'))
  const childPatch = join(childHome, 'child.patch.yml')
  await writeFile(childPatch, (await readFile(childConfigPath, 'utf8'))
    .replace("'./child-mock-llm.ts'", JSON.stringify(pathToFileURL(childMockPath).href)))
  return {
    childHome,
    env: {
      DSH_TEST_CHILD_PATCHES: JSON.stringify([childPatch]),
      DSH_TEST_CHILD_HOME: childHome,
      ...(failure ? { DSH_TEST_CHILD_FAILURE: '1' } : {}),
    },
  }
}

describe('SDK subagent routing and diagnostics through the production profile', () => {
  it('runs the selected child route in the parent session workspace', async () => {
    const child = await childLaunch()
    let events: SessionEvent[] = []
    let childEvents: SessionEvent[] = []
    let parentResolvedRoutes: string[] = []
    let workspace = ''
    try {
      const { stderr } = await runLoaderSmoke({
        label: 'dsh-sdk-subagent cwd composition smoke',
        tempDirPrefix: 'dsh-sdk-subagent-cwd-e2e-',
        binScript: driver,
        libBinScript: driver,
        configPath,
        tsconfigPath: repoTsconfig,
        // Two complete harness runtimes boot in sequence (driver, then the SDK
        // child); from-source tsx boots under load need more than the default
        // 30s window.
        processTimeoutMs: 120_000,
        env: {
          ...child.env,
          DSH_TEST_CHILD_DEFAULT_ROUTE: '1',
          DSH_TEST_PARENT_MODEL_RECORD: '.parent-model-routes',
        },
        inspect: async (cwd) => {
          // The child reports realpaths; canonicalize the temp workspace to match.
          workspace = realpathSync(cwd)
          const parentLogs = await jsonlFiles(join(cwd, '.sessions'))
          expect(parentLogs).toHaveLength(1)
          events = await sessionEvents(parentLogs[0] as string)
          // The child runtime persists under its explicit isolated home.
          const childSessions = join(child.childHome, 'sessions')
          if (!existsSync(childSessions)) {
            const result = events.find(event => event.type === 'tool/result')
            throw new Error(`SDK child persisted no session; parent tool result: ${JSON.stringify(result?.data)}`)
          }
          const childLogs = await jsonlFiles(childSessions)
          expect(childLogs).toHaveLength(1)
          childEvents = await sessionEvents(childLogs[0] as string)
          parentResolvedRoutes = (await readFile(join(cwd, '.parent-model-routes'), 'utf8')).trim().split('\n')
        },
      })
      expect(stderr).not.toContain('UNHANDLED')

      // The parent's tool result carries the child model's echo of its real
      // process.cwd() — the parent session's workspace, never the harness
      // process's launch directory.
      const results = events.filter(event => event.type === 'tool/result')
      expect(results).toHaveLength(1)
      const resultText = results[0]!.data.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
      expect(resultText).toBe(`child route: mock/mock-routed/max/777; cwd: ${workspace}`)
      expect(parentResolvedRoutes).toContain('mock/mock-routed')

      // The child ran a real turn with the model-selected route and tool-configured cap.
      expect(childEvents.some(event => event.type === 'user/message')).toBe(true)
      const childHeader = childEvents.find(
        (event): event is Extract<SessionEvent, { type: 'request/header' }> => event.type === 'request/header',
      )
      expect(childHeader?.data.header.config).toEqual({
        provider: 'mock',
        model: 'mock-routed',
        reasoningEffort: 'max',
        maxTokens: 777,
      })
      const childAnswers = childEvents.filter(event => event.type === 'assistant/message')
      expect(childAnswers.length).toBeGreaterThan(0)
    } finally {
      await rm(child.childHome, { recursive: true, force: true })
    }
    // 15s of vitest headroom past the subprocess deadline, mirroring
    // LOADER_SMOKE_TEST_TIMEOUT_MS's margin over the default window.
  }, 135_000)

  it('presents the child error diagnostic separately from partial output', async () => {
    const child = await childLaunch(true)
    let events: SessionEvent[] = []
    try {
      const { stderr } = await runLoaderSmoke({
        label: 'dsh-sdk-subagent diagnostic composition smoke',
        tempDirPrefix: 'dsh-sdk-subagent-diagnostic-e2e-',
        binScript: driver,
        libBinScript: driver,
        configPath,
        tsconfigPath: repoTsconfig,
        processTimeoutMs: 120_000,
        env: child.env,
        inspect: async (cwd) => {
          const parentLogs = await jsonlFiles(join(cwd, '.sessions'))
          expect(parentLogs).toHaveLength(1)
          events = await sessionEvents(parentLogs[0] as string)
        },
      })
      expect(stderr).not.toContain('UNHANDLED')
      expect(toolResultText(events)).toBe(
        'Error: subagent run failed\n'
        + 'Diagnostic: Subagent failure (provider: DSH SDK; stage: session-run; category: child-error)\n'
        + 'Partial output before the run ended:\npartial child loader answer',
      )
    } finally {
      await rm(child.childHome, { recursive: true, force: true })
    }
  }, 135_000)
})
