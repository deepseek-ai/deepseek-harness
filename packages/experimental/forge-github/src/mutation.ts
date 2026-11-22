/** GitHub GraphQL mutations sent once through `gh`, with the document and variables as JSON on standard input. */

import type { ForgeActionFailure } from '@deepseek-ai/dsh-experimental-forge'
import { z } from 'zod'
import { GhUnavailableError, type GhOutput, type GhRunner } from './gh.ts'

/** HTTP statuses that mean GitHub refused the request, so it changed nothing. */
const REFUSED = /\(HTTP (?:400|401|403|404|409|422)\)/

/**
 * GraphQL error types that mean GitHub refused a mutation before applying it. An error without one of them, such as
 * GitHub's "Something went wrong … may be the result of a timeout", leaves the outcome unknown.
 */
const REFUSALS: ReadonlySet<string> = new Set(['FORBIDDEN', 'INSUFFICIENT_SCOPES', 'NOT_FOUND', 'RATE_LIMITED', 'UNPROCESSABLE'])

const graphqlErrors = z.object({ errors: z.array(z.object({ message: z.string(), type: z.string().optional() })).min(1) })

/** One mutation and the payload field that holds its result. */
export interface GraphqlMutation {
  /** GraphQL document with one mutation field. */
  readonly query: string
  /** Name of the mutation field, which holds the payload once GitHub applied the mutation. */
  readonly field: string
  /** Variables of the document. */
  readonly variables: Readonly<Record<string, unknown>>
}

/**
 * A mutation's result: the payload once GitHub applied it; else `failed` when GitHub refused it or `gh` could not start,
 * so nothing changed, or `unknown` when the mutation may have been applied and must be checked on GitHub.
 */
export type MutationResult =
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly code: 'failed' | 'unknown'; readonly message: string }

/**
 * Runs one mutation on `host` through {@link sendMutation}; resolves to undefined once GitHub applied it, to a `failed`
 * action failure when GitHub refused it, or to an `unknown` one when GitHub did not confirm it.
 */
export type GraphqlWriter = (host: string, mutation: GraphqlMutation, signal: AbortSignal) => Promise<ForgeActionFailure | undefined>

/**
 * Send one mutation with its query and variables as JSON on stdin. The mutation is never retried.
 * @param gh - runs `gh` on the Host.
 * @param host - GitHub host the mutation goes to.
 * @param mutation - the document, its field, and its variables.
 * @param signal - cancellation of the request.
 * @returns the payload of `mutation.field`; `failed` when GitHub reports a refusal by its HTTP status or GraphQL error
 * type, or `gh` cannot start, else `unknown`.
 */
export async function sendMutation(gh: GhRunner, host: string, mutation: GraphqlMutation, signal: AbortSignal): Promise<MutationResult> {
  let output: GhOutput
  try {
    output = await gh(['api', 'graphql', '--hostname', host, '--input', '-'], signal,
      JSON.stringify({ query: mutation.query, variables: mutation.variables }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, code: error instanceof GhUnavailableError ? 'failed' : 'unknown', message }
  }
  const body = parse(output.stdout)
  // A payload means GitHub applied the mutation, even beside errors about the fields it selects.
  const payload = z.object({ data: z.record(z.string(), z.unknown()) }).safeParse(body)
  const value = payload.success ? payload.data.data[mutation.field] : undefined
  if (value !== undefined && value !== null) return { ok: true, payload: value }
  const errors = graphqlErrors.safeParse(body)
  if (errors.success) {
    const refused = errors.data.errors.every(error => error.type !== undefined && REFUSALS.has(error.type))
    return { ok: false, code: refused ? 'failed' : 'unknown', message: errors.data.errors.map(error => error.message).join('; ') }
  }
  if (output.exitCode !== 0) {
    const message = output.stderr.trim() || output.stdout.trim() || `gh exited with ${output.exitCode}`
    return { ok: false, code: REFUSED.test(output.stderr) ? 'failed' : 'unknown', message }
  }
  return { ok: false, code: 'unknown', message: `unexpected GitHub response to ${mutation.field}` }
}

function parse(text: string): unknown {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    void error // gh prints diagnostics instead of JSON when a request fails before GitHub answers.
    return undefined
  }
  return value
}
