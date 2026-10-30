/**
 * The `share-viewer` remote access policy, decided through a real remote access service: which actions a
 * share reader may take on which resource, which Session notifications it receives, the refusal codes the
 * reader page classifies, and the access snapshot the reader page opens with.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import RemoteAccessService, {
  type RemoteAccessAction,
  type RemoteAccessGrant,
  type RemoteAccessResource,
} from '@deepseek-ai/dsh-api-remote-access'
import { SessionId } from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { ForkPromptDecision, ForkRecord } from '../src/host/fork-registry.ts'
import type { ForkShareState, ViewerSessionMode } from '../src/host/fork-policy.ts'
import {
  POLICY_DECIDED_ACTIONS,
  createViewerAccessPolicy,
  readerWriteRefusal,
  type ViewerAccessFacts,
} from '../src/host/viewer-access-policy.ts'
import type { RemoteAccessEndpoint } from '@deepseek-ai/dsh-api-remote-access/types'
import type { ViewerCapabilityGroup } from '../src/host/viewer-declarations.ts'
import { shareViewerPrincipal } from '../src/host/viewer-principal.ts'

const reader = { providerId: 'feishu', tenantId: 'tenant-a', subjectId: 'ou_reader' }
const other = { ...reader, subjectId: 'ou_other' }
const READER = shareViewerPrincipal('share', reader)
const GLOBAL: RemoteAccessResource = { kind: 'global' }
const session = (id: string): RemoteAccessResource => ({ kind: 'session', id: SessionId(id) })
const workspace = (id: string): RemoteAccessResource => ({ kind: 'workspace', id: WorkspaceId(id) })
const CALL = { request: {} }

/**
 * The actions the served viewer page's startup and render paths need, listed once here as the contract the
 * policy must cover: an action a surface needs and a role omits does not fail loudly, it leaves that
 * surface stating the read-only fact. The assembled-page fixture models its access snapshot from the same
 * set, so the two are read together when a role changes.
 */
const GLOBAL_ACTIONS = [
  'commands/list', 'llm/listConfigurableProviders', 'llm/listProviders', 'session/canOpenWorkspacePath',
  'session/control', 'session/list', 'session/modelCatalog', 'workspace/follow',
] as const
/** Session reads the served page's startup and render paths need; see {@link GLOBAL_ACTIONS}. */
const SESSION_READS = [
  'commands/list', 'fileUploads/upload', 'goals/get', 'session/attachment', 'session/control',
  'session/events', 'session/follow', 'session/list', 'session/observeEvent', 'session/observeProjections',
  'session/observeState', 'session/page', 'session/projections', 'session/state', 'session/wait',
  'skills/list', 'toolResults/watch', 'workspace/follow',
] as const
const SESSION_EVENTS = [
  'event:api-session/activity', 'event:api-session/added', 'event:api-session/error',
  'event:api-session/removed', 'event:api-session/status',
] as const

interface FixtureOptions {
  /** Drivable tier; `null` publishes a share whose tier this host cannot establish. */
  readonly mode?: ViewerSessionMode | null
  /** The share's own fork switch; on unless a case turns it off. */
  readonly allowsFork?: boolean
  readonly stopped?: boolean
  readonly expiresAt?: string
  readonly published?: boolean
  readonly admitted?: boolean
  readonly confined?: boolean
  readonly ceilings?: readonly string[]
}

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** The declaring plugin every capability in these cases is attributed to. */
const PLUGIN = 'mekGit'

/** One plugin's offered (or selected) endpoints, in the shape the registry and the share record use. */
const capabilityGroup = (
  readable: readonly RemoteAccessEndpoint[] = [],
  writable: readonly RemoteAccessEndpoint[] = [],
): ViewerCapabilityGroup =>
  ({ plugin: PLUGIN, readable, writable })

/** What the plugins offer and what this share's owner selected; both start empty and are mutable. */
interface CapabilityState {
  declared: ViewerCapabilityGroup[]
  selected: ViewerCapabilityGroup[]
}

