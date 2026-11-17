/** GitLab REST and GraphQL reads and writes through `glab api`, with failures mapped to forge codes. */

import type { ForgeActionFailure, ForgeFailure } from '@deepseek-ai/dsh-experimental-forge'
import { z } from 'zod'
import { GlabOutputLimitError, GlabTimeoutError, GlabUnavailableError } from './glab.ts'
import type { GlabOutput, GlabRunner } from './glab.ts'

/** A parsed JSON answer, or why GitLab did not give one. */
export type ApiResult = { readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly failure: ForgeFailure }

/**
 * The answer to a write: its parsed body once GitLab accepted it, else the HTTP status GitLab answered with, if any,
 * the body it answered with, and the failure.
 */
export type WriteResult =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly status: number | null; readonly body: unknown; readonly failure: ForgeActionFailure }

/** A GraphQL mutation's payload once GitLab applied it. */
export type MutationResult = { readonly ok: true; readonly payload: Readonly<Record<string, unknown>> } | ForgeActionFailure

const graphqlAnswer = z.object({
  data: z.record(z.string(), z.unknown()).nullable().optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
})

/** Status code `glab api` appends to the message of a failed request. */
const HTTP_STATUS = /\(HTTP (\d{3})\)/

/** What `glab` prints for a host it has no credentials for, or GitLab for rejected credentials. */
const AUTHENTICATION = /\bUnauthenticated\b|glab auth login|401 Unauthorized|\(HTTP 401\)|invalid_token/i

/** GraphQL refusals of a query over GitLab's complexity or size limits, which a smaller query avoids. */
export const QUERY_LIMIT = /exceeds max complexity|Query too large|exceeds max depth/i

/**
 * Reads and writes one GitLab host through a `glab` runner. Every request names its host, so `glab` never infers one
 * from a checkout or the environment.
 */
export class GitLabApi {
  /**
   * @param glab - runner that executes `glab` on the host.
   */
  constructor(private readonly glab: GlabRunner) {}

  /**
   * Read a REST resource as JSON.
   * @param host - GitLab host.
   * @param path - API path below `/api/v4/`, with its query.
   * @param signal - cancellation of the read.
   * @returns the parsed answer, or the mapped failure.
   */
  async rest(host: string, path: string, signal: AbortSignal): Promise<ApiResult> {
    const output = await this.attempt(['api', '--hostname', host, path], signal)
    return 'code' in output ? { ok: false, failure: output } : parsed(output)
  }

  /**
   * Read one page of a REST list with GitLab's `X-Total` count of all its entries.
   * @param host - GitLab host.
   * @param path - API path below `/api/v4/`, with its query.
   * @param signal - cancellation of the read.
   * @returns the parsed page and the total, which is null when GitLab omits it, or the mapped failure.
   */
  async restPage(host: string, path: string, signal: AbortSignal): Promise<ApiResult & { readonly total?: number | null }> {
    const output = await this.attempt(['api', '-i', '--hostname', host, path], signal)
    if ('code' in output) return { ok: false, failure: output }
    if (output.exitCode !== 0) return { ok: false, failure: failureOf(output) }
    const split = /\r?\n\r?\n/.exec(output.stdout)
    const headers = split === null ? '' : output.stdout.slice(0, split.index)
    const total = /^x-total:\s*(\d+)\s*$/im.exec(headers)?.[1]
    const page = parsed({ ...output, stdout: split === null ? output.stdout : output.stdout.slice(split.index + split[0].length) })
    return page.ok ? { ...page, total: total === undefined ? null : Number(total) } : page
  }

  /**
   * Read a REST resource as text, such as a raw file.
   * @param host - GitLab host.
   * @param path - API path below `/api/v4/`, with its query.
   * @param signal - cancellation of the read.
   * @returns the text, or the mapped failure.
   */
  async restText(host: string, path: string, signal: AbortSignal): Promise<string | ForgeFailure> {
    const output = await this.attempt(['api', '--hostname', host, path], signal)
    if ('code' in output) return output
    return output.exitCode === 0 ? output.stdout : failureOf(output)
  }

