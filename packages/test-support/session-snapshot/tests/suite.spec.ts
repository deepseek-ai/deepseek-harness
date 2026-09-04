import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  assertPersistedSessionVersion,
  assertSessionFixtureVersion,
  defineAcpSnapshotSuite,
  latestPersistedSessionPaths,
  parsePersistedSessionFilename,
  parseSessionFixtureName,
  persistedSessionFilename,
  sessionFixtureName,
  sessionFixtureNames,
  sessionHeaderVersion,
  stabilizeFixtureMessageIds,
  tokenizeSessionFixtureCwd,
  type HarvestedLog,
  type Scenario,
} from '../src/index.ts'
import {
  assertChildSystemPromptSnapshot,
  assertUniqueSnapshotContents,
  claimSharedSnapshot,
  fixtureContext,
  formatSystemPromptSnapshot,
  headerChangeCount,
  formatToolSchemasSnapshot,
  normalizedHeaders,
  normalizedSystemPrompts,
  normalizedToolSchemas,
  parseToolSchemasSnapshot,
  refreshFixtureReplacements,
  scenarioSkipped,
  restorePinnedToolSchemas,
  type SharedSnapshotClaim,
  stabilizeRefreshLog,
  stdoutExpectedVariants,
  unknownToolCallIds,
} from '../src/suite.ts'

/**
 * Unit tests for the suite factory, by running it: two synthetic suites over the scripted fake
 * ACP bin (./fixtures/fake-acp-agent.ts) register real describe/it trees at collection time,
 * so every factory path — expected-output and log comparisons, the per-suite header pin and its uniformity
 * guard, record-mode fixture write-back, skip semantics, and the fixture guard block —
 * executes as an ordinary green test.
 *
 * Record tests use a temp copy. To intentionally rebuild their committed fixtures, run this
 * spec once with `ACP_SNAPSHOT_SPEC_BOOTSTRAP=1`, then review and commit the resulting tree.
 */

const fakeAgent = fileURLToPath(new URL('./fixtures/fake-acp-agent.ts', import.meta.url))
const AGENT = {
  binScript: fakeAgent,
  libBinScript: fakeAgent,
  configPath: fakeAgent,
  tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
}

const REPLAY_DIR = fileURLToPath(new URL('./fixtures/suite', import.meta.url))

function stabilize(
  fresh: string,
  existing: string,
  replacements: Parameters<typeof stabilizeRefreshLog>[2] = [],
  freshContext: Parameters<typeof stabilizeRefreshLog>[3] = fixtureContext(fresh),
): string {
  return stabilizeRefreshLog(fresh, existing, replacements, freshContext)
}
const RECORD_SRC = fileURLToPath(new URL('./fixtures/record-suite', import.meta.url))

// Replay pins explicit header classes; recording covers the default fallback.
const REPLAY_SCENARIOS: Scenario[] = [
  { name: 'pin-turn', hasModelTurn: true, recorded: true, pinsHeader: true, expectedHeaderChanges: 1, headerClass: 'main' },
  {
    name: 'shared-pin',
    hasModelTurn: true,
    recorded: true,
    pinsHeader: true,
    expectedHeaderChanges: 1,
    headerClass: 'shared',
    systemPromptSource: 'pin-turn',
    toolSchemasSource: 'pin-turn',
  },
  {
    name: 'plain-turn',
    hasModelTurn: true,
    recorded: true,
    headerClass: 'main',
    env: { DSH_PERMISSION_MODE: 'never' },
    configPath: AGENT.configPath,
    workspaceParent: tmpdir(),
    pinsChildToolSchemas: [1],
    pinsChildSystemPrompts: [1],
    prepareWorkspace: (cwd) => {
      writeFileSync(join(cwd, 'seed.txt'), 'prepared at runtime')
    },
  },
  { name: 'no-model', hasModelTurn: false, recorded: false, headerClass: 'main' },
  { name: 'blocked-log', hasModelTurn: false, comparesLog: true, recorded: false, headerClass: 'main' },
  { name: 'authored-error', hasModelTurn: true, recorded: false, overridden: true, headerClass: 'main' },
]

const RECORD_SCENARIOS: Scenario[] = [
  { name: 'rec-pin', hasModelTurn: true, recorded: true, pinsHeader: true },
  { name: 'rec-child', hasModelTurn: true, recorded: true, pinsChildToolSchemas: [1] },
  // recorded:false in record mode → registered but skipped (never re-recorded).
  { name: 'rec-skip', hasModelTurn: true, recorded: false, overridden: true },
]

// Record/refresh modes mutate their snapshots dir, so run them on throwaway
// copies — except record's documented bootstrap knob, which regenerates the
// committed record fixtures and expected outputs in place.
const BOOTSTRAP = process.env.ACP_SNAPSHOT_SPEC_BOOTSTRAP === '1'
const recordDir = BOOTSTRAP ? RECORD_SRC : mkdtempSync(join(tmpdir(), 'acp-snap-record-suite-'))
const retiredChildFixture = readFileSync(join(RECORD_SRC, 'rec-child', 'session.1.jsonl'), 'utf8')
if (!BOOTSTRAP) {
  cpSync(RECORD_SRC, recordDir, { recursive: true })
  // Record mode owns its output inventory: a new scenario has no primary yet,
  // while a changed child count can leave old numbered fixtures behind.
  rmSync(join(recordDir, 'rec-pin', 'session.jsonl'))
  writeFileSync(join(recordDir, 'rec-child', 'session.2.jsonl'), retiredChildFixture)
}
const refreshDir = mkdtempSync(join(tmpdir(), 'acp-snap-refresh-suite-'))
cpSync(REPLAY_DIR, refreshDir, { recursive: true })
staleRefreshFixtures(refreshDir)
afterAll(async () => {
  if (!BOOTSTRAP) await rm(recordDir, { recursive: true, force: true })
  await rm(refreshDir, { recursive: true, force: true })
})

function staleRefreshFixtures(dir: string): void {
  writeFileSync(join(dir, 'plain-turn', 'stdout.expected.jsonl'), 'stale stdout\n')
  writeFileSync(join(dir, 'pin-turn', 'system-prompt.expected.md'), 'STALE PROMPT\n')
  writeFileSync(join(dir, 'pin-turn', 'tool-schemas.expected.json'), '{"initial":[{"name":"stale"}],"changes":[]}\n')
  writeFileSync(join(dir, 'plain-turn', 'tool-schemas.1.expected.json'), '{"initial":[{"name":"stale-child"}],"changes":[]}\n')
  writeFileSync(join(dir, 'plain-turn', 'system-prompt.1.expected.md'), 'STALE CHILD PROMPT\n')

  const plainBehaviorFile = join(dir, 'plain-turn', 'behavior.json')
  const plainBehavior = JSON.parse(readFileSync(plainBehaviorFile, 'utf8')) as Record<string, unknown>
  plainBehavior.echoEnv = true
  writeFileSync(plainBehaviorFile, `${JSON.stringify(plainBehavior, null, 2)}\n`)

  writeFileSync(join(dir, 'blocked-log', 'session.jsonl'), [
    '{"type":"session","id":"99999999-8888-4777-8666-555555555555","createdAt":13,"cwd":"/rec/blocked-cwd","delegationDepth":0}',
    '{"type":"hook/result","seq":0,"time":13,"data":{"decision":"stale","durationMs":99}}',
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'authored-error', 'session.jsonl'), [
    '{"type":"session","id":"77777777-8888-4777-8666-555555555555","createdAt":13,"cwd":"/rec/error-cwd","delegationDepth":0}',
    '{"type":"turn/end","seq":0,"time":9,"data":{"error":"stale"}}',
    '',
  ].join('\n'))
}

describe('defineAcpSnapshotSuite: replay mode', () => {
  defineAcpSnapshotSuite({ agent: AGENT, snapshotsDir: REPLAY_DIR, scenarios: REPLAY_SCENARIOS, mode: 'replay' })
})

// The record suite's tests run in registration order: rec-pin re-records the
// pinned fixture FIRST, so rec-child's uniformity guard reads the fresh pin.
describe('defineAcpSnapshotSuite: record mode', () => {
  defineAcpSnapshotSuite({ agent: AGENT, snapshotsDir: recordDir, scenarios: RECORD_SCENARIOS, mode: 'record' })
})

describe('defineAcpSnapshotSuite: refresh mode', () => {
  defineAcpSnapshotSuite({ agent: AGENT, snapshotsDir: refreshDir, scenarios: REPLAY_SCENARIOS, mode: 'refresh' })
})

