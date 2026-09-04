import { describe, expect, it } from 'vitest'
import { parseSnapshotManifest, writesCurrentSessionFixtures } from '../src/manifest.ts'

describe('snapshot manifest', () => {
  it('parses an owning scenario', () => {
    expect(parseSnapshotManifest('version: 1\nprofile: headless\n')).toEqual({
      version: 1,
      profile: 'headless',
    })
  })

  it('parses an explicitly retained Session generation and its migration coverage', () => {
    expect(parseSnapshotManifest([
      'version: 1',
      'profile: headless',
      'sessionFormat:',
      '  version: 0',
      '  coverage: [multi-hop, packed-row]',
      '',
    ].join('\n'))).toEqual({
      version: 1,
      profile: 'headless',
      sessionFormat: { version: 0, coverage: ['multi-hop', 'packed-row'] },
    })
  })

  it('keeps explicitly retained generations read-only while current fixtures track writer output', () => {
    const current = parseSnapshotManifest('version: 1\nprofile: headless\n')
    const borrower = parseSnapshotManifest([
      'version: 1',
      'profile: web',
      'session:',
      '  source: ../owner/session.jsonl',
      '',
    ].join('\n'))
    const retained = parseSnapshotManifest([
      'version: 1',
      'profile: headless',
      'sessionFormat:',
      '  version: 0',
      '  coverage: [multi-hop]',
      '',
    ].join('\n'))

    expect(writesCurrentSessionFixtures(current, 'replay')).toBe(false)
    expect(writesCurrentSessionFixtures(current, 'record')).toBe(true)
    expect(writesCurrentSessionFixtures(current, 'refresh')).toBe(true)
    expect(writesCurrentSessionFixtures(borrower, 'record')).toBe(false)
    expect(writesCurrentSessionFixtures(borrower, 'refresh')).toBe(false)
    expect(writesCurrentSessionFixtures(retained, 'record')).toBe(false)
    expect(writesCurrentSessionFixtures(retained, 'refresh')).toBe(false)
  })

  it('parses a read-only session reference', () => {
    expect(parseSnapshotManifest([
      'version: 1',
      'profile: web',
      'session:',
      '  source: ../../session/tool-call-turn/session.jsonl',
      '',
    ].join('\n'))).toEqual({
      version: 1,
      profile: 'web',
      session: { source: '../../session/tool-call-turn/session.jsonl' },
    })
  })

  it('parses composition, recording, header, and exceptional replay metadata', () => {
    expect(parseSnapshotManifest([
      'version: 1',
      'scenario: sdk-case',
      'profile: sdk',
      'composition: continuable-subagent',
      'recording: authored',
      'header:',
      '  class: continuable-subagent',
      '  pin: true',
      '  systemPromptSource: session/text-turn',
      '  toolSchemasSource: session/text-turn',
      '  childSystemPrompts: [1]',
      '  childToolSchemas: [1, 2]',
      '  changes: 1',
      'replay:',
      '  override: true',
      'platform: posix',
      'permission: workspace-write',
      'environment:',
      '  DSH_SNAPSHOT_FAILURE: enabled',
      'workspace:',
      '  setup: fixed-mtimes',
      '  final: true',
      '  parent: home',
      'input:',
      '  task: Rejected before persistence.',
      '  attachments:',
      '    - id: sha256:abc',
      '      mediaType: image/png',
      '      data: aGVsbG8=',
      '',
    ].join('\n'))).toEqual({
      version: 1,
      scenario: 'sdk-case',
      profile: 'sdk',
      composition: 'continuable-subagent',
      recording: 'authored',
      header: {
        class: 'continuable-subagent',
        pin: true,
        systemPromptSource: 'session/text-turn',
        toolSchemasSource: 'session/text-turn',
        childSystemPrompts: [1],
        childToolSchemas: [1, 2],
        changes: 1,
      },
      replay: { override: true },
      platform: 'posix',
      permission: 'workspace-write',
      environment: { DSH_SNAPSHOT_FAILURE: 'enabled' },
      workspace: { setup: 'fixed-mtimes', final: true, parent: 'home' },
      input: {
        task: 'Rejected before persistence.',
        attachments: [{ id: 'sha256:abc', mediaType: 'image/png', data: 'aGVsbG8=' }],
      },
    })
  })

  it('parses independently optional header and input fields', () => {
    expect(parseSnapshotManifest([
      'version: 1',
      'profile: headless',
      'header:',
      '  class: default',
      'input:',
      '  task: Run once.',
      '',
    ].join('\n'))).toEqual({
      version: 1,
      profile: 'headless',
      header: { class: 'default' },
      input: { task: 'Run once.' },
    })

    expect(parseSnapshotManifest([
      'version: 1',
      'profile: sdk',
      'input:',
      '  attachments:',
      '    - id: sha256:one',
      '      mediaType: image/png',
      '      data: AQ==',
      '',
    ].join('\n'))).toEqual({
      version: 1,
      profile: 'sdk',
      input: { attachments: [{ id: 'sha256:one', mediaType: 'image/png', data: 'AQ==' }] },
    })
  })

  it.each([
    ['', 'manifest must be a mapping'],
    ['version: 2\nprofile: acp\n', 'manifest.version must equal 1'],
    ['version: 1\nprofile: private\n', 'manifest.profile must be headless, sdk, acp, or web'],
    ['version: 1\nprofile: acp\nextra: true\n', 'manifest has unknown field(s): extra'],
    ['version: 1\nprofile: acp\ncomposition: Not_Safe\n', 'manifest.composition must be a lower-kebab-case name'],
    ['version: 1\nprofile: acp\nrecording: maybe\n', 'manifest.recording must be live or authored'],
    ['version: 1\nprofile: acp\nheader: {}\n', 'manifest.header.class must be a lower-kebab-case name'],
    ['version: 1\nprofile: acp\nheader:\n  class: base\n  pin: false\n', 'manifest.header.pin must equal true when present'],
    ['version: 1\nprofile: acp\nheader:\n  class: base\n  childToolSchemas: [1, 1]\n', 'manifest.header.childToolSchemas must be an array of unique positive integers'],
    ['version: 1\nprofile: acp\nheader:\n  class: base\n  changes: -1\n', 'manifest.header.changes must be a non-negative integer'],
    ['version: 1\nprofile: acp\nheader:\n  class: base\n  systemPromptSource: ../bad\n', 'manifest.header.systemPromptSource must be a lower-kebab-case name or corpus-relative path'],
    ['version: 1\nprofile: acp\nreplay:\n  override: false\n', 'manifest.replay.override must equal true'],
    ['version: 1\nprofile: acp\nplatform: windows\n', 'manifest.platform must be posix or pwsh'],
    ['version: 1\nprofile: acp\npermission: root\n', 'manifest.permission must be read-only, workspace-write, or danger-full-access'],
    ['version: 1\nprofile: acp\nenvironment:\n  lower: value\n', 'manifest.environment must map uppercase environment names to strings'],
    ['version: 1\nprofile: acp\nworkspace: {}\n', 'manifest.workspace must not be empty'],
    ['version: 1\nprofile: acp\nworkspace:\n  final: false\n', 'manifest.workspace.final must equal true when present'],
    ['version: 1\nprofile: acp\nworkspace:\n  parent: temp\n', 'manifest.workspace.parent must equal home'],
    ['version: 1\nprofile: acp\ninput:\n  task: ""\n', 'manifest.input.task must be a non-empty string when present'],
    ['version: 1\nprofile: acp\ninput: {}\n', 'manifest.input must declare task or attachments'],
    ['version: 1\nprofile: acp\ninput:\n  attachments: []\n', 'manifest.input.attachments must be a non-empty array'],
    ['version: 1\nprofile: acp\ninput:\n  attachments:\n    - id: raw\n      mediaType: image/png\n      data: AQ==\n', 'manifest.input.attachments[0].id must start with sha256:'],
    ['version: 1\nprofile: acp\ninput:\n  attachments:\n    - id: sha256:one\n      mediaType: image\n      data: AQ==\n', 'manifest.input.attachments[0].mediaType must be a MIME type'],
    ['version: 1\nprofile: acp\ninput:\n  attachments:\n    - id: sha256:one\n      mediaType: image/png\n      data: ""\n', 'manifest.input.attachments[0].data must be non-empty base64'],
    ['version: 1\nprofile: acp\ninput:\n  attachments:\n    - id: sha256:one\n      mediaType: image/png\n      data: AQ==\n    - id: sha256:one\n      mediaType: image/png\n      data: Ag==\n', 'manifest.input.attachments must have unique ids'],
    ['version: 1\nprofile: acp\nsessionFormat:\n  version: -1\n  coverage: [multi-hop]\n', 'manifest.sessionFormat.version must be a non-negative safe integer'],
    ['version: 1\nprofile: acp\nsessionFormat:\n  version: 0\n  coverage: []\n', 'manifest.sessionFormat.coverage must be a non-empty array of unique supported coverage names'],
    ['version: 1\nprofile: acp\nsessionFormat:\n  version: 0\n  coverage: [multi-hop, multi-hop]\n', 'manifest.sessionFormat.coverage must be a non-empty array of unique supported coverage names'],
    ['version: 1\nprofile: acp\nsessionFormat:\n  version: 0\n  coverage: [unknown]\n', 'manifest.sessionFormat.coverage must be a non-empty array of unique supported coverage names'],
    ['version: 1\nprofile: acp\nsession: {}\n', 'manifest.session.source must be a non-empty string'],
    ['version: 1\nprofile: acp\nsession:\n  source: /tmp/session.jsonl\n', 'manifest.session.source must be a relative POSIX path'],
    ['version: 1\nprofile: acp\nsession:\n  source: ..\\session.jsonl\n', 'manifest.session.source must be a relative POSIX path'],
    ['version: 1\nprofile: acp\nsession:\n  source: ../session.jsonl\nsessionFormat:\n  version: 0\n  coverage: [multi-hop]\n', 'manifest.sessionFormat is only valid when the scenario owns its Session fixtures'],
    ['version: 1\nprofile: !!js acp\n', 'invalid YAML'],
  ])('rejects invalid metadata', (source, message) => {
    expect(() => parseSnapshotManifest(source, 'case/snapshot.yml')).toThrow(message)
  })
})
