/** Test-only direct Remote face over the Session Controller's internal controllers. */

import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection as AgentModelSelection } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import {
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
  SessionReadOnlyError,
  type SessionAccess,
  type SessionHandle,
  type SessionHandleReadOptions,
  type SessionPersistenceListOptions,
  type SessionPersistenceOpenOptions,
  type SessionPersistenceSnapshot,
  type SessionPersistenceStatOptions,
} from '@deepseek-ai/dsh-session-persistence'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import { vi } from 'vitest'
import {
  RemoteError,
  remoteErrorOf,
  type RemoteResult,
} from '@deepseek-ai/dsh-typert-protocol'
import SessionController from '../src/index.ts'
import type {
  ModelCatalog,
  SessionAttachmentRequest,
  SessionAttachmentValue,
  SessionCancelRequest,
  SessionCancelValue,
  SessionControlFrame,
  SessionCreateRequest,
  SessionCreateValue,
  SessionForkRequest,
  SessionForkValue,
  SessionFollowFrame,
  SessionFollowRequest,
  SessionListRequest,
  SessionListValue,
  SessionOpenWorkspacePathRequest,
  SessionOpenWorkspacePathValue,
  SessionPage,
  SessionPageRequest,
  SessionPromptRequest,
  SessionPromptValue,
  SessionRenameRequest,
  SessionRenameValue,
  SessionSearchRequest,
  SessionSearchValue,
  SessionSelectModelRequest,
  SessionSelectModelValue,
  SessionUpdateQueueRequest,
  SessionUpdateQueueValue,
} from '../src/types.ts'

/** Direct test face matching the generated `ctx.remote.session` unary methods. */
export interface TestSessionRemote {
  canOpenWorkspacePath(): Promise<RemoteResult<boolean>>
  list(request: SessionListRequest, signal?: AbortSignal): Promise<RemoteResult<SessionListValue>>
  search(request: SessionSearchRequest, signal?: AbortSignal): Promise<RemoteResult<SessionSearchValue>>
  create(request: SessionCreateRequest): Promise<RemoteResult<SessionCreateValue>>
  selectModel(request: SessionSelectModelRequest): Promise<RemoteResult<SessionSelectModelValue>>
  modelCatalog(): Promise<RemoteResult<ModelCatalog>>
  rename(request: SessionRenameRequest): Promise<RemoteResult<SessionRenameValue>>
  fork(request: SessionForkRequest): Promise<RemoteResult<SessionForkValue>>
  prompt(request: SessionPromptRequest, signal?: AbortSignal): Promise<RemoteResult<SessionPromptValue>>
  attachment(request: SessionAttachmentRequest): Promise<RemoteResult<SessionAttachmentValue>>
  updateQueue(request: SessionUpdateQueueRequest): Promise<RemoteResult<SessionUpdateQueueValue>>
  cancel(request: SessionCancelRequest): Promise<RemoteResult<SessionCancelValue>>
  openWorkspacePath(
    request: SessionOpenWorkspacePathRequest,
    signal?: AbortSignal,
  ): Promise<RemoteResult<SessionOpenWorkspacePathValue>>
  page(request: SessionPageRequest, signal?: AbortSignal): Promise<RemoteResult<SessionPage>>
  follow(request: SessionFollowRequest, signal?: AbortSignal): AsyncIterable<SessionFollowFrame>
  control(signal?: AbortSignal): AsyncIterable<SessionControlFrame>
}

/** Dependencies and policy supplied by a Session Controller unit harness. */
export interface TestSessionRemoteDefaults {
  readonly defaultModelSelection: () => AgentModelSelection
  readonly cwd: string
  readonly coldBlankProbeMaxEvents?: number
  readonly coldBlankProbeMaxBytes?: number
  readonly nativeOpen?: boolean
  readonly saveDefaultModelSelection?: (selection: AgentModelSelection) => void | Promise<void>
  readonly openPath?: (path: string, signal: AbortSignal) => Promise<void>
  readonly canOpenPath?: () => boolean
}

const installed = new WeakMap<Context, SessionController>()

/** Compact header-and-events point read a persistence double declares per session. */
interface TestSessionInspection {
  readonly meta: SessionHeader
  readonly events: readonly SessionEvent[]
}