describe('defineAcpSnapshotSuite: refresh write-back', () => {
  it('rewrites stdout and comparable logs from a replay-mode child run', () => {
    const stdout = readFileSync(join(refreshDir, 'plain-turn', 'stdout.expected.jsonl'), 'utf8')
    expect(stdout).not.toContain('stale stdout')
    expect(stdout).toContain('env:{\\"mode\\":\\"replay\\"')
    expect(stdout).not.toContain('\\"mode\\":\\"refresh\\"')
    // The scenario's own env layer reached the subprocess.
    expect(stdout).toContain('\\"permissionMode\\":\\"never\\"')

    const blocked = readFileSync(join(refreshDir, 'blocked-log', 'session.v2.jsonl'), 'utf8')
    expect(blocked).toContain('"decision":"block"')
    expect(blocked).not.toContain('"decision":"stale"')

    const authored = readFileSync(join(refreshDir, 'authored-error', 'session.v2.jsonl'), 'utf8')
    expect(authored).toContain('"message":"model exploded"')
    expect(authored).not.toContain('"error":"stale"')

    expect(readFileSync(join(refreshDir, 'pin-turn', 'system-prompt.expected.md'), 'utf8')).toBe([
      'SYS PROMPT',
      '',
      '<!-- request/header change 1 -->',
      '',
      'SYS PROMPT',
      '',
      'NEW PROMPT LINE',
      '',
    ].join('\n'))
    const schemas = readFileSync(join(refreshDir, 'pin-turn', 'tool-schemas.expected.json'), 'utf8')
    expect(schemas).toContain('"description": "D1"')
    expect(schemas).not.toContain('"name":"stale"')
    const childSchemas = readFileSync(join(refreshDir, 'plain-turn', 'tool-schemas.1.expected.json'), 'utf8')
    expect(childSchemas).toContain('"name": "child-only"')
    expect(childSchemas).not.toContain('stale-child')
    const childPrompt = readFileSync(join(refreshDir, 'plain-turn', 'system-prompt.1.expected.md'), 'utf8')
    expect(childPrompt).toBe('SYS PROMPT\n\nCHILD GUIDANCE\n')

    const pinSession = readFileSync(join(refreshDir, 'pin-turn', 'session.v2.jsonl'), 'utf8')
    expect(pinSession).toContain('"cwd":"{{cwd}}"')
    expect(readFileSync(join(refreshDir, 'pin-turn', 'session.jsonl'), 'utf8'))
      .not.toContain('"version"')
  })
})

describe('defineAcpSnapshotSuite: record inventory write-back', () => {
  it('creates a missing primary fixture and preserves generations for a retired child role', () => {
    const fixture = readFileSync(join(recordDir, 'rec-pin', 'session.v2.jsonl'), 'utf8')
    expect(fixture).toContain('"type":"session"')
    expect(fixture).toContain('"cwd":"{{cwd}}"')
    if (!BOOTSTRAP) {
      expect(readFileSync(join(recordDir, 'rec-child', 'session.2.jsonl'), 'utf8')).toBe(retiredChildFixture)
    }
    expect(readFileSync(join(recordDir, 'rec-child', 'tool-schemas.1.expected.json'), 'utf8'))
      .toContain('"name": "t1"')
  })

  it('retains an unchanged message relationship across the recorded parent and child fixtures', () => {
    const existingMessageId = '22222222-2222-4222-8222-222222222222'
    const freshMessageId = '11111111-1111-4111-8111-111111111111'
    const fixtures = ['session.v2.jsonl', 'session.1.v2.jsonl']
      .map(file => readFileSync(join(recordDir, 'rec-child', file), 'utf8'))

    for (const fixture of fixtures) {
      expect(fixture).toContain('"id":"{{message:1}}"')
      expect(fixture).not.toContain(existingMessageId)
      expect(fixture).not.toContain(freshMessageId)
    }
  })
})

describe('defineAcpSnapshotSuite: registration contract', () => {
  it("throws when a scenario's header class has no pinning scenario", () => {
    expect(() => {
      defineAcpSnapshotSuite({
        agent: AGENT,
        snapshotsDir: REPLAY_DIR,
        scenarios: [{ name: 'pinless', hasModelTurn: true, recorded: true }],
        mode: 'replay',
      })
    }).toThrow(/no scenario pins the request-header content of class "default"/)
    // A pinned class does not cover a DIFFERENT class's members.
    expect(() => {
      defineAcpSnapshotSuite({
        agent: AGENT,
        snapshotsDir: REPLAY_DIR,
        scenarios: [
          { name: 'pinned', hasModelTurn: true, recorded: true, pinsHeader: true },
          { name: 'classless-orphan', hasModelTurn: true, recorded: true, headerClass: 'other' },
        ],
        mode: 'replay',
      })
    }).toThrow(/class "other" \(needed by classless-orphan\)/)
  })

  it('throws when two scenarios pin the same header class', () => {
    expect(() => {
      defineAcpSnapshotSuite({
        agent: AGENT,
        snapshotsDir: REPLAY_DIR,
        scenarios: [
          { name: 'first-pin', hasModelTurn: true, recorded: true, pinsHeader: true },
          { name: 'second-pin', hasModelTurn: true, recorded: true, pinsHeader: true },
        ],
        mode: 'replay',
      })
    }).toThrow(/header class "default" pinned by both first-pin and second-pin/)
  })

  it('throws when scenario names are duplicated', () => {
    expect(() => {
      defineAcpSnapshotSuite({
        agent: AGENT,
        snapshotsDir: REPLAY_DIR,
        scenarios: [
          { name: 'duplicate', hasModelTurn: true, recorded: true, pinsHeader: true },
          { name: 'duplicate', hasModelTurn: true, recorded: true },
        ],
        mode: 'replay',
      })
    }).toThrow(/duplicate scenario name "duplicate"/)
  })

  it.each(['systemPromptSource', 'toolSchemasSource'] as const)(
    'rejects %s away from a header pin',
    (field) => {
      expect(() => {
        defineAcpSnapshotSuite({
          agent: AGENT,
          snapshotsDir: REPLAY_DIR,
          scenarios: [{
            name: 'plain',
            hasModelTurn: true,
            recorded: true,
            [field]: 'owner',
          }],
          mode: 'replay',
        })
      }).toThrow(new RegExp(`plain\\.${field} is only valid on a header-pinning scenario`))
    },
  )

  it('rejects an unknown or non-pinning sidecar source', () => {
    expect(() => {
      defineAcpSnapshotSuite({
        agent: AGENT,
        snapshotsDir: REPLAY_DIR,
        scenarios: [{
          name: 'pin',
          hasModelTurn: true,
          recorded: true,
          pinsHeader: true,
          systemPromptSource: 'missing',
        }],
        mode: 'replay',
      })
    }).toThrow(/pin names unknown system-prompt snapshot source "missing"/)

    expect(() => {
      defineAcpSnapshotSuite({
        agent: AGENT,
        snapshotsDir: REPLAY_DIR,
        scenarios: [
          {
            name: 'pin',
            hasModelTurn: true,
            recorded: true,
            pinsHeader: true,
            toolSchemasSource: 'plain',
          },
          { name: 'plain', hasModelTurn: true, recorded: true },
        ],
        mode: 'replay',
      })
    }).toThrow(/pin names non-pinning tool-schema snapshot source "plain"/)
  })

  it('rejects a sidecar source that redirects the same artifact', () => {
    expect(() => {
      defineAcpSnapshotSuite({
        agent: AGENT,
        snapshotsDir: REPLAY_DIR,
        scenarios: [
          { name: 'owner', hasModelTurn: true, recorded: true, pinsHeader: true },
          {
            name: 'redirect',
            hasModelTurn: true,
            recorded: true,
            pinsHeader: true,
            headerClass: 'redirect',
            systemPromptSource: 'owner',
          },
          {
            name: 'consumer',
            hasModelTurn: true,
            recorded: true,
            pinsHeader: true,
            headerClass: 'consumer',
            systemPromptSource: 'redirect',
          },
        ],
        mode: 'replay',
      })
    }).toThrow(/consumer names system-prompt snapshot source "redirect", which does not own its sidecar/)
  })

  it('rejects shared sidecars with different header-change counts', () => {
    expect(() => {
      defineAcpSnapshotSuite({
        agent: AGENT,
        snapshotsDir: REPLAY_DIR,
        scenarios: [
          {
            name: 'owner',
            hasModelTurn: true,
            recorded: true,
            pinsHeader: true,
            expectedHeaderChanges: 1,
          },
          {
            name: 'consumer',
            hasModelTurn: true,
            recorded: true,
            pinsHeader: true,
            headerClass: 'consumer',
            toolSchemasSource: 'owner',
          },
        ],
        mode: 'replay',
      })
    }).toThrow(/consumer and owner declare different header-change counts for shared tool-schema snapshot/)
  })
})

