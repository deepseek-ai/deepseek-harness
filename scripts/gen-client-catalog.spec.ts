/**
 * The client slot catalog's judgement, proven on hand-built inputs: the
 * contract checks that must reject an unteachable slot, and the projection
 * facts a registrant depends on (who occupies a seat, what replacing it costs,
 * which owner has to be mounted). Run against the real workspace, the
 * generator's own `--check` covers freshness; these cases pin the rules that
 * make a stale or undocumented contract fail loudly instead of shipping.
 */

import { describe, expect, it } from 'vitest'
import { collectSlotEntries, oversizedSlotReports, resolveSlotEntries, validateSlotContracts } from './gen-client-catalog.ts'
import type { SlotDeclaration, SlotRegistration, TypeDeclaration } from './slot-walk.ts'

/** A declaration with every field the catalog needs, overridable per case. */
function declaration(over: Partial<SlotDeclaration> = {}): SlotDeclaration {
  return {
    key: 'demo.seat',
    kind: 'single',
    scope: 'root',
    jsDoc: '/** A seat. Registering here replaces the shipped entry. */',
    package: '@deepseek-ai/dsh-client-demo',
    source: 'packages/client/demo/src/client/contract/slots.ts:1',
    ...over,
  }
}

/** A registration into `demo.seat`, overridable per case. */
function registration(over: Partial<SlotRegistration> = {}): SlotRegistration {
  return {
    key: 'demo.seat',
    package: '@deepseek-ai/dsh-client-demo',
    component: 'DemoSeat',
    children: [],
    source: 'packages/client/demo/src/client/index.ts:10',
    ...over,
  }
}

/** An exported owner-props declaration the catalog can resolve. */
const OWNER_TYPES = new Map<string, TypeDeclaration>([
  ['DemoOwnerProps', {
    name: 'DemoOwnerProps',
    text: '/** Owner share. */\nexport interface DemoOwnerProps {\n  /** Column width. */\n  width: number\n}',
    source: 'packages/client/demo/src/client/contract/slots.ts:20',
  }],
])