type LegacyTestPersistence = Record<string, unknown> & {
  readonly list?: (signal?: AbortSignal) => Promise<readonly SessionHeader[]>
  readonly inspect?: (
    sessionId: SessionId,
    signal?: AbortSignal,
  ) => Promise<TestSessionInspection | undefined>
  readonly stat?: (
    sessionId: SessionId,
    options?: SessionPersistenceStatOptions,
  ) => Promise<SessionPersistenceSnapshot | undefined>
  readonly open?: (
    sessionId: SessionId,
    access: SessionAccess,
    options?: SessionPersistenceOpenOptions,
  ) => Promise<SessionHandle>
}

/** One immutable read handle over a double's inspected header and events. */
function testReadHandle(
  sessionId: SessionId,
  inspection: TestSessionInspection,
): SessionHandle {
  const events = Object.freeze([...inspection.events])
  return {
    id: sessionId,
    header: inspection.meta,
    inheritedEventCount: SessionLogOffset(0),
    access: 'read',
    read: (offset = 0, length?: number, options?: SessionHandleReadOptions) => {
      options?.signal?.throwIfAborted()
      return Promise.resolve(events.slice(offset, length === undefined ? undefined : offset + length))
    },
    append: () => Promise.reject(new SessionReadOnlyError(sessionId, 'append')),
    flush: () => Promise.reject(new SessionReadOnlyError(sessionId, 'flush')),
    close: () => Promise.resolve(),
    [Symbol.asyncDispose]: () => Promise.resolve(),
  }
}

/**
 * Adapt a compact header/inspect persistence double onto the handle-based
 * abstract the production readers consume: `list` snapshots wrap the double's
 * headers, `stat` derives a metadata-less snapshot from the listing (so the
 * cold-blank probe skips unless the double declares its own `stat`), and
 * `open` serves immutable read handles over the double's `inspect` result.
 */
export function testSessionPersistence(
  _ctx: Context,
  persistence: LegacyTestPersistence,
): Record<string, unknown> {
  const listHeaders = async (signal?: AbortSignal): Promise<readonly SessionHeader[]> =>
    await persistence.list?.(signal) ?? []
  const adapted: Record<string, unknown> = {
    ...persistence,
    list: async (options?: SessionPersistenceListOptions) =>
      (await listHeaders(options?.signal)).map(header => ({
        header,
        revision: SessionPersistenceRevision(`test:${header.id}:list`),
      })),
  }
  if (persistence.stat === undefined) {
    adapted.stat = async (
      sessionId: SessionId,
      options?: SessionPersistenceStatOptions,
    ): Promise<SessionPersistenceSnapshot | undefined> => {
      options?.signal?.throwIfAborted()
      const header = (await listHeaders(options?.signal)).find(listed => listed.id === sessionId)
      return header === undefined
        ? undefined
        : { header, revision: SessionPersistenceRevision(`test:${sessionId}:stat`) }
    }
  }
  if (persistence.open === undefined) {
    adapted.open = async (
      sessionId: SessionId,
      access: SessionAccess,
      options?: SessionPersistenceOpenOptions,
    ): Promise<SessionHandle> => {
      options?.signal?.throwIfAborted()
      if (access !== 'read') {
        throw new Error(`test persistence double only serves read handles (requested "${access}")`)
      }
      const inspection = await persistence.inspect?.(sessionId, options?.signal)
      if (inspection === undefined) throw new SessionPersistenceNotFoundError(sessionId)
      return testReadHandle(sessionId, inspection)
    }
  }
  return adapted
}

/** Concrete point-read query used by Session Controller tests that do not exercise search. */
class TestSessionQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('session search is not configured in this test'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('event search is not configured in this test'))
  }
}

/** Install the required projection and point-query services for direct controller tests. */
export function installSessionReadTestServices(ctx: Context): void {
  if (ctx.get('sessionProjections') === undefined) new SessionProjectionRegistry(ctx)
  if (ctx.get('sessionQuery') === undefined) new TestSessionQuery(ctx)
}