function facts(
  options: FixtureOptions = {},
  capabilities: CapabilityState = { declared: [], selected: [] },
): ViewerAccessFacts {
  const children: ForkRecord[] = [
    { childSessionId: 'own-child', shareId: 'share', sourceSessionId: 'source', boundary: 1, creator: reader, createdAt: '' },
    { childSessionId: 'revoked-child', shareId: 'share', sourceSessionId: 'source', boundary: 1, creator: reader,
      createdAt: '', revokedAt: '2026-10-13T00:00:00Z' },
    { childSessionId: 'other-child', shareId: 'share', sourceSessionId: 'source', boundary: 1, creator: other, createdAt: '' },
    { childSessionId: 'foreign-child', shareId: 'foreign', sourceSessionId: 'foreign-source', boundary: 1, creator: reader, createdAt: '' },
  ]
  const mode = options.mode === undefined ? 'write' : options.mode
  const share: ForkShareState = {
    shareId: 'share',
    sessionId: 'source',
    allowsFork: options.allowsFork ?? true,
    viewerAdmitted: true,
    stopped: options.stopped ?? false,
    ...(mode === null ? {} : { sessionMode: mode }),
    ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    viewerCapabilities: capabilities.selected,
  }
  return {
    share: shareId => shareId === 'share' && options.published !== false ? share : undefined,
    viewerAdmitted: () => options.admitted !== false,
    sourceConfined: () => options.confined ?? true,
    forks: {
      find: id => children.find(child => child.childSessionId === id),
      listForShare: shareId => children.filter(child => child.shareId === shareId),
      allowsPrompt: (id): ForkPromptDecision => (options.ceilings ?? ['own-child']).includes(id)
        ? { ok: true }
        : { ok: false, code: 'fork-ceiling-uninstalled', message: 'no ceiling' },
    },
    workspaces: () => [
      { id: WorkspaceId('shared-ws'), sessionIds: [SessionId('private'), SessionId('source')] },
      { id: WorkspaceId('child-ws'), sessionIds: [SessionId('own-child')] },
      { id: WorkspaceId('private-ws'), sessionIds: [SessionId('private'), SessionId('other-child')] },
    ],
    declaredCapabilities: () => capabilities.declared,
  }
}

async function fixture(options: FixtureOptions = {}) {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  const access = ctx.remoteAccess
  const capabilities: CapabilityState = { declared: [], selected: [] }
  access.registerPolicy('share-viewer', createViewerAccessPolicy(facts(options, capabilities)))
  const replace = (target: ViewerCapabilityGroup[], groups: readonly ViewerCapabilityGroup[]) => {
    target.splice(0, target.length, ...groups)
  }
  const decide = (action: RemoteAccessAction, resource: RemoteAccessResource, args?: Readonly<Record<string, unknown>>) =>
    access.decide({ principal: READER, action, resources: [resource], ...(args === undefined ? {} : { args }) })
  const grants = (principal = READER): readonly RemoteAccessGrant[] => {
    const baseline = access.snapshotFor(principal)
    return baseline.owner ? [] : baseline.grants
  }
  return {
    access,
    decide,
    grants,
    /** What the mounted plugins currently offer, as registering them through {@link ViewerDeclarations} reports. */
    offer: (groups: readonly ViewerCapabilityGroup[]) => { replace(capabilities.declared, groups) },
    /** What this share's owner selected in the share panel. */
    select: (groups: readonly ViewerCapabilityGroup[]) => { replace(capabilities.selected, groups) },
  }
}

const ALLOW = { kind: 'allow' }
const deny = (reason: string) => ({ kind: 'deny', reason })