describe('shared snapshot content', () => {
  it('accepts identical claims and rejects order-dependent shared output', () => {
    const claims = new Map<string, SharedSnapshotClaim>()
    claimSharedSnapshot(claims, 'shared/system-prompt.expected.md', 'first', 'prompt\n')
    claimSharedSnapshot(claims, 'shared/system-prompt.expected.md', 'second', 'prompt\n')
    expect(claims.get('shared/system-prompt.expected.md')).toEqual({
      scenario: 'first',
      content: 'prompt\n',
    })
    expect(() => {
      claimSharedSnapshot(claims, 'shared/system-prompt.expected.md', 'third', 'different\n')
    }).toThrow(/diverged between first and third/)
  })

  it('rejects identical committed content under different paths', () => {
    assertUniqueSnapshotContents('prompt', [
      { path: 'one/system-prompt.expected.md', content: 'one\n' },
      { path: 'two/system-prompt.expected.md', content: 'two\n' },
    ])
    expect(() => {
      assertUniqueSnapshotContents('prompt', [
        { path: 'one/system-prompt.expected.md', content: 'same\n' },
        { path: 'two/system-prompt.expected.md', content: 'same\n' },
      ])
    }).toThrow(/identical prompt snapshots appear in one\/system-prompt\.expected\.md and two\/system-prompt\.expected\.md/)
  })
})

describe('sessionFixtureNames', () => {
  it('selects the highest generation for each contiguous role while ignoring other files', () => {
    expect(sessionFixtureNames([
      'stdout.expected.jsonl',
      'session.2.jsonl',
      'session.jsonl',
      'session.1.jsonl',
      'session.v2.jsonl',
      'session.v1.jsonl',
      'session.1.v3.jsonl',
      'input.json',
    ])).toEqual(['session.v2.jsonl', 'session.1.v3.jsonl', 'session.2.jsonl'])
  })

  it('accepts a primary-only scenario', () => {
    expect(sessionFixtureNames(['session.jsonl'])).toEqual(['session.jsonl'])
  })

  it('rejects a directory without the primary fixture', () => {
    expect(() => sessionFixtureNames(['session.1.jsonl'])).toThrow('missing parent session fixture')
  })

  it('rejects gapped child fixtures', () => {
    expect(() => sessionFixtureNames(['session.jsonl', 'session.2.jsonl']))
      .toThrow('expected index 1, found session.2.jsonl')
  })

  it.each([
    'session.0.jsonl',
    'session.child.jsonl',
    'session.01.jsonl',
    'session.v0.jsonl',
    'session.V1.jsonl',
    'session.v01.jsonl',
    'session.1.v0.jsonl',
  ])(
    'rejects invalid fixture name %s',
    (name) => {
      expect(() => sessionFixtureNames(['session.jsonl', name]))
        .toThrow(`invalid session fixture name: ${name}`)
    },
  )

  it('rejects duplicate role generations', () => {
    expect(() => sessionFixtureNames(['session.jsonl', 'session.1.jsonl', 'session.1.jsonl']))
      .toThrow('duplicate session fixture generation: session.1.jsonl')
  })
})

describe('Session generation filename helpers', () => {
  it('renders canonical parent, child, raw, and compressed names', () => {
    expect(sessionFixtureName(0, 0)).toBe('session.jsonl')
    expect(sessionFixtureName(0, 2)).toBe('session.v2.jsonl')
    expect(sessionFixtureName(3, 0)).toBe('session.3.jsonl')
    expect(sessionFixtureName(3, 2)).toBe('session.3.v2.jsonl')
    expect(persistedSessionFilename(0)).toBe('session.jsonl')
    expect(persistedSessionFilename(2, 'zstd')).toBe('session.v2.jsonl.zstd')
  })

  it.each([
    () => sessionFixtureName(-1, 0),
    () => sessionFixtureName(-0, 0),
    () => sessionFixtureName(0.5, 0),
    () => sessionFixtureName(0, -1),
    () => persistedSessionFilename(Number.MAX_SAFE_INTEGER + 1),
  ])('rejects invalid numeric filename components', (render) => {
    expect(render).toThrow(/non-negative safe integer/)
  })

  it('parses canonical fixture and persistence names without admitting lookalikes', () => {
    expect(parseSessionFixtureName('session.2.v3.jsonl')).toEqual({ index: 2, version: 3, name: 'session.2.v3.jsonl' })
    expect(parseSessionFixtureName('notes.jsonl')).toBeUndefined()
    expect(() => parseSessionFixtureName(`session.${'9'.repeat(400)}.jsonl`))
      .toThrow('invalid session fixture name')
    expect(parsePersistedSessionFilename('session.jsonl')).toEqual({ version: 0, compression: 'raw', name: 'session.jsonl' })
    expect(parsePersistedSessionFilename('session.v4.jsonl.zstd')).toEqual({ version: 4, compression: 'zstd', name: 'session.v4.jsonl.zstd' })
    expect(parsePersistedSessionFilename('session.1.jsonl')).toBeUndefined()
    expect(parsePersistedSessionFilename(`session.v${'9'.repeat(400)}.jsonl`)).toBeUndefined()
  })

  it('selects one highest persisted generation per directory and compression', () => {
    const paths = [
      'b/session.v1.jsonl',
      'b/session.jsonl',
      'a/session.jsonl',
      'a/session.v2.jsonl',
      'a/session.v3.jsonl.zstd',
      'a/session.v2.20260101.backup.jsonl',
      'noise.jsonl',
    ]
    expect(latestPersistedSessionPaths(paths)).toEqual(['a/session.v2.jsonl', 'b/session.v1.jsonl'])
    expect(latestPersistedSessionPaths(paths, 'zstd')).toEqual(['a/session.v3.jsonl.zstd'])
  })

  it('validates filename and header generation equality', () => {
    const v0 = '{"type":"session","version":0}\n'
    const v1 = '{"type":"session","version":1}\n'
    expect(sessionHeaderVersion(v1, 'fixture')).toBe(1)
    expect(assertSessionFixtureVersion('session.jsonl', v0)).toBe(0)
    expect(assertPersistedSessionVersion('session.v1.jsonl', v1)).toBe(1)
    expect(() => assertSessionFixtureVersion('notes.jsonl', v0)).toThrow('not a session fixture name')
    expect(assertSessionFixtureVersion('session.jsonl', '{"type":"session"}\n')).toBe(0)
    expect(() => assertSessionFixtureVersion('session.v1.jsonl', '{"type":"session"}\n'))
      .toThrow('a versionless projected Session header is format v0')
    expect(() => assertSessionFixtureVersion('session.jsonl', '')).toThrow('session fixture is empty')
    expect(() => assertSessionFixtureVersion('session.jsonl', '{')).toThrow('session header contains invalid JSON')
    expect(() => assertPersistedSessionVersion('session.1.jsonl', v0)).toThrow('not a canonical Session persistence filename')
    expect(() => assertSessionFixtureVersion('session.v1.jsonl', v0))
      .toThrow('filename declares Session format v1, header declares v0')
    expect(() => assertPersistedSessionVersion('session.jsonl', v1))
      .toThrow('filename declares Session format v0, header declares v1')
  })

  it.each([
    ['', 'session fixture is empty'],
    ['{', 'session header contains invalid JSON'],
    ['[]', 'first record must be a Session header'],
    ['{"type":"event","version":0}', 'first record must be a Session header'],
    ['{"type":"session"}', 'version must be a non-negative safe integer'],
    ['{"type":"session","version":-1}', 'version must be a non-negative safe integer'],
    ['{"type":"session","version":-0}', 'version must be a non-negative safe integer'],
    ['{"type":"session","version":1.5}', 'version must be a non-negative safe integer'],
  ])('rejects malformed header %j', (content, message) => {
    expect(() => sessionHeaderVersion(content, 'bad.jsonl')).toThrow(message)
  })
})

