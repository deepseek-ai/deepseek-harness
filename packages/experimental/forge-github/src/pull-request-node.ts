/** The node id of a pull request that a GraphQL mutation names, read together with the head the write must still find. */

import type { ChangeRequestRef, ForgeActionFailure } from '@deepseek-ai/dsh-experimental-forge'
import { z } from 'zod'
import type { GraphqlReader } from './commits.ts'
import { checkedRepository } from './urls.ts'

/** Node id and head commit of one pull request; variables `owner` and `name` are strings, `number` is an integer. */
export const PULL_REQUEST_NODE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id headRefOid } }
}`

const nodeSchema = z.object({
  data: z.object({ repository: z.object({ pullRequest: z.object({ id: z.string(), headRefOid: z.string() }).nullable() }).nullable() }),
})

/**
 * Read a pull request's node id before a write, refusing once its head is not `headSha`.
 * @param read - runs one GraphQL query.
 * @param ref - pull request address.
 * @param headSha - head commit the write must still find, or null for a write that does not depend on the head.
 * @param signal - cancellation of the read.
 * @returns the node id, `stale` when the head moved, or why the write must not proceed.
 */
export async function pullRequestNode(
  read: GraphqlReader, ref: ChangeRequestRef, headSha: string | null, signal: AbortSignal,
): Promise<string | ForgeActionFailure> {
  const { host, owner, name } = checkedRepository(ref)
  const node = await read([
    'api', 'graphql', '--hostname', host, '-f', `query=${PULL_REQUEST_NODE_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`,
    '-F', `number=${ref.number}`,
  ], signal)
  if (!node.ok) return { code: node.failure.code === 'unauthenticated' ? 'unauthenticated' : 'failed', message: node.failure.message }
  const parsed = nodeSchema.safeParse(node.body)
  if (!parsed.success) return { code: 'failed', message: 'unexpected GitHub response to the pull request read' }
  const pull = parsed.data.data.repository?.pullRequest
  if (pull == null) return { code: 'failed', message: `pull request ${ref.number} was not found` }
  if (headSha !== null && pull.headRefOid.toLowerCase() !== headSha.toLowerCase()) {
    return { code: 'stale', message: `the pull request head moved from ${headSha} to ${pull.headRefOid}` }
  }
  return pull.id
}