function installControllers(
  ctx: Context,
  defaults: TestSessionRemoteDefaults,
): SessionController {
  const found = installed.get(ctx)
  if (found !== undefined) return found

  if (ctx.get('typert') === undefined) {
    const dispose = (): void => {}
    ctx.provide('typert', {
      lookups: { configure: () => dispose },
      contexts: { configureHost: () => dispose },
    } as never)
  }
  if (ctx.get('agentDefaultModel') === undefined) {
    ctx.provide('agentDefaultModel', {
      currentSelection: defaults.defaultModelSelection,
      saveSelection: async (selection: AgentModelSelection) => {
        await defaults.saveDefaultModelSelection?.(selection)
      },
    } as never)
  }
  if (ctx.get('llm') === undefined) {
    ctx.provide('llm', {
      listProviders: () => {
        const selection = defaults.defaultModelSelection()
        return [{ id: selection.provider, name: selection.provider }]
      },
    } as never)
  }
  installSessionReadTestServices(ctx)
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(defaults.cwd)
  let controller: SessionController
  try {
    controller = new SessionController(
      ctx,
      {
        ...defaults.coldBlankProbeMaxEvents === undefined
          ? {}
          : { coldBlankProbeMaxEvents: defaults.coldBlankProbeMaxEvents },
        ...defaults.coldBlankProbeMaxBytes === undefined
          ? {}
          : { coldBlankProbeMaxBytes: defaults.coldBlankProbeMaxBytes },
        ...defaults.nativeOpen === undefined ? {} : { nativeOpen: defaults.nativeOpen },
      },
      {
        ...defaults.openPath === undefined ? {} : { openPath: defaults.openPath },
        ...defaults.canOpenPath === undefined ? {} : { canOpenPath: defaults.canOpenPath },
      },
    )
  } finally {
    cwd.mockRestore()
  }
  installed.set(ctx, controller)
  return controller
}

/** Build or return the production Session Controller for a direct unit harness. */
export function createSessionTestController(
  ctx: Context,
  defaults: TestSessionRemoteDefaults,
): SessionController {
  return installControllers(ctx, defaults)
}

function remoteResult<T>(
  operation: () => T | Promise<T>,
  signal?: AbortSignal,
): Promise<RemoteResult<T>> {
  return Promise.resolve()
    .then(operation)
    .then(value => ({ ok: true as const, value }))
    .catch((error: unknown) => ({
      ok: false as const,
      error: signal?.aborted === true
        ? new RemoteError('gateway/cancelled', 'request was aborted', {})
        : remoteErrorOf(error)
          ?? new RemoteError(
            'gateway/internal',
            error instanceof Error ? error.message : String(error),
            {},
          ),
    }))
}

/** Build the generated Session Remote's unary result semantics without a carrier. */
export function createSessionTestRemote(
  ctx: Context,
  defaults: TestSessionRemoteDefaults,
): TestSessionRemote {
  const direct = createSessionTestController(ctx, defaults)
  return {
    canOpenWorkspacePath: () => remoteResult(() => direct.canOpenWorkspacePath()),
    list: (request, signal = new AbortController().signal) => remoteResult(
      () => direct.list(request, signal),
      signal,
    ),
    search: (request, signal = new AbortController().signal) => remoteResult(
      () => direct.search(request, signal),
      signal,
    ),
    create: request => remoteResult(() => direct.create(request)),
    selectModel: request => remoteResult(() => direct.selectModel(request)),
    modelCatalog: () => remoteResult(() => direct.modelCatalog()),
    rename: request => remoteResult(() => direct.rename(request)),
    fork: request => remoteResult(() => direct.fork(request)),
    prompt: (request, signal = new AbortController().signal) => remoteResult(
      () => direct.prompt(request, signal),
      signal,
    ),
    attachment: request => remoteResult(() => direct.attachment(request)),
    updateQueue: request => remoteResult(() => direct.updateQueue(request)),
    cancel: request => remoteResult(() => direct.cancel(request)),
    openWorkspacePath: (request, signal = new AbortController().signal) => remoteResult(
      () => direct.openWorkspacePath(request, signal),
      signal,
    ),
    page: (request, signal = new AbortController().signal) => remoteResult(
      () => direct.page(request, signal),
      signal,
    ),
    follow: (request, signal = new AbortController().signal) => direct.follow(request, signal),
    control: (signal = new AbortController().signal) => direct.control(signal),
  }
}