describe('stdoutExpectedVariants', () => {
  const scenario: Scenario = {
    name: 'windows-native',
    hasModelTurn: true,
    recorded: true,
    pinsNativeWindowsStdout: true,
  }

  it('adds the native sidecar after the shared golden on Windows', () => {
    expect(stdoutExpectedVariants(scenario, 'win32')).toEqual([
      { file: 'stdout.expected.jsonl', cwdPathMode: 'canonical' },
      { file: 'stdout.expected.windows.jsonl', cwdPathMode: 'native' },
    ])
  })

  it('keeps only the shared golden on other platforms or without the declaration', () => {
    expect(stdoutExpectedVariants(scenario, 'linux')).toEqual([
      { file: 'stdout.expected.jsonl', cwdPathMode: 'canonical' },
    ])
    expect(stdoutExpectedVariants({ ...scenario, pinsNativeWindowsStdout: false }, 'win32')).toEqual([
      { file: 'stdout.expected.jsonl', cwdPathMode: 'canonical' },
    ])
  })
})

describe('scenarioSkipped', () => {
  const authored: Scenario = { name: 'authored', hasModelTurn: true, recorded: false }
  const posix: Scenario = { name: 'posix-cancel', hasModelTurn: true, recorded: false, posixOnly: true }
  const pwsh: Scenario = { name: 'pwsh-tool', hasModelTurn: true, recorded: false, pwshOnly: true }
  const retained: Scenario = {
    name: 'retained-v0',
    hasModelTurn: true,
    recorded: true,
    sessionFormat: { version: 0, coverage: ['multi-hop'] },
  }

  it('skips authored scenarios only while recording', () => {
    expect(scenarioSkipped(authored, true, 'linux')).toBe(true)
    expect(scenarioSkipped(authored, false, 'linux')).toBe(false)
  })

  it('skips a retained historical generation while recording but replays and refreshes it', () => {
    expect(scenarioSkipped(retained, true, 'linux')).toBe(true)
    expect(scenarioSkipped(retained, false, 'linux')).toBe(false)
  })

  it('skips posixOnly scenarios on Windows and nowhere else', () => {
    expect(scenarioSkipped(posix, false, 'win32')).toBe(true)
    expect(scenarioSkipped(posix, false, 'linux')).toBe(false)
    expect(scenarioSkipped(posix, false, 'darwin')).toBe(false)
    expect(scenarioSkipped(authored, false, 'win32')).toBe(false)
  })

  it('skips pwshOnly scenarios when the host lacks pwsh, and runs them otherwise', () => {
    expect(scenarioSkipped(pwsh, false, 'linux', false)).toBe(true)
    expect(scenarioSkipped(pwsh, false, 'win32', true)).toBe(false)
    expect(scenarioSkipped(pwsh, false, 'linux', true)).toBe(false)
    expect(scenarioSkipped(authored, false, 'linux', false)).toBe(false)
  })
})

describe('fixtureContext', () => {
  it('reads the fixture header id and cwd', () => {
    const ctx = fixtureContext('{"type":"session","id":"abc","cwd":"/rec"}\n{"type":"turn/start"}\n')
    expect(ctx).toEqual({ sessionIds: ['abc'], cwd: '/rec' })
  })

  it('yields no session ids for a header without a string id', () => {
    expect(fixtureContext('{"type":"session","cwd":"/rec"}\n').sessionIds).toEqual([])
  })

  it('falls back to an impossible sentinel cwd (never the empty string)', () => {
    const ctx = fixtureContext('{"type":"session","id":"abc"}\n')
    expect(ctx.cwd).toBe('\0no-cwd\0')
    expect(ctx.cwd).not.toBe('')
  })

  it('treats an empty fixture as an empty header', () => {
    expect(fixtureContext('')).toEqual({ sessionIds: [], cwd: '\0no-cwd\0' })
  })
})

describe('normalizedHeaders', () => {
  const header = (system: string): string => JSON.stringify({
    type: 'request/header', seq: 0, time: 9, data: { header: { config: { model: 'm' }, system }, reason: 'initial' },
  })

  it('extracts every request/header payload in log order, normalized', () => {
    const id = '11111111-2222-4333-8444-555555555555'
    const log = `${JSON.stringify({ type: 'session', id, createdAt: 5, cwd: '/w' })}\n${header('one')}\n`
      + `${JSON.stringify({ type: 'turn/start', seq: 1, time: 9, data: { turn: 1 } })}\n${header('two')}\n`
    const headers = normalizedHeaders(log, { sessionIds: [id], cwd: '/w' })
    expect(headers).toEqual([
      { config: { model: 'm' }, system: 'one' },
      { config: { model: 'm' }, system: 'two' },
    ])
  })

  it('yields nothing for a log without header events', () => {
    const log = `${JSON.stringify({ type: 'session', id: 'a', createdAt: 5 })}\n`
    expect(normalizedHeaders(log, { sessionIds: [], cwd: '/w' })).toEqual([])
  })
})

describe('normalizedSystemPrompts', () => {
  it('extracts normalized string prompts and omits absent or non-string fields', () => {
    const log = [
      '{"type":"session","id":"a","createdAt":5,"cwd":"/w"}',
      '{"type":"request/header","seq":0,"time":9,"data":{"header":{"system":"work in /w"}}}',
      '{"type":"request/header","seq":1,"time":9,"data":{"header":{}}}',
      '{"type":"request/header","seq":2,"time":9,"data":{"header":{"system":null}}}',
      '{"type":"request/header","seq":3,"time":9,"data":{"header":null}}',
      '{"type":"request/header","seq":4,"time":9,"data":{"header":"invalid"}}',
      '',
    ].join('\n')
    expect(normalizedSystemPrompts(log, { sessionIds: [], cwd: '/w' })).toEqual(['work in {{cwd}}'])
  })
})

describe('normalizedToolSchemas', () => {
  it('extracts normalized schema arrays and omits absent or non-array fields', () => {
    const log = [
      '{"type":"session","id":"a","createdAt":5,"cwd":"/w"}',
      '{"type":"request/header","seq":0,"time":9,"data":{"header":{"tools":[{"name":"read","description":"work in /w"}]}}}',
      '{"type":"request/header","seq":1,"time":9,"data":{"header":{}}}',
      '{"type":"request/header","seq":2,"time":9,"data":{"header":{"tools":null}}}',
      '{"type":"request/header","seq":3,"time":9,"data":{"header":null}}',
      '{"type":"request/header","seq":4,"time":9,"data":{"header":"invalid"}}',
      '',
    ].join('\n')
    expect(normalizedToolSchemas(log, { sessionIds: [], cwd: '/w' })).toEqual([
      [{ name: 'read', description: 'work in {{cwd}}' }],
    ])
  })
})

describe('formatSystemPromptSnapshot', () => {
  it('adds a missing terminal newline without changing an existing one', () => {
    expect(formatSystemPromptSnapshot('prompt')).toBe('prompt\n')
    expect(formatSystemPromptSnapshot('prompt\n')).toBe('prompt\n')
  })

  it('renders readable changed-prompt sections', () => {
    expect(formatSystemPromptSnapshot('prompt', ['new\nlines']))
      .toBe('prompt\n\n<!-- request/header change 1 -->\n\nnew\nlines\n')
  })

  it('does not double the newline of a changed prompt', () => {
    expect(formatSystemPromptSnapshot('prompt\n', ['changed\n']))
      .toBe('prompt\n\n<!-- request/header change 1 -->\n\nchanged\n')
  })
})

describe('assertChildSystemPromptSnapshot', () => {
  const label = 'plain-turn/system-prompt.1.expected.md'

  it('accepts a distinct non-empty canonical child prompt', () => {
    expect(() => {
      assertChildSystemPromptSnapshot('SYS PROMPT\n\nCHILD GUIDANCE\n', 'SYS PROMPT\n', label)
    }).not.toThrow()
  })

  it('rejects an empty or non-canonical child prompt', () => {
    expect(() => { assertChildSystemPromptSnapshot('\n', 'SYS PROMPT\n', label) }).toThrow(/non-empty prompt/)
    expect(() => {
      assertChildSystemPromptSnapshot('CHILD GUIDANCE', 'SYS PROMPT\n', label)
    }).toThrow(/end in a newline/)
  })

  it('rejects a child prompt that duplicates its class pin', () => {
    const classSnapshot = readFileSync(join(REPLAY_DIR, 'pin-turn', 'system-prompt.expected.md'), 'utf8')
    const marker = classSnapshot.indexOf('\n<!-- request/header change ')
    expect(marker).toBeGreaterThan(0)
    const initialClassPin = classSnapshot.slice(0, marker)

    expect(() => {
      assertChildSystemPromptSnapshot(initialClassPin, initialClassPin, label)
    }).toThrow(/must differ from its class pin/)
  })
})