describe('client slot contract validation', () => {
  it('accepts a documented slot whose owner props resolve', () => {
    expect(validateSlotContracts(
      [declaration({ ownerType: 'DemoOwnerProps' })],
      [registration()],
      OWNER_TYPES,
    )).toEqual([])
  })

  it('rejects a slot with no registrant-facing prose, naming the writing template', () => {
    const problems = validateSlotContracts([declaration({ jsDoc: '' })], [], new Map())
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('has no JSDoc prose')
    expect(problems[0]).toContain('ui-settings')
  })

  it.each([
    ['kind', { kind: 'whatever' }],
    ['scope', { scope: 'whatever' }],
  ])('rejects a slot whose %s is not one of the contract literals', (field, over) => {
    const problems = validateSlotContracts([declaration(over)], [], new Map())
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain(`no literal '${field}'`)
  })

  it('rejects owner props no exported declaration provides', () => {
    const problems = validateSlotContracts([declaration({ ownerType: 'MissingProps' })], [], new Map())
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('MissingProps')
  })

  it('rejects the same key declared twice, because a merge would hide one contract', () => {
    const problems = validateSlotContracts(
      [declaration(), declaration({ source: 'packages/client/other/src/client/slots.ts:3' })],
      [],
      new Map(),
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('is also declared at')
  })

  it('rejects a registration into an undeclared slot as a scan blind spot', () => {
    const problems = validateSlotContracts([declaration()], [registration({ key: 'ghost.seat' })], new Map())
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('blind spot')
  })

  it('rejects a children declaration for a slot no merge types', () => {
    const problems = validateSlotContracts([declaration()], [registration({ children: ['ghost.child'] })], new Map())
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("child slot 'ghost.child'")
  })
})

describe('client slot projection', () => {
  const kits = new Map<string, readonly string[]>([['root', ['useSessions: Hook']]])

  it('warns that a single seat with a shipped occupant is replaced, not shared', () => {
    const [entry] = resolveSlotEntries([declaration()], [registration()], OWNER_TYPES, kits)
    expect(entry?.replaceRisk).toBe('shadows-shipped-ui')
    expect(entry?.occupants).toEqual(['client-demo DemoSeat'])
  })

  it('treats a list seat as additive even when shipped entries exist', () => {
    const [entry] = resolveSlotEntries(
      [declaration({ kind: 'list' })],
      [registration({ id: 'shipped' })],
      OWNER_TYPES,
      kits,
    )
    expect(entry?.replaceRisk).toBe('none')
    expect(entry?.occupants).toEqual(["client-demo DemoSeat id 'shipped'"])
    expect(entry?.registerOptions.map(option => option.name)).toEqual(['id', 'order', 'label'])
  })

  it('names the entry whose mount makes a child seat exist', () => {
    const parent = registration({ key: 'demo.parent', children: ['demo.seat'] })
    const entries = resolveSlotEntries(
      [declaration(), declaration({ key: 'demo.parent' })],
      [parent],
      OWNER_TYPES,
      kits,
    )
    expect(entries.find(entry => entry.key === 'demo.seat')?.declaredBy)
      .toContain("an entry in 'demo.parent' (client-demo)")
    expect(entries.find(entry => entry.key === 'demo.parent')?.declaredBy)
      .toContain('built in')
  })

  it('names the Factory definition that declares an ordinary child seat', () => {
    const factory = registration({ key: 'demo.factory', children: ['demo.seat'], factory: true })
    const [entry] = resolveSlotEntries([declaration()], [factory], OWNER_TYPES, kits)
    expect(entry?.declaredBy)
      .toContain("factory 'demo.factory' (client-demo)")
    expect(entry?.occupants).toEqual([])
  })

  it('reports an open keyed domain and the keys already taken', () => {
    const [entry] = resolveSlotEntries(
      [declaration({ kind: 'keyed' })],
      [registration({ entryKey: 'bash' }), registration({ entryKey: 'read' })],
      OWNER_TYPES,
      kits,
    )
    expect(entry?.keyDomain).toContain('open: any string')
    expect(entry?.keyDomain).toContain('already taken: bash, read')
  })

  it('carries owner-props documentation into the entry, not just the type name', () => {
    const [entry] = resolveSlotEntries([declaration({ ownerType: 'DemoOwnerProps' })], [], OWNER_TYPES, kits)
    expect(entry?.ownerProps.join('\n')).toContain('Column width.')
  })

  it('expands owner props one level and only names the shapes they reference', () => {
    // Transitive expansion once dragged the whole session model into four
    // seats; a registrant needs the fields, not the graph behind them.
    const types = new Map(OWNER_TYPES)
    types.set('Zone', {
      name: 'Zone',
      text: 'export interface Zone {\n  session: BigSnapshot\n}',
      source: 'packages/client/demo/src/client/contract/slots.ts:30',
    })
    types.set('BigSnapshot', {
      name: 'BigSnapshot',
      text: 'export interface BigSnapshot {\n  turns: number\n}',
      source: 'packages/client/demo/src/client/snapshot.ts:1',
    })
    const [entry] = resolveSlotEntries([declaration({ ownerType: 'Zone' })], [], types, kits)
    expect(entry?.ownerProps.join('\n')).toContain('export interface Zone')
    expect(entry?.ownerProps.join('\n')).not.toContain('export interface BigSnapshot')
    expect(entry?.ownerPropsReferences).toEqual(['BigSnapshot'])
  })

  it('offers a runnable registration whose options match the cardinality', () => {
    const [entry] = resolveSlotEntries([declaration({ kind: 'list' })], [], OWNER_TYPES, kits)
    expect(entry?.example).toContain("ctx.slots.inject('demo.seat'")
    expect(entry?.example).toContain("id: 'my-entry'")
  })

  it('expands composed owner aliases without expanding their field value types', () => {
    const types = new Map(OWNER_TYPES)
    for (const [name, text] of [
      ['Phase', "export type Phase = { phase: 'preparing'; block: BigSnapshot } | { phase: 'start'; block: BigSnapshot }"],
      ['Owner', 'export type Owner = DemoOwnerProps & (Phase | Alias)'],
      ['Alias', 'export type Alias = Owner'],
      ['BigSnapshot', 'export interface BigSnapshot { history: string[] }'],
    ] as const) types.set(name, { name, text, source: 'owner.ts:1' })
    const [entry] = resolveSlotEntries([declaration({ ownerType: 'Owner' })], [], types, kits)
    expect(entry?.ownerProps).toHaveLength(4)
    expect(entry?.ownerProps.join('\n')).toContain('width: number')
    expect(entry?.ownerProps.join('\n')).toContain("phase: 'preparing'")
    expect(entry?.ownerProps.join('\n')).not.toContain('history: string[]')
    expect(entry?.ownerPropsReferences).toEqual(['BigSnapshot'])
  })

  it('keeps generic owner arguments as references instead of expanding unselected fields', () => {
    const types = new Map(OWNER_TYPES)
    types.set('Owner', { name: 'Owner', text: "export type Owner = Pick<DemoOwnerProps, 'width'>", source: 'owner.ts:1' })
    const [entry] = resolveSlotEntries([declaration({ ownerType: 'Owner' })], [], types, kits)
    expect(entry?.ownerProps).toHaveLength(1)
    expect(entry?.ownerPropsReferences).toEqual(['DemoOwnerProps'])
  })

  it('uses an authored example when a slot interaction needs more than generic markup', () => {
    const [entry] = resolveSlotEntries([
      declaration({ jsDoc: '/** A seat.\n * @example\n * return { custom: true }\n */' }),
    ], [], OWNER_TYPES, kits)
    expect(entry?.example).toBe('return { custom: true }')
  })
})

describe('the per-slot report budget', () => {
  it('rejects a slot whose report a model could not finish reading', () => {
    // Truncation already bounds one declaration, so the remaining runaway is
    // prose: a contract that grew into a manual costs exactly what narrowing to
    // one slot was supposed to save.
    const manual = ['/**', ...Array.from({ length: 150 }, (_, i) => ` * Paragraph ${String(i)} about this seat.`), ' */']
    const entries = resolveSlotEntries([declaration({ jsDoc: manual.join('\n') })], [], OWNER_TYPES, new Map())
    const problems = oversizedSlotReports(entries)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("slot 'demo.seat'")
    expect(problems[0]).toContain('tighten')
  })

  it('passes a slot whose report stays within the budget', () => {
    const entries = resolveSlotEntries([declaration({ ownerType: 'DemoOwnerProps' })], [], OWNER_TYPES, new Map())
    expect(oversizedSlotReports(entries)).toEqual([])
  })
})

describe('the real workspace surface', () => {
  it('collects every declared slot with a teachable contract', { timeout: 30_000 }, () => {
    const entries = collectSlotEntries(process.cwd())
    expect(entries.length).toBeGreaterThan(30)
    for (const entry of entries) {
      expect(entry.summary, `${entry.key} has no summary`).not.toBe('')
      expect(['single', 'list', 'keyed', 'chain']).toContain(entry.kind)
      expect(['root', 'session', 'session-maybe']).toContain(entry.scope)
    }
    // The frame root is the canonical trap: occupied by the shipped app frame,
    // so a dynamic package registering there replaces the whole UI.
    const root = entries.find(entry => entry.key === 'root')
    expect(root?.replaceRisk).toBe('shadows-shipped-ui')
    expect(root?.occupants.join(' ')).toContain('AppFrame')
    expect(entries.find(entry => entry.key === 'conversation.session')?.declaredBy)
      .toContain("factory 'conversation.content' (client-ui-conversation)")
    const tool = entries.find(entry => entry.key === 'tool.call.toolview')!
    const owner = tool.ownerProps.join('\n')
    for (const field of ['callId', 'toolName', 'useDisclosure', 'cwd', 'home', 'openFile', 'loadImage', 'inspect']) {
      expect(owner).toMatch(new RegExp(`\\b${field}\\??:`))
    }
    for (const phase of ['preparing', 'start', 'result']) expect(owner).toContain(`phase: '${phase}'`)
    expect(owner).not.toContain('truncated')
    expect(tool.ownerPropsReferences).not.toContain('ToolCallCommonProps')
    expect(tool.ownerPropsReferences).not.toContain('ToolCallPhaseProps')
  })
})