describe('share reader access policy', () => {
  it.each([
    [{ published: false }, 'share-not-found'],
    [{ stopped: true }, 'share-stopped'],
    [{ expiresAt: '2000-01-01T00:00:00Z' }, 'share-expired'],
    [{ admitted: false }, 'viewer-not-authorized'],
  ] as const)('binds nothing and reports the share refusal while the share does not serve the reader (%o)', async (options, reason) => {
    const { decide, grants } = await fixture(options)
    expect(decide('session/list', GLOBAL)).toEqual(deny(reason))
    expect(decide('session/page', session('source'))).toEqual(deny(reason))
    expect(decide('session/prompt', session('source'), CALL)).toEqual(deny(reason))
    expect(decide('event:api-session/status', session('source'))).toEqual(deny(reason))
    expect(grants()).toEqual([])
  })

  it('allows the global reads and refuses every other action on the global resource as read-only', async () => {
    const { decide } = await fixture()
    for (const action of GLOBAL_ACTIONS) expect(decide(action, GLOBAL)).toEqual(ALLOW)
    for (const action of ['settings/describe', 'goals/get', 'session/page', 'session/follow', 'session/create',
      'session/search', 'event:api-session/status'] as const) {
      expect(decide(action, GLOBAL)).toEqual(deny('liveshare/read-only'))
    }
  })

  it('allows Session reads of the shared Session and the reader’s own forks only', async () => {
    const { decide } = await fixture()
    for (const id of ['source', 'own-child', 'revoked-child']) {
      for (const action of SESSION_READS) expect(decide(action, session(id))).toEqual(ALLOW)
    }
    for (const id of ['private', 'other-child', 'foreign-child']) {
      for (const action of SESSION_READS) expect(decide(action, session(id))).toEqual(deny('liveshare/read-only'))
    }
    expect(decide('session/rename', session('source'))).toEqual(deny('liveshare/read-only'))
    // Only the reader's own fork may be renamed; the shared Session keeps fork as its one Session verb.
    expect(decide('session/rename', session('own-child'))).toEqual(ALLOW)
    expect(decide('session/rename', session('other-child'))).toEqual(deny('liveshare/read-only'))
  })

  it('forwards Session notifications about the shared Session and the reader’s own forks only', async () => {
    const { decide } = await fixture()
    for (const id of ['source', 'own-child', 'revoked-child']) {
      for (const action of SESSION_EVENTS) expect(decide(action, session(id))).toEqual(ALLOW)
    }
    for (const id of ['private', 'other-child', 'foreign-child']) {
      for (const action of SESSION_EVENTS) expect(decide(action, session(id)).kind).toBe('deny')
    }
    expect(decide('event:api-session/status', workspace('shared-ws')).kind).toBe('deny')
    expect(decide('event:commands/change', session('source')).kind).toBe('deny')
  })

  it.each([
    ['view', false], ['view', true], ['write', false], ['write', true],
  ] as const)('allows attachment upload on every Session the reader can see (mode=%s, fork=%s)', async (mode, allowsFork) => {
    const { decide } = await fixture({ mode, allowsFork })
    // Neither the tier nor the fork switch decides an attachment: upload follows the visibility the read
    // role already grants, so every readable Session accepts files.
    for (const id of ['source', 'own-child', 'revoked-child']) {
      expect(decide('fileUploads/upload', session(id))).toEqual(ALLOW)
    }
    // Another reader's fork, a foreign share's fork, and a Session the reader cannot see stay read-only.
    for (const id of ['other-child', 'foreign-child', 'private']) {
      expect(decide('fileUploads/upload', session(id))).toEqual(deny('liveshare/read-only'))
    }
    // A share whose tier this host cannot establish is still visible, so it still accepts files.
    expect((await fixture({ mode: null })).decide('fileUploads/upload', session('source'))).toEqual(ALLOW)
  }, 10_000)

  it('follows a Workspace only while it holds a Session the reader can see', async () => {
    const { decide } = await fixture()
    expect(decide('workspace/follow', workspace('shared-ws'))).toEqual(ALLOW)
    expect(decide('workspace/follow', workspace('child-ws'))).toEqual(ALLOW)
    expect(decide('workspace/follow', workspace('private-ws'))).toEqual(deny('liveshare/read-only'))
    expect(decide('workspace/follow', workspace('missing-ws'))).toEqual(deny('liveshare/read-only'))
    expect(decide('workspace/rename', workspace('shared-ws'))).toEqual(deny('liveshare/read-only'))
  })

  it('allows forking the shared Session and the reader’s own active fork while the share’s switch is on', async () => {
    // Forking is its own switch: both tiers may carry it, and a share whose owner turned it off refuses.
    expect((await fixture({ mode: 'view' })).decide('session/fork', session('source'), CALL)).toEqual(ALLOW)
    expect((await fixture({ mode: 'write' })).decide('session/fork', session('source'), CALL)).toEqual(ALLOW)
    expect((await fixture({ allowsFork: false })).decide('session/fork', session('source'), CALL))
      .toEqual(deny('fork-not-permitted'))
    const { decide } = await fixture()
    // The reader's own fork carries the same fork verb as the source grant, under the same switch.
    expect(decide('session/fork', session('own-child'), CALL)).toEqual(ALLOW)
    expect((await fixture({ allowsFork: false })).decide('session/fork', session('own-child'), CALL))
      .toEqual(deny('fork-not-permitted'))
    expect(decide('session/fork', session('private'), CALL)).toEqual(deny('source-session-mismatch'))
    // A revoked fork is kept for reading only, so neither fork nor rename is offered on it.
    expect(decide('session/fork', session('revoked-child'), CALL)).toEqual(deny('fork-source-revoked'))
    expect(decide('session/rename', session('revoked-child'))).toEqual(deny('fork-source-revoked'))
  })

  it('keeps fork and rename on separate roles for the reader’s own child', async () => {
    const allowed = await fixture()
    expect(allowed.decide('session/fork', session('own-child'), CALL)).toEqual(ALLOW)
    expect(allowed.decide('session/rename', session('own-child'))).toEqual(ALLOW)
    // The owner's fork switch gates the fork role alone, so turning it off leaves the child role as it was.
    const switchedOff = await fixture({ allowsFork: false })
    expect(switchedOff.decide('session/fork', session('own-child'), CALL)).toEqual(deny('fork-not-permitted'))
    expect(switchedOff.decide('session/rename', session('own-child'))).toEqual(ALLOW)
    // The child role binds only the reader's own forks: the source and another reader's fork have no rename.
    expect(allowed.decide('session/rename', session('source'))).toEqual(deny('liveshare/read-only'))
    expect(allowed.decide('session/rename', session('other-child'))).toEqual(deny('liveshare/read-only'))
  })

  it('allows prompting the shared Session in either tier, and only while it is confined', async () => {
    expect((await fixture()).decide('session/prompt', session('source'), CALL)).toEqual(ALLOW)
    // The view tier drives the shared Session too; what it cannot do is write, which the confined layer
    // refuses per tool rather than the access snapshot.
    expect((await fixture({ mode: 'view' })).decide('session/prompt', session('source'), CALL)).toEqual(ALLOW)
    expect((await fixture({ confined: false })).decide('session/prompt', session('source'), CALL))
      .toEqual(deny('source-write-unavailable'))
  })

  it('allows stopping the shared Session in either tier, and only while it is confined', async () => {
    const { decide } = await fixture()
    expect(decide('session/cancel', session('source'))).toEqual(ALLOW)
    // The cancel is dispatched like a prompt, so the same confinement rule decides the concrete call.
    expect(decide('session/cancel', session('source'), CALL)).toEqual(ALLOW)
    expect((await fixture({ confined: false })).decide('session/cancel', session('source')))
      .toEqual(deny('source-write-unavailable'))
    expect((await fixture({ confined: false })).decide('session/cancel', session('source'), CALL))
      .toEqual(deny('source-write-unavailable'))
  })

  it('allows driving the reader’s own live fork and names why another Session is refused', async () => {
    const { decide } = await fixture()
    expect(decide('session/prompt', session('own-child'))).toEqual(ALLOW)
    expect(decide('session/prompt', session('own-child'), CALL)).toEqual(ALLOW)
    expect(decide('session/cancel', session('own-child'), CALL)).toEqual(ALLOW)
    expect(decide('session/prompt', session('revoked-child'), CALL)).toEqual(deny('fork-source-revoked'))
    expect(decide('session/cancel', session('revoked-child'))).toEqual(deny('fork-source-revoked'))
    expect(decide('session/prompt', session('other-child'), CALL)).toEqual(deny('fork-viewer-mismatch'))
    expect(decide('session/prompt', session('foreign-child'), CALL)).toEqual(deny('fork-unknown-child'))
    expect(decide('session/cancel', session('private'), CALL)).toEqual(deny('fork-unknown-child'))
    // A branch this reader made is driven in either tier.
    expect((await fixture({ mode: 'view' })).decide('session/prompt', session('own-child'), CALL)).toEqual(ALLOW)
  })

  it('requires the installed ceiling only for a concrete fork prompt', async () => {
    const { decide } = await fixture({ ceilings: [] })
    // A snapshot keeps the composer of a cold fork available; preparing it on the first prompt installs the ceiling.
    expect(decide('session/prompt', session('own-child'))).toEqual(ALLOW)
    expect(decide('session/prompt', session('own-child'), CALL)).toEqual(deny('fork-ceiling-uninstalled'))
    expect(decide('session/cancel', session('own-child'), CALL)).toEqual(ALLOW)
  })

  it('reads a share whose tier this host cannot establish, and drives nothing of it', async () => {
    const { decide } = await fixture({ mode: null })
    expect(decide('session/page', session('source'))).toEqual(ALLOW)
    expect(decide('session/prompt', session('source'), CALL)).toEqual(deny('source-write-unavailable'))
    // The switch is independent of the tier, so forking still answers for it.
    expect(decide('session/fork', session('source'), CALL)).toEqual(ALLOW)
    // The reader's own branch is driven whatever the share's tier turns out to be.
    expect(decide('session/prompt', session('own-child'), CALL)).toEqual(ALLOW)
    expect((await fixture({ mode: null, allowsFork: false })).decide('session/fork', session('source'), CALL))
      .toEqual(deny('fork-not-permitted'))
  })

  it('refuses a call unless every resource it touches is allowed', async () => {
    const { access } = await fixture()
    expect(access.decide({ principal: READER, action: 'workspace/follow', resources: [workspace('shared-ws'), session('private')] }))
      .toEqual(deny('liveshare/read-only'))
    expect(access.decide({ principal: READER, action: 'workspace/follow', resources: [workspace('shared-ws'), session('source')] }))
      .toEqual(ALLOW)
  })

  it('opens the reader with grants on global, the shared Session, its own forks, and the Workspaces holding them', async () => {
    const { grants } = await fixture()
    const reads = [...SESSION_READS]
    expect(grants()).toEqual([
      { resource: GLOBAL, actions: [...GLOBAL_ACTIONS].sort() },
      { resource: session('source'), actions: [...reads, 'session/cancel', 'session/fork', 'session/prompt'].sort() },
      // The reader's own fork carries the source grant's fork verb, and is the only Session it may rename.
      { resource: session('own-child'), actions: [...reads, 'session/cancel', 'session/fork', 'session/prompt',
        'session/rename'].sort() },
      // A revoked fork stays readable, so the page states it as read-only rather than unknown.
      { resource: session('revoked-child'), actions: [...reads].sort() },
      { resource: workspace('shared-ws'), actions: ['workspace/follow'] },
      { resource: workspace('child-ws'), actions: ['workspace/follow'] },
    ])
    // Another reader of the same share holds its own forks, not this reader's.
    expect(grants(shareViewerPrincipal('share', other)).map(grant => grant.resource)).toEqual([
      GLOBAL, session('source'), session('other-child'), workspace('shared-ws'), workspace('private-ws'),
    ])
  })

  it('leaves actions whose condition refuses out of the snapshot', async () => {
    const sourceActions = async (options: FixtureOptions) =>
      (await fixture(options)).grants().find(grant => grant.resource.kind === 'session' && grant.resource.id === 'source')?.actions
    const childActions = async (options: FixtureOptions) =>
      (await fixture(options)).grants().find(grant => grant.resource.kind === 'session' && grant.resource.id === 'own-child')?.actions
    const driving = [...SESSION_READS, 'session/cancel', 'session/fork', 'session/prompt'].sort()
    expect(await sourceActions({ mode: 'view' })).toEqual(driving)
    expect(await sourceActions({ mode: 'write' })).toEqual(driving)
    // Without the confined layer the Session is not driven, and without the switch it is not forked.
    expect(await sourceActions({ confined: false })).toEqual([...SESSION_READS, 'session/fork'].sort())
    expect(await sourceActions({ allowsFork: false })).toEqual([...SESSION_READS, 'session/cancel', 'session/prompt'].sort())
    const { grants } = await fixture({ mode: 'view' })
    expect(grants().find(grant => grant.resource.kind === 'session' && grant.resource.id === 'own-child')?.actions)
      .toEqual([...SESSION_READS, 'session/cancel', 'session/fork', 'session/prompt', 'session/rename'].sort())
    // The switch removes the child's fork alone: the child role and its rename stay in the snapshot.
    expect(await childActions({ allowsFork: false }))
      .toEqual([...SESSION_READS, 'session/cancel', 'session/prompt', 'session/rename'].sort())
  })
})