describe('headerChangeCount', () => {
  it('counts changed request headers, ignoring anchors, blanks, and other lines', () => {
    const change = JSON.stringify({ type: 'request/header', seq: 2, time: 9, data: { reason: 'change' } })
    const anchor = JSON.stringify({ type: 'request/header', seq: 0, time: 9, data: { reason: 'initial' } })
    const other = JSON.stringify({ type: 'turn/start', seq: 1, time: 9, data: {} })
    expect(headerChangeCount(`${anchor}\n${other}\n\n${change}\n${change}\n`)).toBe(2)
    expect(headerChangeCount(`${anchor}\n`)).toBe(0)
  })
})

describe('tool-schema snapshots', () => {
  const snapshot = {
    initial: [{ name: 'read', description: 'Read a file.' }],
    changes: [[{ name: 'grep', description: 'Search files.' }]],
  }

  it('formats and parses canonical structured JSON', () => {
    const formatted = formatToolSchemasSnapshot(snapshot.initial, snapshot.changes)
    expect(formatted).toBe(`${JSON.stringify(snapshot, null, 2)}\n`)
    expect(parseToolSchemasSnapshot(formatted)).toEqual(snapshot)
  })

  it('rejects invalid top-level and field shapes', () => {
    expect(() => parseToolSchemasSnapshot('null')).toThrow(/must be an object/)
    expect(() => parseToolSchemasSnapshot('"invalid"')).toThrow(/must be an object/)
    expect(() => parseToolSchemasSnapshot('[]')).toThrow(/must be an object/)
    expect(() => parseToolSchemasSnapshot('{"initial":{},"changes":[]}')).toThrow(/array-valued/)
    expect(() => parseToolSchemasSnapshot('{"initial":[],"changes":{}}')).toThrow(/array-valued/)
    expect(() => parseToolSchemasSnapshot('{"initial":[],"changes":[{}]}')).toThrow(/array-valued/)
  })

  it('restores initial schemas into the pinned header token', () => {
    expect(restorePinnedToolSchemas({ system: '{{system}}', tools: '{{tools}}' }, snapshot.initial))
      .toEqual({ system: '{{system}}', tools: snapshot.initial })
  })

  it('rejects invalid headers and a missing tool token', () => {
    expect(() => restorePinnedToolSchemas(null, snapshot.initial)).toThrow(/must be an object/)
    expect(() => restorePinnedToolSchemas('invalid', snapshot.initial)).toThrow(/must be an object/)
    expect(() => restorePinnedToolSchemas([], snapshot.initial)).toThrow(/must be an object/)
    expect(() => restorePinnedToolSchemas({ tools: [] }, snapshot.initial)).toThrow(/must equal/)
  })
})

describe('unknownToolCallIds', () => {
  it('returns structured UNKNOWN_TOOL call ids and ignores other results', () => {
    const log = [
      '{"type":"tool/result","data":{"message":{"source":{"kind":"tool","callId":"missing"}},"error":{"code":"UNKNOWN_TOOL"}}}',
      '{"type":"tool/result","data":{"message":{"source":{"kind":"tool","callId":"failed"}},"error":{"code":"EXECUTION_FAILED"}}}',
      '{"type":"tool/result","data":null}',
      '{"type":"tool/result","data":"invalid"}',
      '{"type":"tool/result","data":{"error":null}}',
      '{"type":"tool/result","data":{"error":"invalid"}}',
      '{"type":"assistant/message","data":{"error":{"code":"UNKNOWN_TOOL"}}}',
      '{"type":"tool/result","data":{"error":{"code":"UNKNOWN_TOOL"}}}',
      '',
    ].join('\n')
    expect(unknownToolCallIds(log)).toEqual(['missing', '<missing callId>'])
  })

  it('returns no failures for ordinary tool results', () => {
    expect(unknownToolCallIds('{"type":"tool/result","data":{"message":{"source":{"kind":"tool","callId":"ok"}}}}\n')).toEqual([])
  })
})

describe('stabilizeFixtureMessageIds', () => {
  it('reuses one committed message UUID across fixture-ready parent and child logs', () => {
    const freshId = '11111111-1111-4111-8111-111111111111'
    const existingId = '22222222-2222-4222-8222-222222222222'
    const log = (session: string, id: string): string => [
      JSON.stringify({ type: 'session', id: session, cwd: '{{cwd}}' }),
      JSON.stringify({
        type: 'user/message',
        data: { role: 'user', content: [{ type: 'text', text: 'same' }], source: { kind: 'user' }, id },
      }),
      '',
    ].join('\n')
    const fresh = [log('fresh-parent', freshId), log('fresh-child', freshId)]
    const existing = [log('old-parent', existingId), log('old-child', existingId)]

    const stable = stabilizeFixtureMessageIds(fresh, existing)

    expect(stable).toHaveLength(2)
    for (const fixture of stable) {
      expect(fixture).toContain(`"id":"${existingId}"`)
      expect(fixture).not.toContain(freshId)
    }
  })

  it('rewrites only complete messages carried by surface events or durable inbox splices', () => {
    const ids = {
      freshUser: '11111111-1111-4111-8111-111111111111',
      oldUser: '22222222-2222-4222-8222-222222222222',
      freshAssistant: '33333333-3333-4333-8333-333333333333',
      oldAssistant: '44444444-4444-4444-8444-444444444444',
      freshTool: '55555555-5555-4555-8555-555555555555',
      oldTool: '66666666-6666-4666-8666-666666666666',
      oldMalformed: '77777777-7777-4777-8777-777777777777',
    } as const
    const message = (id: string, role: string, text: string): Record<string, unknown> => ({
      id,
      role,
      content: [{ type: 'text', text }],
      source: { kind: role === 'user' ? 'user' : 'model' },
    })
    const log = (userId: string, assistantId: string, toolId: string, malformedId: string): string => [
      JSON.stringify({ type: 'session', id: 'same', cwd: '{{cwd}}' }),
      JSON.stringify({
        type: 'agent/inbox/spliced',
        data: {
          inserted: [
            message(userId, 'user', 'user'),
            { ...message(userId, 'user', 'malformed inbox'), source: null },
          ],
        },
      }),
      JSON.stringify({ type: 'user/message', data: message(userId, 'user', 'user') }),
      JSON.stringify({ type: 'assistant/message', data: { message: message(assistantId, 'assistant', 'assistant') } }),
      JSON.stringify({ type: 'tool/result', data: { message: message(toolId, 'tool', 'tool') } }),
      JSON.stringify({ type: 'turn/start', data: { id: userId } }),
      JSON.stringify({ type: 'steering/message', data: message(userId, 'user', 'obsolete') }),
      JSON.stringify({ type: 'user/message', data: { ...message(userId, 'user', 'malformed'), source: null } }),
      JSON.stringify({ type: 'user/message', data: message(malformedId, 'user', 'non-UUID') }),
      JSON.stringify({ type: 'assistant/message', data: null }),
      JSON.stringify({ type: 42, data: message(userId, 'user', 'non-string type') }),
      '',
    ].join('\n')

    const stable = stabilizeFixtureMessageIds(
      [log(ids.freshUser, ids.freshAssistant, ids.freshTool, 'not-a-uuid')],
      [log(ids.oldUser, ids.oldAssistant, ids.oldTool, ids.oldMalformed)],
    )[0] as string
    const records = stable.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)

    const inserted = ((records[1]?.data as { inserted: Array<{ id: string }> }).inserted)
    expect(inserted[0]?.id).toBe(ids.oldUser)
    expect(inserted[1]?.id).toBe(ids.freshUser)
    expect((records[2]?.data as { id: string }).id).toBe(ids.oldUser)
    expect((records[3]?.data as { message: { id: string } }).message.id).toBe(ids.oldAssistant)
    expect((records[4]?.data as { message: { id: string } }).message.id).toBe(ids.oldTool)
    expect((records[5]?.data as { id: string }).id).toBe(ids.freshUser)
    expect((records[6]?.data as { id: string }).id).toBe(ids.freshUser)
    expect((records[7]?.data as { id: string }).id).toBe(ids.freshUser)
    expect((records[8]?.data as { id: string }).id).toBe('not-a-uuid')
  })

  it('matches cwd-bearing messages only after the fresh log reaches fixture-ready form', () => {
    const freshId = '11111111-1111-4111-8111-111111111111'
    const existingId = '22222222-2222-4222-8222-222222222222'
    const freshCwd = '/tmp/acp-snapshot-fresh-cwd'
    const message = (id: string, path: string): Record<string, unknown> => ({
      type: 'user/message',
      data: {
        id,
        role: 'user',
        content: [{ type: 'text', text: `read ${path}/input.txt` }],
        source: { kind: 'user' },
      },
    })
    const fresh = tokenizeSessionFixtureCwd([
      JSON.stringify({ type: 'session', id: 'fresh', cwd: freshCwd }),
      JSON.stringify(message(freshId, freshCwd)),
      '',
    ].join('\n'))
    const existing = [
      JSON.stringify({ type: 'session', id: 'old', cwd: '{{cwd}}' }),
      JSON.stringify(message(existingId, '{{cwd}}')),
      '',
    ].join('\n')

    expect(stabilizeFixtureMessageIds([fresh], [existing])[0]).toContain(`"id":"${existingId}"`)
  })

  it('rejects a fingerprint connected to an id that also identifies different content', () => {
    const freshId = '11111111-1111-4111-8111-111111111111'
    const conflictingId = '22222222-2222-4222-8222-222222222222'
    const competingId = '33333333-3333-4333-8333-333333333333'
    const message = (id: string, text: string): string => JSON.stringify({
      type: 'user/message',
      data: { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
    })
    const fresh = `${message(freshId, 'shared')}\n`
    const existing = [
      message(conflictingId, 'shared'),
      message(conflictingId, 'different'),
      message(competingId, 'shared'),
      '',
    ].join('\n')

    expect(stabilizeFixtureMessageIds([fresh], [existing])).toEqual([fresh])
  })

  it('leaves fresh fixtures unchanged when no committed counterpart exists', () => {
    const fresh = '{"type":"session","id":"new"}\n'
    expect(stabilizeFixtureMessageIds([fresh], [''])).toEqual([fresh])
  })
})

