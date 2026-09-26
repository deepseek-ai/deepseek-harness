/** Host Workspace Remote owner: explicit commands and reconnect-safe state. */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { WorkspaceCommands } from './commands.ts'
import { DirectoryPickerController } from './directory-picker.ts'
import { WorkspaceFeed, workspaceView } from './feed.ts'
import { defaultWorkspaceDirectory, validateDocumentsDirectory } from './default-directory.ts'
import type {
  WorkspaceArchiveSessionRequest,
  WorkspaceArchiveValue,
  WorkspaceCreateRequest,
  WorkspaceCreateValue,
  WorkspaceDeleteRequest,
  WorkspaceDeleteValue,
  WorkspaceFollowFrame,
  WorkspaceInsertBeforeRequest,
  WorkspaceInsertSessionBeforeRequest,
  WorkspaceOrderValue,
  WorkspacePinSessionRequest,
  WorkspacePinValue,
  WorkspaceRenameRequest,
  WorkspaceUnarchiveSessionRequest,
  WorkspaceUnpinSessionRequest,
  WorkspaceValue,
} from './types.ts'

export type * from './types.ts'
export { DirectoryPickerController } from './directory-picker.ts'

/** First-use directory policy for the Host account. */
export interface Config {
  /** Override the system Documents directory with a fully qualified path. */
  documentsDirectory?: string
  /** Maximum duration of the operating system's Documents lookup. */
  documentsLookupTimeoutMs?: number
}

/** Directory policy after schema defaults have been applied. */
type ResolvedConfig = Config & { documentsLookupTimeoutMs: number }

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Workspace business API and Remote namespace owner. */
    workspaceController: WorkspaceController
  }
}

/** Host service backing the generated `ctx.remote.workspace` namespace. */
export class WorkspaceController extends TypertRemoteService {
  static inject = ['typert', 'workspaceRegistry']

  static Config: z<Config, ResolvedConfig> = z.object({
    documentsDirectory: z.string(),
    documentsLookupTimeoutMs: z.natural().min(1).default(10_000),
  })

  private readonly config: ResolvedConfig
  private readonly commands: WorkspaceCommands
  private readonly feed: WorkspaceFeed

  /**
   * @param ctx - Host context containing the Workspace registry.
   * @param config - first-use directory policy.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'workspaceController', { namespace: 'workspace' })
    this.config = WorkspaceController.Config(config)
    if (this.config.documentsDirectory !== undefined) validateDocumentsDirectory(this.config.documentsDirectory)
    this.commands = new WorkspaceCommands(ctx)
    this.feed = new WorkspaceFeed(ctx)
    // This package is the Loader entry for both Remote owners it hosts: the
    // directory-picking seam is abstract and never an entry itself. The child
    // stays pending until a picking backend is composed, so a host without one
    // registers no picking namespace instead of answering an unservable verb.
    ctx.plugin(DirectoryPickerController)
  }

  /**
   * Create or idempotently resolve one Workspace over an existing directory.
   * @param request - directory path to register.
   * @returns the Workspace and whether this call created it.
   */
  @Remote('create')
  create(request: WorkspaceCreateRequest): Promise<WorkspaceCreateValue> {
    return this.commands.create(request)
  }

  /**
   * Initialize or reuse the default Workspace during first-use startup. The
   * directory name is fixed, so the Host never renames or relocates an
   * existing default; its initial title is that same name, which browser
   * consumers label in the reader's language.
   * @param signal - caller lifetime; cancels native directory lookup.
   * @returns the durable Workspace, or undefined when first-use initialization is ineligible; creates no Session or message.
   */
  @Remote('initializeDefault')
  async initializeDefault(signal: AbortSignal): Promise<WorkspaceValue | undefined> {
    const workspace = await this.ctx.workspaceRegistry.initializeDefault(async () => {
      const timeout = AbortSignal.timeout(this.config.documentsLookupTimeoutMs)
      return await defaultWorkspaceDirectory(
        this.config.documentsDirectory, AbortSignal.any([signal, timeout]),
      )
    })
    return workspace === undefined ? undefined : { workspace: workspaceView(workspace) }
  }

  /**
   * Rename one Workspace to a unique non-blank title.
   * @param request - Workspace identity and proposed title.
   * @returns the updated Workspace projection.
   */
  @Remote('rename')
  rename(request: WorkspaceRenameRequest): Promise<WorkspaceValue> {
    return this.commands.rename(request)
  }

  /**
   * Remove one Workspace registration while retaining files and Sessions.
   * @param request - Workspace identity to remove.
   * @returns deletion confirmation.
   */
  @Remote('delete')
  delete(request: WorkspaceDeleteRequest): Promise<WorkspaceDeleteValue> {
    return this.commands.delete(request)
  }

  /**
   * Move one Workspace within the registry display order.
   * @param request - moved Workspace and optional anchor.
   * @returns the complete resulting Workspace order.
   */
  @Remote('insertBefore')
  insertBefore(request: WorkspaceInsertBeforeRequest): Promise<WorkspaceOrderValue> {
    return this.commands.insertBefore(request)
  }

  /**
   * Move one accounted Session within a Workspace.
   * @param request - Workspace, Session, and optional anchor identities.
   * @returns the updated Workspace projection.
   */
  @Remote('insertSessionBefore')
  insertSessionBefore(request: WorkspaceInsertSessionBeforeRequest): Promise<WorkspaceValue> {
    return this.commands.insertSessionBefore(request)
  }

  /**
   * Hide one known Session from Workspace grouping surfaces.
   * @param request - Session identity to archive.
   * @returns the complete resulting archive set.
   */
  @Remote('archiveSession')
  archiveSession(request: WorkspaceArchiveSessionRequest): Promise<WorkspaceArchiveValue> {
    return this.commands.archiveSession(request)
  }

  /**
   * Restore one archived Session to Workspace grouping surfaces.
   * @param request - Session identity to unarchive.
   * @returns the complete resulting archive set.
   */
  @Remote('unarchiveSession')
  unarchiveSession(request: WorkspaceUnarchiveSessionRequest): Promise<WorkspaceArchiveValue> {
    return this.commands.unarchiveSession(request)
  }

  /**
   * Surface one known unarchived Session ahead of unpinned Sessions.
   * @param request - Session identity to pin.
   * @returns the complete resulting pin set, most recently pinned first.
   */
  @Remote('pinSession')
  pinSession(request: WorkspacePinSessionRequest): Promise<WorkspacePinValue> {
    return this.commands.pinSession(request)
  }

  /**
   * Remove one Session's pin without changing its saved Session order.
   * @param request - Session identity to unpin.
   * @returns the complete resulting pin set, most recently pinned first.
   */
  @Remote('unpinSession')
  unpinSession(request: WorkspaceUnpinSessionRequest): Promise<WorkspacePinValue> {
    return this.commands.unpinSession(request)
  }

  /**
   * Stream a complete Workspace baseline followed by ordered increments.
   * @param signal - generation cancellation.
   * @returns baseline followed by ordered Workspace increments.
   */
  @Remote({ mode: 'stream' })
  follow(signal: AbortSignal): AsyncIterable<WorkspaceFollowFrame> {
    return this.feed.follow(signal)
  }
}

export default WorkspaceController