describe('derived policy actions', () => {
  it('derives exactly the actions the viewer roles list', () => {
    // These arrays are the served page's contract, written before the classification table existed; the
    // derived set must reproduce their union so the table cannot add or remove a reader action.
    const roleActions = new Set<string>([
      ...GLOBAL_ACTIONS,
      ...SESSION_READS,
      ...SESSION_EVENTS,
      'session/prompt',
      'session/cancel',
      'session/fork',
      'session/rename',
      'fileUploads/upload',
    ])
    expect([...POLICY_DECIDED_ACTIONS].sort()).toEqual([...roleActions].sort())
  })
})

describe('viewer page startup contract', () => {
  it('allows following the reader’s own access stream, which no role has to list', async () => {
    const { decide } = await fixture()
    // `RemoteAccessService.decide` allows this action before it consults any policy, so the page's own
    // snapshot stream opens whatever the share grants. A role entry here would be unreachable code.
    expect(decide('remoteAccess/follow', GLOBAL)).toEqual(ALLOW)
    expect(decide('remoteAccess/follow', session('source'))).toEqual(ALLOW)
  })

  it('keeps the owner’s own surfaces refused and out of the reader’s snapshot', async () => {
    const { decide, grants } = await fixture()
    const ownerOnly = ['account/watch', 'job/list', 'job/follow', 'settings/describe',
      'credentials/describe', 'pluginManager/listPlugins', 'schedule/catalog', 'schedule/create',
      'schedule/deliveryLimits', 'schedule/deleteInactive', 'schedule/edit', 'schedule/history',
      'schedule/list', 'schedule/run', 'schedule/view'] as const
    for (const action of ownerOnly) expect(decide(action, GLOBAL)).toEqual(deny('liveshare/read-only'))
    const granted = new Set(grants().flatMap(grant => [...grant.actions]))
    for (const action of ownerOnly) expect(granted.has(action)).toBe(false)
  })

  it('grants every action the served page’s startup and render paths need', async () => {
    // The page reads only this snapshot, so an action it needs here and the policy omits leaves a
    // surface silently stating the read-only fact instead of failing loudly.
    const source = async (options: FixtureOptions) =>
      (await fixture(options)).grants().find(grant => grant.resource.kind === 'session' && grant.resource.id === 'source')?.actions ?? []
    const { grants } = await fixture()
    const global = grants().find(grant => grant.resource.kind === 'global')?.actions ?? []
    for (const action of GLOBAL_ACTIONS) expect(global).toContain(action)
    for (const action of SESSION_READS) expect(await source({})).toContain(action)
    // The driving actions ride the same reads, and the confined layer is what decides them.
    for (const action of ['session/prompt', 'session/cancel', 'session/fork']) expect(await source({})).toContain(action)
    // The tier decides no driving action: both tiers carry the prompt and the fork switch of their own.
    for (const action of SESSION_READS) expect(await source({ mode: 'view' })).toContain(action)
    for (const action of ['session/prompt', 'session/cancel', 'session/fork']) {
      expect(await source({ mode: 'view' })).toContain(action)
    }
    for (const action of ['session/prompt', 'session/cancel']) {
      expect(await source({ confined: false })).not.toContain(action)
    }
  })

  it('drops the write actions when the share cannot drive its Session, so no surface offers writing', async () => {
    const { grants } = await fixture({ confined: false })
    const actions = grants().find(grant => grant.resource.kind === 'session' && grant.resource.id === 'source')?.actions ?? []
    for (const action of SESSION_READS) expect(actions).toContain(action)
    expect(actions).not.toContain('session/prompt')
    expect(actions).not.toContain('session/cancel')
  })
})