describe('refreshFixtureReplacements', () => {
  it('maps fresh ids and cwd values to the existing fixture values, skipping non-replacements', () => {
    const log = (content: string): HarvestedLog => ({ id: 'diagnostic', createdAt: 1, content })
    const logs = [
      log('{"type":"session","id":"","cwd":"/same"}\n'),
      log('{"type":"session","id":"new-parent","cwd":"/new"}\n'),
      log('{"type":"session","id":"new-child","cwd":"/new"}\n'),
    ]
    const fixtures = [
      '{"type":"session","id":"","cwd":"/same"}\n',
      '{"type":"session","id":"old-parent","cwd":"/old"}\n',
    ]
    expect(refreshFixtureReplacements(logs, fixtures)).toEqual([
      { from: 'new-parent', to: 'old-parent' },
      { from: '/new', to: '/old' },
    ])
  })

  it('stabilizes moved snapshot spill paths by filename while skipping unchanged or unmatched names', () => {
    const spill = (session: string, hash: string, name: string): string =>
      `/tmp/dsh-acp-snapshot-spill/session-${session}/${hash}-${name}`
    const record = (text: string): string =>
      `${JSON.stringify({ type: 'session', id: 'same', cwd: '/same' })}\n`
      + `${JSON.stringify({ type: 'tool/result', data: { content: [{ type: 'text', text: `stored at: ${text} ` }] } })}\n`
    const freshBash = spill('aaaaaaaaaaaa', 'bbbbbbbbbbbb', 'bash.txt')
    const oldBash = spill('cccccccccccc', 'dddddddddddd', 'bash.txt')
    const shared = spill('eeeeeeeeeeee', 'ffffffffffff', 'grep.txt')
    const orphan = spill('111111111111', '222222222222', 'orphan.txt')
    const logs: HarvestedLog[] = [{
      id: 'diagnostic',
      createdAt: 1,
      content: record(`${freshBash} and ${shared}`),
    }]
    const fixtures = [record(`${oldBash} and ${shared} and ${orphan}`)]
    // bash.txt moved → replaced; grep.txt is identical and orphan.txt has no
    // fresh counterpart → both skipped.
    expect(refreshFixtureReplacements(logs, fixtures)).toEqual([
      { from: freshBash, to: oldBash },
    ])
  })

  it('leaves complete message ids out of the literal refresh replacement list', () => {
    const freshMessageId = '11111111-1111-4111-8111-111111111111'
    const existingMessageId = '22222222-2222-4222-8222-222222222222'
    const log = (sessionId: string, messageId: string): string => [
      JSON.stringify({ type: 'session', id: sessionId, cwd: '/same' }),
      JSON.stringify({
        type: 'user/message',
        data: {
          id: messageId,
          role: 'user',
          content: [{ type: 'text', text: 'same' }],
          source: { kind: 'user' },
        },
      }),
      '',
    ].join('\n')
    const replacements = refreshFixtureReplacements(
      [{ id: 'diagnostic', createdAt: 1, content: log('fresh', freshMessageId) }],
      [log('old', existingMessageId)],
    )

    expect(replacements).toEqual([{ from: 'fresh', to: 'old' }])
  })
})

