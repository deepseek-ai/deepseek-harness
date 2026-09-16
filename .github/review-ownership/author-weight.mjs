/** Author credit from merged pull requests in the same repository. */
const CAP_COUNT = 150

/**
 * Convert merged PR count to author points, capped at 0.6.
 * @param {number} mergedCount Merged PR count.
 * @returns {number} Author approval points.
 */
export function authorCreditPoints(mergedCount) {
  return Math.min(CAP_COUNT, mergedCount) / 250
}

/**
 * Count merged PRs by immutable author account, stopping at the credit cap.
 * @param {{repository: string, number: number, authorId: string}} pull Current pull request.
 * @param {(path: string, options: object) => Promise<unknown>} api GitHub API caller.
 * @returns {Promise<number>} Merged count, capped at 150; incomplete responses reject.
 */
export async function countMergedAuthorPulls(pull, api) {
  const [owner, name] = pull.repository.split('/')
  const seen = new Set()
  const cursors = new Set()
  let after = null
  let count = 0
  do {
    const response = await api('/graphql', {
      method: 'POST',
      body: {
        query: `query($owner: String!, $name: String!, $after: String) {
          repository(owner: $owner, name: $name) {
            pullRequests(states: MERGED, first: 100, after: $after, orderBy: {field: CREATED_AT, direction: DESC}) {
              nodes { number author { ... on Node { id } } }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`,
        variables: { owner, name, after },
      },
    })
    const connection = response.data?.repository?.pullRequests
    if (response.errors?.length || !Array.isArray(connection?.nodes)
      || typeof connection.pageInfo?.hasNextPage !== 'boolean') {
      throw new Error('GitHub merged PR history is incomplete')
    }
    for (const entry of connection.nodes) {
      if (!Number.isSafeInteger(entry?.number) || entry.number <= 0
        || (entry.author !== null && typeof entry.author?.id !== 'string')) {
        throw new Error('GitHub returned an invalid merged PR')
      }
      if (seen.has(entry.number)) continue
      seen.add(entry.number)
      if (entry.number !== pull.number && entry.author?.id === pull.authorId) count++
      if (count === CAP_COUNT) return count
    }
    if (!connection.pageInfo.hasNextPage) return count
    after = connection.pageInfo.endCursor
    if (typeof after !== 'string' || !after || cursors.has(after)) {
      throw new Error('GitHub merged PR history cursor did not advance')
    }
    cursors.add(after)
  } while (true)
}