describe('reader write refusal', () => {
  const refusal = (options: FixtureOptions, action: 'session/prompt' | 'session/cancel', sessionId: string, concrete: boolean) =>
    readerWriteRefusal(facts(options), READER, action, sessionId, concrete)

  it('applies the policy’s write rules to the shared Session and the reader’s forks', () => {
    expect(refusal({}, 'session/prompt', 'source', true)).toBeUndefined()
    expect(refusal({}, 'session/cancel', 'source', false)).toBeUndefined()
    expect(refusal({}, 'session/cancel', 'source', true)).toBeUndefined()
    expect(refusal({ confined: false }, 'session/prompt', 'source', true)).toBe('source-write-unavailable')
    expect(refusal({ confined: false }, 'session/cancel', 'source', false)).toBe('source-write-unavailable')
    expect(refusal({ mode: null }, 'session/cancel', 'source', false)).toBe('source-write-unavailable')
    expect(refusal({}, 'session/prompt', 'own-child', true)).toBeUndefined()
    expect(refusal({ ceilings: [] }, 'session/prompt', 'own-child', false)).toBeUndefined()
    expect(refusal({ ceilings: [] }, 'session/prompt', 'own-child', true)).toBe('fork-ceiling-uninstalled')
    expect(refusal({}, 'session/prompt', 'revoked-child', false)).toBe('fork-source-revoked')
    expect(refusal({ mode: 'view' }, 'session/cancel', 'own-child', true)).toBeUndefined()
    expect(refusal({}, 'session/prompt', 'other-child', true)).toBe('fork-viewer-mismatch')
    expect(refusal({}, 'session/cancel', 'foreign-child', true)).toBe('fork-unknown-child')
  })

  it.each([
    [{ published: false }, 'share-not-found'],
    [{ stopped: true }, 'share-stopped'],
    [{ expiresAt: '2000-01-01T00:00:00Z' }, 'share-expired'],
    [{ admitted: false }, 'viewer-not-authorized'],
  ] as const)('reports the share refusal first (%o)', (options, reason) => {
    expect(refusal(options, 'session/prompt', 'source', true)).toBe(reason)
    expect(refusal(options, 'session/cancel', 'own-child', false)).toBe(reason)
  })
})