  /**
   * Run a GraphQL query whose document and variables travel as JSON on stdin.
   * @param host - GitLab host.
   * @param query - GraphQL document.
   * @param variables - query variables.
   * @param signal - cancellation of the read.
   * @returns the `data` object when GitLab reported no error, else the mapped failure; a query over GitLab's
   * complexity or size limits fails as `too-large`.
   */
  async graphql(host: string, query: string, variables: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<ApiResult> {
    const output = await this.attempt(
      ['api', 'graphql', '--hostname', host, '--input', '-', '-H', 'Content-Type: application/json'], signal, JSON.stringify({ query, variables }),
    )
    if ('code' in output) return { ok: false, failure: output }
    const body = json(output.stdout)
    const errors = graphqlErrors(body)
    if (errors.length > 0) {
      const message = errors.join('; ')
      return { ok: false, failure: { code: QUERY_LIMIT.test(message) ? 'too-large' : AUTHENTICATION.test(message) ? 'unauthenticated' : 'unavailable', message } }
    }
    if (output.exitCode !== 0) return { ok: false, failure: failureOf(output) }
    const data = typeof body === 'object' && body !== null && 'data' in body ? body.data : undefined
    return typeof data === 'object' && data !== null
      ? { ok: true, body: data } : { ok: false, failure: { code: 'unavailable', message: 'GitLab returned no GraphQL data' } }
  }

  /**
   * Send one REST or GraphQL write once, without retrying.
   * @param host - GitLab host.
   * @param args - `glab api` arguments after `--hostname <host>`, such as `-X PUT <path>`.
   * @param signal - cancellation of the write.
   * @param input - request body for `--input -`, when the write takes one.
   * @returns the parsed answer of an accepted write, or why GitLab did not accept it: HTTP 401 or a diagnostic about
   * credentials is `unauthenticated`, any other 4xx status is a refusal that changed nothing, `failed`, as is a `glab`
   * that cannot start; a 5xx status, an answer without a status, and a run past `timeoutMs` or the output limit are
   * `unknown`, since GitLab may have applied the write.
   */
  async write(host: string, args: readonly string[], signal: AbortSignal, input?: string): Promise<WriteResult> {
    let output: GlabOutput
    try {
      output = await this.glab(['api', '--hostname', host, ...args], signal, input)
    } catch (error) {
      if (signal.aborted) throw signal.reason
      // A write that outlived its deadline or its output limit may have been applied.
      if (error instanceof GlabTimeoutError || error instanceof GlabOutputLimitError) {
        return { ok: false, status: null, body: undefined, failure: { code: 'unknown', message: error.message } }
      }
      if (error instanceof GlabUnavailableError) return { ok: false, status: null, body: undefined, failure: { code: 'failed', message: error.message } }
      throw error
    }
    const body = json(output.stdout)
    if (output.exitCode === 0) return { ok: true, body }
    const { message } = failureOf(output)
    const matched = HTTP_STATUS.exec(output.stderr)?.[1]
    const status = matched === undefined ? null : Number(matched)
    const code = status === 401 || (status === null && AUTHENTICATION.test(output.stderr)) ? 'unauthenticated'
      : status !== null && status < 500 ? 'failed' : 'unknown'
    return { ok: false, status, body, failure: { code, message } }
  }

  /**
   * Run one GraphQL mutation once, with its document and variables as JSON on stdin.
   * @param host - GitLab host.
   * @param query - GraphQL document with one mutation field.
   * @param variables - mutation variables.
   * @param field - the mutation field, whose payload holds the mutation's `errors`.
   * @param signal - cancellation of the write.
   * @returns the payload once GitLab applied the mutation; `failed` when the payload lists errors or GitLab answered with
   * GraphQL errors and no payload, which GitLab does for a refusal; otherwise the failure of the write, or `unknown`.
   */
  async mutate(
    host: string, query: string, variables: Readonly<Record<string, unknown>>, field: string, signal: AbortSignal,
  ): Promise<MutationResult> {
    const written = await this.write(host, ['graphql', '--input', '-', '-H', 'Content-Type: application/json'], signal,
      JSON.stringify({ query, variables }))
    const answer = graphqlAnswer.safeParse(written.body)
    const payload = z.record(z.string(), z.unknown()).safeParse(answer.data?.data?.[field])
    if (payload.success) {
      const errors = z.object({ errors: z.array(z.string()) }).safeParse(payload.data)
      if (errors.success && errors.data.errors.length > 0) return { code: 'failed', message: errors.data.errors.join('; ') }
      if (written.ok) return { ok: true, payload: payload.data }
    }
    const messages = answer.data?.errors?.map(error => error.message) ?? []
    if (messages.length > 0) {
      const message = messages.join('; ')
      return { code: AUTHENTICATION.test(message) ? 'unauthenticated' : 'failed', message }
    }
    return written.ok ? { code: 'unknown', message: `unexpected GitLab response to ${field}` } : written.failure
  }

  /** Run `glab`, mapping a runner that cannot finish to a failure. */
  private async attempt(args: readonly string[], signal: AbortSignal, input?: string): Promise<GlabOutput | ForgeFailure> {
    try {
      return await this.glab(args, signal, input)
    } catch (error) {
      if (signal.aborted) throw signal.reason
      if (error instanceof GlabOutputLimitError) return { code: 'too-large', message: error.message }
      if (error instanceof GlabUnavailableError || error instanceof GlabTimeoutError) return { code: 'unavailable', message: error.message }
      throw error
    }
  }
}

/** Parse the output of a request that may have failed. */
function parsed(output: GlabOutput): ApiResult {
  if (output.exitCode !== 0) return { ok: false, failure: failureOf(output) }
  const body = json(output.stdout)
  return body === undefined ? { ok: false, failure: { code: 'unavailable', message: 'GitLab returned output that is not JSON' } } : { ok: true, body }
}

/**
 * Map a failed `glab api` run to a forge failure: HTTP 404 is `not-found`, a diagnostic about credentials or HTTP 401
 * is `unauthenticated`, HTTP 406 and 413 are `too-large`, and anything else is `unavailable` with GitLab's message.
 * @param output - the failed run.
 * @returns the failure.
 */
export function failureOf(output: GlabOutput): ForgeFailure {
  const message = lastLine(output.stderr) ?? lastLine(output.stdout) ?? `glab exited with status ${output.exitCode}`
  const status = HTTP_STATUS.exec(output.stderr)?.[1]
  if (status === '404') return { code: 'not-found', message }
  if (AUTHENTICATION.test(output.stderr) || status === '401') return { code: 'unauthenticated', message }
  if (status === '406' || status === '413') return { code: 'too-large', message }
  return { code: 'unavailable', message }
}

/** Parse JSON output, or undefined when it is not JSON. */
function json(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch (error) {
    void error // Output that is not JSON is reported by the caller.
    return undefined
  }
}

/** The messages of a GraphQL answer's `errors`, empty when it has none. */
function graphqlErrors(body: unknown): string[] {
  if (typeof body !== 'object' || body === null || !('errors' in body) || !Array.isArray(body.errors)) return []
  return body.errors.map((error: unknown) => typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
    ? error.message : 'GitLab reported a GraphQL error')
}

/** The last non-empty line of a stream, without the `glab:` prefix and decoration. */
function lastLine(text: string): string | undefined {
  const lines = text.split('\n').map(line => line.replace(/^\s*(?:glab:|ERROR)\s*/, '').trim()).filter(line => line.length > 0)
  return lines.at(-1)
}
