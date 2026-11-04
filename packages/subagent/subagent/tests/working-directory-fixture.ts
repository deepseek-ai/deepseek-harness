import { Context, Service } from '@deepseek-ai/cordis'
import { resolve } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { within } from '@deepseek-ai/dsh-util-workspace-path'
import type { RelocateOptions, RelocatedDirectories } from '@deepseek-ai/dsh-working-directory'

/** Directory selection for orchestration fixtures whose paths are symbolic and whose logs exclude context providers. */
class FixtureWorkingDirectory extends Service {
  private readonly directories = new WeakMap<Session, string>()
  private readonly anchors = new WeakMap<Session, string[]>()

  constructor(ctx: Context) {
    super(ctx, 'workingDirectory')
  }

  get(session: Session): string {
    return this.directories.get(session) ?? session?.header.cwd ?? process.cwd()
  }

  rootOf(session: Session): string {
    const cwd = this.get(session)
    return this.anchorsOf(session).filter(anchor => within(anchor, cwd)).sort((a, b) => b.length - a.length)[0]
      ?? session?.header.cwd ?? process.cwd()
  }

  anchorsOf(session: Session): readonly string[] {
    return this.anchors.get(session) ?? [session?.header.cwd ?? process.cwd()]
  }

  async ensure(agent: Agent, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    return this.get(agent.session)
  }

  async set(agent: Agent, path: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const cwd = resolve(this.get(agent.session), path)
    this.directories.set(agent.session, cwd)
    return cwd
  }

  async relocate(agent: Agent, root: string, options: RelocateOptions = {}): Promise<RelocatedDirectories> {
    options.signal?.throwIfAborted()
    const anchor = resolve(this.get(agent.session), root)
    const cwd = options.cwd === undefined ? anchor : resolve(anchor, options.cwd)
    const anchors = [...this.anchorsOf(agent.session)]
    if (!anchors.includes(anchor)) anchors.push(anchor)
    this.anchors.set(agent.session, anchors)
    this.directories.set(agent.session, cwd)
    return { root: anchor, cwd }
  }
}

/** Mount the directory collaborator without filesystem or model-context behavior unrelated to an orchestration test. */
export async function mountWorkingDirectoryFixture(ctx: Context): Promise<void> {
  if (ctx.get('workingDirectory') === undefined) await ctx.plugin(FixtureWorkingDirectory)
}