describe('plugin capabilities a share exposes', () => {
  const READABLE = 'mekGit/getGraph'
  const WRITABLE = 'mekGit/commit'
  /** Every resource a served reader can see, where an exposed readable capability rides. */
  const VISIBLE = [
    GLOBAL, session('source'), session('own-child'), session('revoked-child'),
    workspace('shared-ws'), workspace('child-ws'),
  ]

  it.each(['view', 'write'] as const)(
    'allows an exposed readable capability on every resource the reader can see in the %s tier',
    async (mode) => {
      const { decide, offer, select, grants } = await fixture({ mode })
      // The policy is built before both sides, so these decisions prove it reads them per decision.
      expect(decide(READABLE, GLOBAL)).toEqual(deny('liveshare/read-only'))
      expect(decide(READABLE, session('source'))).toEqual(deny('liveshare/read-only'))
      offer([capabilityGroup([READABLE])])
      // A plugin's offer is not a grant: nothing is exposed until the owner selects it in this share.
      expect(decide(READABLE, GLOBAL)).toEqual(deny('liveshare/read-only'))
      expect(grants().flatMap(grant => [...grant.actions])).not.toContain(READABLE)
      select([capabilityGroup([READABLE])])
      for (const resource of VISIBLE) expect(decide(READABLE, resource)).toEqual(ALLOW)
    })

  it('keeps an exposed capability off the resources the reader cannot see', async () => {
    const { decide, offer, select } = await fixture()
    offer([capabilityGroup([READABLE], [WRITABLE])])
    select([capabilityGroup([READABLE], [WRITABLE])])
    for (const resource of [session('private'), session('other-child'), session('foreign-child'),
      workspace('private-ws'), workspace('missing-ws')]) {
      expect(decide(READABLE, resource)).toEqual(deny('liveshare/read-only'))
      expect(decide(WRITABLE, resource)).toEqual(deny('liveshare/read-only'))
    }
    // A revoked fork stays bound for reading only, so a writable capability carries no binding there.
    expect(decide(READABLE, session('revoked-child'))).toEqual(ALLOW)
    expect(decide(WRITABLE, session('revoked-child'))).toEqual(deny('liveshare/read-only'))
  })

  it('refuses again as soon as the owner clears the selection', async () => {
    const { decide, offer, select } = await fixture()
    offer([capabilityGroup([READABLE], [WRITABLE])])
    select([capabilityGroup([READABLE], [WRITABLE])])
    expect(decide(READABLE, session('source'))).toEqual(ALLOW)
    expect(decide(WRITABLE, session('source'))).toEqual(ALLOW)
    select([capabilityGroup()])
    expect(decide(READABLE, session('source'))).toEqual(deny('liveshare/read-only'))
    expect(decide(WRITABLE, session('source'))).toEqual(deny('liveshare/read-only'))
  })

  it('refuses a selection whose plugin no longer offers the endpoint', async () => {
    const { decide, offer, select, grants } = await fixture()
    offer([capabilityGroup([READABLE], [WRITABLE])])
    select([capabilityGroup([READABLE], [WRITABLE])])
    expect(decide(READABLE, session('source'))).toEqual(ALLOW)
    // The plugin withdrew its declaration while the share still carries the owner's stale selection.
    offer([])
    expect(decide(READABLE, session('source'))).toEqual(deny('liveshare/read-only'))
    expect(decide(WRITABLE, session('source'))).toEqual(deny('liveshare/read-only'))
    expect(grants().flatMap(grant => [...grant.actions])).not.toContain(READABLE)
    // A selection under another plugin cannot expose this plugin's endpoint either.
    offer([capabilityGroup([READABLE])])
    select([{ plugin: 'other-plugin', readable: [READABLE], writable: [] }])
    expect(decide(READABLE, session('source'))).toEqual(deny('liveshare/read-only'))
  })

  it('binds no capability while the share does not serve the reader', async () => {
    const { decide, grants, offer, select } = await fixture({ published: false })
    offer([capabilityGroup([READABLE], [WRITABLE])])
    select([capabilityGroup([READABLE], [WRITABLE])])
    expect(decide(READABLE, session('source'))).toEqual(deny('share-not-found'))
    expect(decide(WRITABLE, session('source'))).toEqual(deny('share-not-found'))
    expect(grants()).toEqual([])
  })

  it('grants an exposed readable capability to the served page on every visible resource', async () => {
    const { grants, offer, select } = await fixture()
    offer([capabilityGroup([READABLE])])
    select([capabilityGroup([READABLE])])
    const list = grants()
    const actionsOn = (kind: 'session' | 'workspace', id: string) =>
      list.find(grant => grant.resource.kind === kind && grant.resource.id === id)?.actions ?? []
    expect(list.find(grant => grant.resource.kind === 'global')?.actions ?? []).toContain(READABLE)
    for (const id of ['source', 'own-child', 'revoked-child']) expect(actionsOn('session', id)).toContain(READABLE)
    for (const id of ['shared-ws', 'child-ws']) expect(actionsOn('workspace', id)).toContain(READABLE)
  })

  it('exposes a writable capability only where the share mode already allows writes', async () => {
    const write = await fixture({ mode: 'write' })
    write.offer([capabilityGroup([], [WRITABLE])])
    write.select([capabilityGroup([], [WRITABLE])])
    for (const resource of [GLOBAL, session('source'), session('own-child'),
      workspace('shared-ws'), workspace('child-ws')]) {
      expect(write.decide(WRITABLE, resource)).toEqual(ALLOW)
    }
    // The owner states consent for writes only through the write tier, so a read share keeps refusing.
    for (const mode of ['view'] as const) {
      const { decide, offer, select } = await fixture({ mode })
      offer([capabilityGroup([], [WRITABLE])])
      select([capabilityGroup([], [WRITABLE])])
      expect(decide(WRITABLE, session('source'))).toEqual(deny('share-not-writable'))
      expect(decide(WRITABLE, GLOBAL)).toEqual(deny('share-not-writable'))
      expect(decide(WRITABLE, workspace('shared-ws'))).toEqual(deny('share-not-writable'))
    }
  })

  it('refuses an exposed writable capability while the source Session carries no confined layer', async () => {
    const { decide, offer, select } = await fixture({ confined: false })
    offer([capabilityGroup([], [WRITABLE])])
    select([capabilityGroup([], [WRITABLE])])
    expect(decide(WRITABLE, session('source'))).toEqual(deny('source-write-unavailable'))
    // The capability neither allows the endpoint nor changes why the share refuses its own write.
    expect(decide('session/prompt', session('source'), CALL)).toEqual(deny('source-write-unavailable'))
  })

  it('keeps the readable and writable selections apart', async () => {
    const { decide, offer, select } = await fixture({ mode: 'view' })
    offer([capabilityGroup([], [WRITABLE])])
    // The owner selected the endpoint as readable, which the plugin never offered as readable.
    select([capabilityGroup([WRITABLE])])
    expect(decide(WRITABLE, session('source'))).toEqual(deny('liveshare/read-only'))
    // Selected as writable it is exposed under the write rule, so a read-only share still refuses it.
    select([capabilityGroup([], [WRITABLE])])
    expect(decide(WRITABLE, session('source'))).toEqual(deny('share-not-writable'))
    // Offered and selected as readable, the same endpoint is exposed in a read-only share.
    offer([capabilityGroup([WRITABLE])])
    select([capabilityGroup([WRITABLE])])
    expect(decide(WRITABLE, session('source'))).toEqual(ALLOW)
    // And a writable selection never exposes an endpoint as readable.
    offer([capabilityGroup([READABLE], [READABLE])])
    select([capabilityGroup([], [READABLE])])
    expect(decide(READABLE, session('source'))).toEqual(deny('share-not-writable'))
    select([capabilityGroup([READABLE])])
    expect(decide(READABLE, session('source'))).toEqual(ALLOW)
  })

  it('keeps a writable capability out of the grants a share without writes publishes', async () => {
    const view = await fixture({ mode: 'view' })
    view.offer([capabilityGroup([], [WRITABLE])])
    view.select([capabilityGroup([], [WRITABLE])])
    expect(view.grants().flatMap(grant => [...grant.actions])).not.toContain(WRITABLE)
    const write = await fixture({ mode: 'write' })
    write.offer([capabilityGroup([], [WRITABLE])])
    write.select([capabilityGroup([], [WRITABLE])])
    const source = write.grants()
      .find(grant => grant.resource.kind === 'session' && grant.resource.id === 'source')?.actions ?? []
    expect(source).toContain(WRITABLE)
  })

  it('cannot replace the decision a share mode makes for a policy action', async () => {
    const decideds: readonly RemoteAccessEndpoint[] = ['session/prompt', 'session/cancel', 'session/fork']
    const view = await fixture({ mode: 'view' })
    // Every isolation probe offers and selects a policy-decided action in both kinds at once.
    view.offer([capabilityGroup(decideds, decideds)])
    view.select([capabilityGroup(decideds, decideds)])
    // A view-tier share drives its Session in this deployment, so the isolation probe needs the share's
    // own switch and the reader's branch to show what the capability cannot change.
    expect(view.decide('session/cancel', session('source'), CALL)).toEqual(ALLOW)
    expect(view.decide('session/prompt', GLOBAL, CALL)).toEqual(deny('liveshare/read-only'))
    const switchedOff = await fixture({ mode: 'view', allowsFork: false })
    expect(switchedOff.decide('session/fork', session('source'), CALL)).toEqual(deny('fork-not-permitted'))

    // A write share keeps its own rules: a capability neither grants beyond them nor refuses within them.
    const unconfined = await fixture({ confined: false })
    unconfined.offer([capabilityGroup(['session/prompt'], ['session/prompt'])])
    unconfined.select([capabilityGroup(['session/prompt'], ['session/prompt'])])
    expect(unconfined.decide('session/prompt', session('source'), CALL)).toEqual(deny('source-write-unavailable'))
    const write = await fixture()
    write.offer([capabilityGroup(['session/prompt'], ['session/prompt'])])
    write.select([capabilityGroup(['session/prompt'], ['session/prompt'])])
    expect(write.decide('session/prompt', session('source'), CALL)).toEqual(ALLOW)
    // The reader's own fork keeps the child write role's ceiling decision as well.
    const cold = await fixture({ ceilings: [] })
    cold.offer([capabilityGroup([], ['session/prompt'])])
    cold.select([capabilityGroup([], ['session/prompt'])])
    expect(cold.decide('session/prompt', session('own-child'), CALL)).toEqual(deny('fork-ceiling-uninstalled'))
  })

  it('keeps an exposed policy action out of the grants where its condition refuses it', async () => {
    const { grants, offer, select } = await fixture({ mode: 'view', confined: false })
    offer([capabilityGroup(['session/prompt', READABLE])])
    select([capabilityGroup(['session/prompt', READABLE])])
    const source = grants().find(grant => grant.resource.kind === 'session' && grant.resource.id === 'source')?.actions ?? []
    expect(source).toContain(READABLE)
    expect(source).not.toContain('session/prompt')
  })
})
