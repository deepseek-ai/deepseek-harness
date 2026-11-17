import type { ChangeRequestRef, ForgeRepository } from '@deepseek-ai/dsh-experimental-forge'
import type { GlabOutput, GlabRunner } from '../src/glab.ts'

/** Host the provider tests serve. */
export const HOST = 'gitlab.example.test'

/** Project in a nested group on {@link HOST}. */
export const app: ForgeRepository = { forge: 'gitlab', host: HOST, owner: 'group/sub', name: 'app' }

/** REST path prefix of merge request `number` in {@link app}. */
export function mrPath(number: number): string {
  return `projects/group%2Fsub%2Fapp/merge_requests/${number}`
}

/** Build a merge request reference in `app` or another project. */
export function merge(number: number, repository: ForgeRepository = app): ChangeRequestRef {
  return { repository, number }
}

/** A full commit object name made of one repeated hexadecimal digit. */
export function sha(digit: string): string {
  return digit.repeat(40)
}

/** One `glab` run that ended with `exitCode`. */
export function output(stdout: string, exitCode = 0, stderr = ''): GlabOutput {
  return { exitCode, stdout, stderr }
}

/** JSON output of a successful run. */
export function json(body: unknown): GlabOutput {
  return output(JSON.stringify(body))
}

/** One recorded `glab` call. */
export interface GlabCall {
  readonly args: readonly string[]
  readonly input: string | undefined
}

/**
 * A scripted `glab` that answers each call through `answer`, keyed by the request path, the last argument that is not
 * a flag or a flag value, and records every call.
 */
export function fakeGlab(
  answer: (path: string, call: GlabCall) => GlabOutput | Promise<GlabOutput>,
): { readonly run: GlabRunner; readonly calls: GlabCall[] } {
  const calls: GlabCall[] = []
  const run: GlabRunner = async (args, _signal, input) => {
    const call = { args, input }
    calls.push(call)
    return await answer(pathOf(args), call)
  }
  return { run, calls }
}

/** The request path of `glab api` arguments: `graphql`, or the REST path. */
export function pathOf(args: readonly string[]): string {
  const valued = new Set(['--hostname', '--input', '-H', '-X', '-f', '-F'])
  const positional: string[] = []
  for (let index = 1; index < args.length; index++) {
    const arg = args[index] ?? ''
    if (valued.has(arg)) index++
    else if (!arg.startsWith('-')) positional.push(arg)
  }
  return positional.at(-1) ?? ''
}

/** The parsed JSON body a call sent on stdin. */
export function sent(call: GlabCall | undefined): { readonly query: string; readonly variables: Record<string, unknown> } {
  return JSON.parse(call?.input ?? '{}') as { readonly query: string; readonly variables: Record<string, unknown> }
}
