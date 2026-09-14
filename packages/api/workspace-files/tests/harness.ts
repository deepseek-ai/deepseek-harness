/**
 * Shared fixture: a real local backend over a temp workspace beside a sibling
 * directory outside it, and a sandbox policy whose only job is naming the root.
 *
 * The real backend, not a mocked `ctx.fs`, because the gates under test are
 * only meaningful against a real filesystem: a symlink that leaves the
 * workspace, a file whose byte size exceeds the cap, and bytes that are not
 * text. A fake provider would let a string-prefix containment check pass this
 * file, which is exactly the defect the gate exists to prevent.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { WorkspaceFiles, type Config, type WorkspaceFileScope } from '../src/index.ts'

/** Build the header-derived scope that direct service calls receive after Typert lookup. */
function fileScope(workspaceRoot: string): WorkspaceFileScope {
  return { sessionId: SessionId('s-test'), workspaceRoot }
}

export const signal = (): AbortSignal => new AbortController().signal

/** One temp workspace and the context serving it. */
export interface Harness {
  readonly workspace: string
  readonly outside: string
  readonly ctx: Context
  readonly scope: WorkspaceFileScope
  /**
   * The service under test, at the given caps. One per test: the service key is
   * global to the Context, so a second call with caps is a defect in the test.
   */
  endpoint(caps?: Partial<Config>): WorkspaceFiles
  dispose(): Promise<void>
}

/**
 * Create the workspace, its outside sibling, and a context with the local
 * backend rooted at the workspace.
 * @param prefix - temp directory prefix naming the suite.
 * @returns the harness; dispose it in `afterEach`.
 */
export async function openWorkspace(prefix: string): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  await mkdir(workspace, { recursive: true })
  await mkdir(outside, { recursive: true })
  const ctx = new Context()
  const fiber = await ctx.plugin(LocalFileSystem, { cwd: workspace })
  ctx.provide('sandboxPolicy', {
    workspaceRoot: workspace,
    resolve: () => ({ mode: 'workspace-write', workspaceRoot: workspace }),
  } as never)
  let service: WorkspaceFiles | undefined
  return {
    workspace,
    outside,
    ctx,
    scope: fileScope(workspace),
    endpoint: (caps) => {
      if (service !== undefined) {
        if (caps !== undefined) throw new Error('the harness serves one WorkspaceFiles per test; hoist the endpoint')
        return service
      }
      service = new WorkspaceFiles(ctx, {
        maxBytes: caps?.maxBytes ?? 1024 * 1024,
        maxFileBytes: caps?.maxFileBytes ?? 1024 * 1024,
        maxLines: caps?.maxLines ?? 5000,
        maxEntries: caps?.maxEntries ?? 2000,
      })
      return service
    },
    dispose: async () => {
      await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}

/**
 * Await an operation expected to fail with a Remote error.
 * @param operation - the call under test.
 * @returns the Remote failure's code and details.
 */
export async function failureOf(operation: Promise<unknown>): Promise<{ code: string; details: unknown }> {
  try {
    await operation
  } catch (error: unknown) {
    const failure = remoteErrorOf(error)
    // A non-Remote throw is a defect in the service, not an expected outcome.
    if (failure === undefined) throw error
    return { code: failure.code, details: failure.details }
  }
  throw new Error('expected the operation to fail')
}
