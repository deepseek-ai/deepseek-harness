import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobAppendOptions, JobHandle, JobOutcome } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

/** A registry with a tiny ring so eviction is cheap to reach. */
export async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry, { retainBytes: 64, settledRetainBytes: 64 })
  ctx.jobs.attachController('job-controller-test')
  return ctx
}

/** Register a live agent for `rawId` under its own lifecycle scope. */
export async function registerAgent(ctx: Context, rawId: string): Promise<Agent & { disposeScope: () => Promise<void> }> {
  const scopeFiber = ctx.plugin(() => {})
  const id = SessionId(rawId)
  const session = Session.create(id)
  const agent: Agent & { disposeScope: () => Promise<void> } = {
    id,
    options: {},
    session,
    inbox: unsupportedInbox(),
    status: 'idle',
    ctx: scopeFiber.ctx,
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
    disposeScope: () => scopeFiber.dispose(),
  }
  await ctx.agents.register(agent)
  return agent
}

/**
 * Start one push-producer job whose `done` settles on demand; expose the
 * handle's writers. A cancel settles the job as killed unless `slowStop`
 * keeps it stopping until the test settles it.
 */
export function startJob(ctx: Context, options: { label?: string; owner?: SessionId; slowStop?: boolean } = {}) {
  let settle!: (outcome: JobOutcome) => void
  let handle!: JobHandle
  const id = ctx.jobs.start({
    kind: 'bash',
    label: options.label ?? 'echo',
    ...options.owner !== undefined ? { owner: options.owner } : {},
    run: (job) => {
      handle = job
      return {
        cancel() { if (options.slowStop !== true) settle({ status: 'killed' }) },
        done: new Promise<JobOutcome>((resolve) => { settle = resolve }),
      }
    },
  })
  return {
    id,
    append: (text: string, opts?: JobAppendOptions) => { handle.append(text, opts) },
    progress: (line: string) => { handle.updateProgress(line) },
    settle: async (outcome: JobOutcome) => {
      settle(outcome)
      await new Promise(resolve => setTimeout(resolve, 0))
    },
  }
}

/** Read frames until `count` arrive or the generator finishes, then abort. */
export async function collect<Frame>(
  iterable: AsyncIterable<Frame>,
  count: number,
  abort: AbortController,
): Promise<Frame[]> {
  const frames: Frame[] = []
  const iterator = iterable[Symbol.asyncIterator]()
  try {
    while (frames.length < count) {
      const step = await iterator.next()
      if (step.done) return frames
      frames.push(step.value)
    }
  } finally {
    abort.abort()
    await iterator.next().catch(() => undefined)
  }
  return frames
}

export const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** The next yielded frame, or undefined once the generator finished. */
export async function next<Frame>(iterator: AsyncIterator<Frame>): Promise<Frame | undefined> {
  const step = await iterator.next()
  return step.done === true ? undefined : step.value
}
