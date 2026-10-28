/** GitHub review writes with commit checks and explicit treatment of uncertain outcomes. */

import { z } from 'zod'
import type { ChangeRequestRef, ForgeLineComment, ForgeReviewRequest, ForgeReviewResult } from '@deepseek-ai/dsh-experimental-forge'
import { GhUnavailableError, type GhOutput, type GhRunner } from './gh.ts'
import { checkedRepository } from './urls.ts'

const pull = z.object({ head: z.object({ sha: z.string() }), state: z.string() })
const receipt = z.object({ html_url: z.url() })
const EVENTS = { comment: 'COMMENT', approve: 'APPROVE', 'request-changes': 'REQUEST_CHANGES' } as const

function inline(comment: ForgeLineComment): object {
  const side = comment.side === 'L' ? 'LEFT' : 'RIGHT'
  return { path: comment.path, side, line: comment.endLine, body: comment.body,
    ...comment.startLine === comment.endLine ? {} : { start_line: comment.startLine, start_side: side } }
}

function failed(output: GhOutput, write: boolean): ForgeReviewResult {
  const known = /\(HTTP (?:400|401|403|404|409|422)\)/.test(output.stderr)
  return { ok: false, code: write && !known ? 'unknown' : 'failed', message: output.stderr.trim() || output.stdout.trim() || 'GitHub request failed' }
}

/**
 * Send one review mutation using JSON on stdin, never shell or argument interpolation.
 * @param gh - bounded, cancellable GitHub CLI runner.
 * @param ref - validated pull request address.
 * @param request - frozen commit and comment ranges.
 * @param signal - cancellation of preflight and mutation.
 * @returns a confirmed receipt, refusal, stale commit, or uncertain outcome; never retries a write.
 */
export async function submitGitHubReview(
  gh: GhRunner, ref: ChangeRequestRef, request: ForgeReviewRequest, signal: AbortSignal,
): Promise<ForgeReviewResult> {
  const { host, owner, name } = checkedRepository(ref)
  const endpoint = `repos/${owner}/${name}/pulls/${ref.number}`
  let writing = false
  try {
    const read = await gh(['api', '--hostname', host, endpoint], signal)
    if (read.exitCode !== 0) return failed(read, false)
    const current = pull.parse(JSON.parse(read.stdout))
    if (current.head.sha !== request.headSha) return { ok: false, code: 'stale', message: 'The pull request head has changed' }
    if (current.state !== 'open') return { ok: false, code: 'failed', message: 'The pull request is not open' }
    signal.throwIfAborted()
    const body = request.kind === 'comment'
      ? { commit_id: request.headSha, ...inline(request.comment) }
      : { commit_id: request.headSha, event: EVENTS[request.event], body: request.body, comments: request.comments.map(inline) }
    writing = true
    const output = await gh(['api', '--hostname', host, '--method', 'POST', `${endpoint}/${request.kind === 'comment' ? 'comments' : 'reviews'}`, '--input', '-'], signal, JSON.stringify(body))
    if (output.exitCode !== 0) return failed(output, true)
    const result = receipt.parse(JSON.parse(output.stdout))
    const url = new URL(result.html_url)
    if (url.protocol !== 'https:' || url.host !== host) throw new Error('GitHub returned an invalid review URL')
    return { ok: true, url: result.html_url }
  } catch (error) {
    if (!writing && signal.aborted) throw signal.reason
    return { ok: false, code: writing && !(error instanceof GhUnavailableError) ? 'unknown' : 'failed',
      message: error instanceof Error ? error.message : String(error) }
  }
}