describe('stabilizeRefreshLog', () => {
  it('preserves unpacked member times when refresh first packs a chunk run', () => {
    const fresh = [
      '{"type":"session","id":"same","createdAt":200}',
      '{"type":"reasoning-chunks","seq0":2,"time0":200,"data":{"turn":1,"step":1,"index":0,"dt":[5,7],"texts":["new",""," split"]}}',
      '{"type":"assistant/message","seq":5,"time":220,"data":{}}',
      '',
    ].join('\n')
    const existing = [
      '{"type":"session","id":"same","createdAt":100}',
      '{"type":"assistant/chunk","seq":2,"time":100,"data":{"turn":1,"step":1,"chunk":{"type":"reasoning-delta","index":0,"text":"old"}}}',
      '{"type":"assistant/chunk","seq":3,"time":101,"data":{"turn":1,"step":1,"chunk":{"type":"reasoning-delta","index":0,"text":"chunk"}}}',
      '{"type":"assistant/chunk","seq":4,"time":103,"data":{"turn":1,"step":1,"chunk":{"type":"reasoning-delta","index":0,"text":"shape"}}}',
      '{"type":"assistant/message","seq":5,"time":104,"data":{}}',
      '',
    ].join('\n')

    expect(stabilize(fresh, existing)).toBe([
      '{"type":"session","id":"same","createdAt":100}',
      '{"type":"reasoning-chunks","seq0":2,"time0":100,"data":{"turn":1,"step":1,"index":0,"dt":[1,2],"texts":["new",""," split"]}}',
      '{"type":"assistant/message","seq":5,"time":104,"data":{}}',
      '',
    ].join('\n'))
  })

  it('preserves packed member times without flattening fresh chunk boundaries', () => {
    const fresh = [
      '{"type":"session","id":"same","createdAt":200}',
      '{"type":"text-chunks","seq0":2,"time0":200,"data":{"turn":1,"step":1,"index":0,"dt":[5,7],"texts":["new",""," split"]}}',
      '',
    ].join('\n')
    const existing = [
      '{"type":"session","id":"same","createdAt":100}',
      '{"type":"text-chunks","seq0":2,"time0":100,"data":{"turn":1,"step":1,"index":0,"dt":[1,2],"texts":["old","chunk","shape"]}}',
      '',
    ].join('\n')

    expect(stabilize(fresh, existing)).toBe([
      '{"type":"session","id":"same","createdAt":100}',
      '{"type":"text-chunks","seq0":2,"time0":100,"data":{"turn":1,"step":1,"index":0,"dt":[1,2],"texts":["new",""," split"]}}',
      '',
    ].join('\n'))
  })

  it('reads projected packed fixtures while retaining their data gaps', () => {
    const fresh = [
      '{"type":"session","id":"same","createdAt":200}',
      '{"type":"text-chunks","seq0":2,"time0":200,"data":{"turn":1,"step":1,"index":0,"dt":[5,7],"texts":["new",""," split"]}}',
      '',
    ].join('\n')
    const existing = [
      '{"type":"session","id":"same","createdAt":100}',
      '{"type":"text-chunks","data":{"turn":1,"step":1,"index":0,"dt":[1,2],"texts":["old","chunk","shape"]}}',
      '',
    ].join('\n')

    expect(stabilize(fresh, existing)).toBe([
      '{"type":"session","id":"same","createdAt":100}',
      '{"type":"text-chunks","seq0":2,"time0":0,"data":{"turn":1,"step":1,"index":0,"dt":[1,2],"texts":["new",""," split"]}}',
      '',
    ].join('\n'))
  })

  it.each([
    ['the old run is absent', [], 200],
    ['the old run is shorter', [100, 101], 100],
    ['a later old time is invalid', [100, 'invalid', 103], 100],
    ['an old gap is not exactly representable', [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER - 1], Number.MIN_SAFE_INTEGER],
  ])('keeps fresh packed gaps when %s', (_case, existingTimes, expectedTime0) => {
    const freshRow = {
      type: 'reasoning-chunks',
      seq0: 2,
      time0: 200,
      data: { turn: 1, step: 1, index: 0, dt: [5, 7], texts: ['new', '', ' split'] },
    }
    const existingRows = existingTimes.map((time, index) => ({
      type: 'assistant/chunk',
      seq: index + 2,
      time,
      data: {},
    }))
    const output = stabilize(
      `${JSON.stringify({ type: 'session', id: 'same', createdAt: 200 })}\n${JSON.stringify(freshRow)}\n`,
      `${JSON.stringify({ type: 'session', id: 'same', createdAt: 100 })}\n${existingRows.map(row => JSON.stringify(row)).join('\n')}\n`,
    ).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)

    expect(output[1]).toStrictEqual({ ...freshRow, time0: expectedTime0 })
  })

  it('aligns volatile times across a newly inserted log event', () => {
    const fresh = [
      '{"type":"session","id":"same","createdAt":200}',
      '{"type":"turn/start","seq":0,"time":21}',
      '{"type":"user/message","seq":1,"time":22}',
      '{"type":"session/title","seq":2,"time":999}',
      '{"type":"step/start","seq":3,"time":1000}',
      '{"type":"request/header","seq":4,"time":1001}',
      '',
    ].join('\n')
    const existing = [
      '{"type":"session","id":"same","createdAt":100}',
      '{"type":"turn/start","seq":0,"time":11}',
      '{"type":"user/message","seq":1,"time":12}',
      '{"type":"step/start","seq":2,"time":13}',
      '{"type":"request/header","seq":3,"time":14}',
      '',
    ].join('\n')

    expect(stabilize(fresh, existing)).toBe([
      '{"type":"session","id":"same","createdAt":100}',
      '{"type":"turn/start","seq":0,"time":11}',
      '{"type":"user/message","seq":1,"time":12}',
      '{"type":"session/title","seq":2,"time":12}',
      '{"type":"step/start","seq":3,"time":13}',
      '{"type":"request/header","seq":4,"time":14}',
      '',
    ].join('\n'))
  })

  it('retains unchanged message ids across an unrelated inserted event', () => {
    const freshUserId = '11111111-1111-4111-8111-111111111111'
    const existingUserId = '22222222-2222-4222-8222-222222222222'
    const freshAssistantId = '33333333-3333-4333-8333-333333333333'
    const existingAssistantId = '44444444-4444-4444-8444-444444444444'
    const user = (id: string): Record<string, unknown> => ({
      type: 'user/message',
      data: { role: 'user', content: [{ type: 'text', text: 'same user' }], source: { kind: 'user' }, id },
    })
    const assistant = (id: string): Record<string, unknown> => ({
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'same assistant' }],
          source: { kind: 'model', provider: 'fake', model: 'fake' },
          id,
        },
      },
    })
    const lines = (records: Record<string, unknown>[]): string => [
      JSON.stringify({ type: 'session', id: 'same', createdAt: 1, cwd: '/same' }),
      ...records.map(record => JSON.stringify(record)),
      '',
    ].join('\n')
    const fresh = lines([
      user(freshUserId),
      { type: 'session/inherited', data: {} },
      assistant(freshAssistantId),
    ])
    const existing = lines([user(existingUserId), assistant(existingAssistantId)])
    const replacements = refreshFixtureReplacements(
      [{ id: 'diagnostic', createdAt: 1, content: fresh }],
      [existing],
    )
    const refreshed = stabilize(fresh, existing, replacements)
    const intermediate = refreshed.trim().split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>)
    expect((intermediate[1]?.data as { id: string }).id).toBe(freshUserId)
    expect(((intermediate[3]?.data as { message: { id: string } }).message).id).toBe(freshAssistantId)

    const output = (stabilizeFixtureMessageIds([refreshed], [existing])[0] as string).trim().split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>)

    expect((output[1]?.data as { id: string }).id).toBe(existingUserId)
    expect(((output[3]?.data as { message: { id: string } }).message).id).toBe(existingAssistantId)
  })

  it('leaves an aligned complete message id to the fixture-ready structural pass', () => {
    const freshId = '11111111-1111-4111-8111-111111111111'
    const existingId = '22222222-2222-4222-8222-222222222222'
    const log = (id: string): string => [
      JSON.stringify({ type: 'session', id: 'same', createdAt: 1, cwd: '/same' }),
      JSON.stringify({
        type: 'user/message',
        data: { id, role: 'user', content: [{ type: 'text', text: 'same' }], source: { kind: 'user' } },
      }),
      '',
    ].join('\n')
    const fresh = log(freshId)
    const existing = log(existingId)
    const refreshed = stabilize(fresh, existing)

    expect(refreshed).toContain(`"id":"${freshId}"`)
    expect(stabilizeFixtureMessageIds([refreshed], [existing])[0]).toContain(`"id":"${existingId}"`)
  })

  it('keeps volatile fixture fields while preserving fresh meaningful payloads', () => {
    const fresh = [
      '{"type":"session","id":"new-child","createdAt":200,"cwd":"/new","parentSession":"new-parent","seedLength":1}',
      '{"type":"hook/result","seq":1,"time":22,"data":{"decision":"block","durationMs":37}}',
      '{"type":"turn/end","seq":2,"time":33,"data":{"error":"fresh error"}}',
      '{"type":"tool/result","seq":3,"time":44,"data":{"text":"new-parent in /new"}}',
      '{"type":"hook/result","seq":4,"time":55,"data":{"decision":"allow","durationMs":5}}',
      '',
    ].join('\n')
    const existing = [
      '{"type":"session","id":"old-child","createdAt":100,"cwd":"/old","parentSession":"old-parent","seedLength":5}',
      '{"type":"hook/result","seq":1,"time":11,"data":{"decision":"stale","durationMs":99}}',
      '{"type":"turn/end","seq":2,"time":12,"data":{"error":"stale"}}',
      '{"type":"assistant/message","seq":3,"time":12,"data":{"text":"different type"}}',
      '{"type":"hook/result","seq":4,"time":13,"data":{"decision":"stale"}}',
      '',
    ].join('\n')

    expect(stabilize(fresh, existing, [
      { from: 'new-parent', to: 'old-parent' },
      { from: 'new-child', to: 'old-child' },
      { from: '/new', to: '/old' },
    ])).toBe([
      '{"type":"session","id":"old-child","createdAt":100,"cwd":"/old","parentSession":"old-parent","seedLength":1}',
      '{"type":"hook/result","seq":1,"time":11,"data":{"decision":"block","durationMs":99}}',
      '{"type":"turn/end","seq":2,"time":12,"data":{"error":"fresh error"}}',
      '{"type":"tool/result","seq":3,"time":44,"data":{"text":"old-parent in /old"}}',
      '{"type":"hook/result","seq":4,"time":13,"data":{"decision":"allow","durationMs":5}}',
      '',
    ].join('\n'))
  })

  it('preserves normalized volatile fields while accepting fresh semantic fields', () => {
    const freshApprovalId = '11111111-1111-4111-8111-111111111111'
    const existingApprovalId = '22222222-2222-4222-8222-222222222222'
    const freshSpill = '/tmp/dsh-acp-snap-012345678/session-111111111111/222222222222-bash.txt'
    const existingSpill = '/tmp/dsh-acp-snap-012345678/session-aaaaaaaaaaaa/bbbbbbbbbbbb-bash.txt'
    const freshEventRead = [
      'Session main — title',
      'Target event seq 4:',
      '```json',
      '{',
      '  "time": 1785000000000,',
      '  "data": {}',
      '}',
      '```',
      '',
      `(Omitted 40000 bytes. Full formatted result stored at: ${freshSpill}. Use read with offset/limit, or grep this path to search within it.)`,
    ].join('\n')
    const existingEventRead = freshEventRead
      .replace('1785000000000', '1784000000000')
      .replace('40000 bytes', '30000 bytes')
      .replace(freshSpill, existingSpill)
    const fresh = [
      '{"type":"session","id":"same","createdAt":200,"cwd":"/old"}',
      JSON.stringify({
        type: 'approval/asked',
        seq: 1,
        time: 22,
        data: {
          id: freshApprovalId,
          outcome: 'fresh',
          aliases: [freshApprovalId, 'fresh'],
          resized: [freshApprovalId, 'new'],
          shape: { shared: freshApprovalId, added: true },
        },
      }),
      JSON.stringify({
        type: 'tool/result',
        seq: 2,
        time: 23,
        data: {
          spill: `Full formatted result stored at: ${freshSpill}. Use read with offset/limit, or grep this path to search within it.`,
          path: '/private/old/result.txt',
          eventRead: freshEventRead,
        },
      }),
      '',
    ].join('\n')
    const existing = [
      '{"type":"session","id":"same","createdAt":100,"cwd":"/old"}',
      JSON.stringify({
        type: 'approval/asked',
        seq: 1,
        time: 11,
        data: {
          id: existingApprovalId,
          outcome: 'stale',
          aliases: [existingApprovalId, 'stale'],
          resized: [existingApprovalId],
          shape: { shared: existingApprovalId },
        },
      }),
      JSON.stringify({
        type: 'tool/result',
        seq: 2,
        time: 12,
        data: {
          spill: `Full formatted result stored at: ${existingSpill}. Use read with offset/limit, or grep this path to search within it.`,
          path: '/old/result.txt',
          eventRead: existingEventRead,
        },
      }),
      '',
    ].join('\n')

    const output = stabilize(fresh, existing).trim().split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>)
    expect(output).toEqual([
      { type: 'session', id: 'same', createdAt: 100, cwd: '/old' },
      {
        type: 'approval/asked',
        seq: 1,
        time: 11,
        data: {
          id: existingApprovalId,
          outcome: 'fresh',
          aliases: [existingApprovalId, 'fresh'],
          resized: [freshApprovalId, 'new'],
          shape: { shared: existingApprovalId, added: true },
        },
      },
      {
        type: 'tool/result',
        seq: 2,
        time: 12,
        data: {
          spill: `Full formatted result stored at: ${existingSpill}. Use read with offset/limit, or grep this path to search within it.`,
          path: '/old/result.txt',
          eventRead: existingEventRead,
        },
      },
    ])
  })

  it('normalizes fresh cwd aliases before reusing existing paths', () => {
    const freshCwd = String.raw`C:\Users\RUNNER~1\AppData\Local\Temp\acp-snap-cwd-new`
    const freshAlias = String.raw`C:\Users\runneradmin\AppData\Local\Temp\acp-snap-cwd-new`
    const existingCwd = String.raw`C:\Users\RUNNER~1\AppData\Local\Temp\acp-snap-cwd-old`
    const fresh = [
      JSON.stringify({ type: 'session', id: 'same', createdAt: 200, cwd: freshCwd }),
      JSON.stringify({ type: 'tool/result', data: { path: `${freshAlias}\\result.txt` } }),
      '',
    ].join('\n')
    const existing = [
      JSON.stringify({ type: 'session', id: 'same', createdAt: 100, cwd: existingCwd }),
      JSON.stringify({ type: 'tool/result', data: { path: `${existingCwd}\\result.txt` } }),
      '',
    ].join('\n')
    const freshContext = { ...fixtureContext(fresh), cwdAliases: [freshAlias] }

    expect(stabilize(
      fresh,
      existing,
      [{ from: freshCwd, to: existingCwd }],
      freshContext,
    )).toBe([
      JSON.stringify({ type: 'session', id: 'same', createdAt: 100, cwd: existingCwd }),
      JSON.stringify({ type: 'tool/result', data: { path: `${existingCwd}\\result.txt` } }),
      '',
    ].join('\n'))
  })

  it('preserves one correlated volatile id through a consistent log-wide mapping', () => {
    const freshId = '11111111-1111-4111-8111-111111111111'
    const existingId = '22222222-2222-4222-8222-222222222222'
    const fresh = [
      '{"type":"session","id":"same","createdAt":200,"cwd":"/old"}',
      JSON.stringify({ type: 'approval/asked', data: { id: freshId } }),
      JSON.stringify({ type: 'approval/decided', data: { id: freshId, outcome: 'allowed-once' } }),
      '',
    ].join('\n')
    const existing = [
      '{"type":"session","id":"same","createdAt":100,"cwd":"/old"}',
      JSON.stringify({ type: 'approval/asked', data: { id: existingId } }),
      JSON.stringify({ type: 'approval/decided', data: { id: existingId, outcome: 'rejected' } }),
      '',
    ].join('\n')

    expect(stabilize(fresh, existing)).toBe([
      '{"type":"session","id":"same","createdAt":100,"cwd":"/old"}',
      JSON.stringify({ type: 'approval/asked', data: { id: existingId } }),
      JSON.stringify({ type: 'approval/decided', data: { id: existingId, outcome: 'allowed-once' } }),
      '',
    ].join('\n'))
  })

  it('keeps fresh correlated ids when record alignment is structurally ambiguous', () => {
    const firstFreshId = '11111111-1111-4111-8111-111111111111'
    const secondFreshId = '22222222-2222-4222-8222-222222222222'
    const existingId = '33333333-3333-4333-8333-333333333333'
    const fresh = [
      '{"type":"session","id":"same","createdAt":200,"cwd":"/old"}',
      JSON.stringify({ type: 'approval/asked', data: { id: firstFreshId } }),
      JSON.stringify({ type: 'approval/asked', data: { id: secondFreshId } }),
      JSON.stringify({ type: 'approval/decided', data: { id: firstFreshId } }),
      JSON.stringify({ type: 'approval/decided', data: { id: secondFreshId } }),
      '',
    ].join('\n')
    const existing = [
      '{"type":"session","id":"same","createdAt":100,"cwd":"/old"}',
      JSON.stringify({ type: 'approval/asked', data: { id: existingId } }),
      JSON.stringify({ type: 'approval/decided', data: { id: existingId } }),
      '',
    ].join('\n')

    const ids = stabilize(fresh, existing).trim().split('\n').slice(1)
      .map(line => (JSON.parse(line) as { data: { id: string } }).data.id)
    expect(ids).toEqual([firstFreshId, secondFreshId, firstFreshId, secondFreshId])
  })

  it('keeps fresh ids when existing records remain unmatched', () => {
    const freshId = '11111111-1111-4111-8111-111111111111'
    const existingId = '22222222-2222-4222-8222-222222222222'
    const fresh = [
      '{"type":"session","id":"same","createdAt":200,"cwd":"/old"}',
      JSON.stringify({ type: 'approval/asked', data: { id: freshId } }),
      '',
    ].join('\n')
    const existing = [
      '{"type":"session","id":"same","createdAt":100,"cwd":"/old"}',
      JSON.stringify({ type: 'approval/asked', data: { id: existingId } }),
      JSON.stringify({ type: 'approval/decided', data: { id: existingId } }),
      '',
    ].join('\n')

    const output = stabilize(fresh, existing).trim().split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>)
    expect(output[1]).toEqual({ type: 'approval/asked', data: { id: freshId } })
  })

  it.each([
    {
      name: 'one fresh id would map to two existing ids',
      fresh: ['a', 'b', 'b', 'a'],
      existing: ['x', 'y', 'x', 'y'],
    },
    {
      name: 'two fresh ids would map to one existing id',
      fresh: ['a', 'b'],
      existing: ['x', 'x'],
    },
  ])('keeps fresh ids when $name', ({ fresh: freshNames, existing: existingNames }) => {
    const ids = {
      a: '11111111-1111-4111-8111-111111111111',
      b: '22222222-2222-4222-8222-222222222222',
      x: '33333333-3333-4333-8333-333333333333',
      y: '44444444-4444-4444-8444-444444444444',
    } as const
    const types = ['approval/asked', 'approval/asked', 'approval/decided', 'approval/decided']
    const log = (names: string[]): string => [
      '{"type":"session","id":"same","createdAt":100,"cwd":"/old"}',
      ...names.map((name, index) => JSON.stringify({ type: types[index], data: { id: ids[name as keyof typeof ids] } })),
      '',
    ].join('\n')

    const outputIds = stabilize(log(freshNames), log(existingNames)).trim().split('\n').slice(1)
      .map(line => (JSON.parse(line) as { data: { id: string } }).data.id)
    expect(outputIds).toEqual(freshNames.map(name => ids[name as keyof typeof ids]))
  })
})
