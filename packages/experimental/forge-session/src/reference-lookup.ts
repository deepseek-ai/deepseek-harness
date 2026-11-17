/** Resolve unqualified CLI references in the shell execution world and persist only confirmed URLs. */

import type { Context } from '@deepseek-ai/cordis'
import { extractTextContent } from '@deepseek-ai/dsh-llm/message'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { z } from 'zod'
import type { CommandRules } from './commands.ts'

const completedShell = z.object({
  kind: z.literal('foreground'),
  cwd: z.string(),
  exitCode: z.literal(0),
  signal: z.null(),
  timedOut: z.literal(false),
  aborted: z.literal(false),
})
const shellArguments = z.object({ command: z.string() })

/** One read-only lookup for a completed call that named a reference. */
interface Lookup {
  /** Call whose shell execution world the lookup reuses. */
  readonly exec: Readonly<ToolExecution>
  readonly session: Session
  readonly command: string
  readonly cwd: string
  /** Rule set the call was read with, which also reads the lookup's output. */
  readonly rules: CommandRules
  /** Id of the rule whose lookup runs. */
  readonly rule: string
}

/**
 * Observe completed foreground Bash calls while tools and shell services exist.
 * Queries use the same shell service, cwd, managed environment, and standing
 * sandbox policy as the call. A call inside a program, which carries a
 * `parent` token, queues its query until the root call that encloses it
 * settles, so the query runs under that root call's cancellation after the
 * program's dispatch events are logged. Failed lookups leave bindings
 * unchanged and log a warning. Cancellation leaves bindings unchanged;
 * disposal aborts and awaits all queries. Replay performs no lookup.
 * @param ctx - owning plugin context.
 * @param timeoutMs - shell deadline for one read-only lookup.
 * @param rules - the current compiled command rules.
 * @param record - persists a confirmed URL without restoring dismissed bindings.
 */
export function observeReferences(
  ctx: Context,
  timeoutMs: number,
  rules: () => CommandRules,
  record: (session: Session, url: string) => void,
): void {
  ctx.inject(['tools', 'shell', 'shellEnv'], (scope) => {
    const lifetime = new AbortController()
    const tasks = new Set<Promise<void>>()
    /**
     * Lookups of settled program calls, keyed by the token of the call that
     * encloses them. The tools pipeline publishes `tools/result` for every
     * execution it completes, error and cancellation included, so an enclosing
     * call takes its entries when it settles; scope disposal drops the rest.
     */
    const queued = new Map<ToolExecutionToken, Lookup[]>()
    scope.effect(() => async () => {
      lifetime.abort()
      await Promise.allSettled(tasks)
    }, 'forge-session: stop reference lookups')
    scope.on('tools/result', (exec, result) => {
      const lookups = [...queued.get(exec.token) ?? [], ...prepare(exec, result)]
      queued.delete(exec.token)
      if (lookups.length === 0) return
      if (exec.parent !== undefined) {
        queued.set(exec.parent, [...queued.get(exec.parent) ?? [], ...lookups])
        return
      }
      const task = run(lookups, AbortSignal.any([lifetime.signal, exec.signal]))
      tasks.add(task)
      void task.then(() => tasks.delete(task))
    })

    /**
     * List the lookups one settled call needs, in command order: none unless
     * it is a completed foreground Bash call of an Agent whose output prints
     * no URL of its own change request.
     */
    function prepare(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): Lookup[] {
      if (exec.name !== 'bash' || exec.agent === undefined || result.isError) return []
      const argumentsResult = shellArguments.safeParse(exec.arguments)
      const shell = completedShell.safeParse(result.value)
      if (!argumentsResult.success || !shell.success) return []
      const printed = extractTextContent(result.content, { separator: '\n' })
      const current = rules()
      const { command } = argumentsResult.data
      const evidence = current.evidence(command)
      if (evidence === undefined || current.printed(printed, evidence).length > 0) return []
      const session = exec.agent.session
      return current.named(command).flatMap(entry => entry.lookup === null
        ? []
        : [{ exec, session, command: entry.lookup, cwd: shell.data.cwd, rules: current, rule: entry.rule }])
    }

    /** Run lookups in call order; a failed lookup is logged and does not stop the next one. */
    async function run(lookups: readonly Lookup[], signal: AbortSignal): Promise<void> {
      for (const lookup of lookups) {
        try {
          await resolve(lookup, signal)
        } catch (error: unknown) {
          if (signal.aborted) return
          const reason = error instanceof Error ? error.message : String(error)
          scope.logger.warn(`forge-session: change request reference lookup failed; use a full change request URL to bind it: ${reason}`)
        }
      }
    }

    async function resolve(lookup: Lookup, signal: AbortSignal): Promise<void> {
      signal.throwIfAborted()
      const spec = scope.shell.resolve({
        command: lookup.command,
        workdir: lookup.cwd,
        timeoutMs,
        signal,
        dshEnv: scope.shellEnv.collect(lookup.exec),
        sandboxPolicy: scope.get('sandboxPolicy')?.resolve({ session: lookup.session }),
      })
      const process = await scope.shell.execute(spec)
      const output = await process.result()
      signal.throwIfAborted()
      if (output.exitCode !== 0 || output.signal !== null || output.timedOut || output.aborted || output.stdout.truncated) {
        throw new Error(`the ${lookup.rule} lookup did not complete successfully`)
      }
      const url = lookup.rules.lookupUrl(output.stdout.text, lookup.rule)
      if (url === undefined) throw new Error(`the ${lookup.rule} lookup printed no change request URL`)
      record(lookup.session, url)
    }
  })
}
