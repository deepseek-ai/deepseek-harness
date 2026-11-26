import { readFileSync } from 'node:fs'

import { evaluateApproval } from './check-approval.mjs'

const policySource = readFileSync(new URL('approval-policy.json', import.meta.url), 'utf8')

export const HEAD_SHA = '1234567890abcdef1234567890abcdef12345678'
export const PUBLISHER = { id: 359_032_549, login: 'deepseek-ai-harness' }

const accountIds = new Map()

/**
 * Return the fixture account ID for a login.
 * @param {string} login GitHub login.
 * @returns {number} Pinned machine-user ID or a deterministic fixture ID.
 */
const accountId = login => {
  const key = login.toLowerCase()
  if (key === PUBLISHER.login) return PUBLISHER.id
  if (!accountIds.has(key)) accountIds.set(key, 1_000 + accountIds.size)
  return accountIds.get(key)
}

/**
 * Build a user record with the fixture account ID.
 * @param {string} login GitHub login.
 * @returns {{login: string, id: number}} User record.
 */
export const accountUser = login => ({ login, id: accountId(login) })

/**
 * Build a pull-request event for approval tests.
 * @param {{author?: string, draft?: boolean}} [options] Event overrides.
 * @returns {object} Pull-request event.
 */
export const pullRequestEvent = ({ author = 'author', draft = false } = {}) => ({
  repository: { full_name: 'deepseek-harness/deepseek-harness' },
  pull_request: {
    number: 42,
    state: 'open',
    draft,
    user: { login: author, node_id: 'author-id' },
    head: { sha: HEAD_SHA },
  },
})

/**
 * Build a conversation comment with stable identity fields.
 * @param {string} login Comment author login.
 * @param {string} body Comment body.
 * @param {string} [created_at] Creation timestamp.
 * @param {number} [id] Comment ID.
 * @returns {object} Comment record.
 */
export const comment = (login, body, created_at = '2026-09-15T00:00:00Z', id = 1) => ({
  user: { ...accountUser(login), node_id: `account:${login.toLowerCase()}` },
  body, created_at, id, node_id: `comment:${login}:${id}:${body}:${created_at}`,
})

/**
 * Build an API double for delegation scoring and pilot publication tests.
 * @param {{comments?: object[], reviews?: object[], permissions?: Record<string, string>}} [options] Fixture records.
 * @returns {(path: string, options?: {method?: string, body?: unknown}) => Promise<unknown>} API caller.
 */
export function delegationApi({ comments = [], reviews = [], permissions = {} } = {}) {
  return async (path, options = {}) => {
    if (path === '/user') return { ...PUBLISHER }
    if (path === '/graphql') return { data: { nodes: options.body.variables.ids.map(id => {
      const entry = comments.find(comment => comment.node_id === id)
      return { id, body: entry.body, createdAt: entry.created_at, author: { id: entry.user.node_id }, lastEditedAt: null, editor: null,
        ...entry.editorMetadata }
    }) } }
    if (path.includes('/comments?')) return comments
    if (path.includes('/reviews?')) return reviews
    const match = /\/collaborators\/([^/]+)\/permission$/u.exec(path)
    if (match) return { permission: permissions[decodeURIComponent(match[1]).toLowerCase()] ?? 'write' }
    if (path.endsWith('/issues/42/comments') && options.method === 'POST') return { id: 100 }
    if (path.includes('/issues/comments/')) return {}
    if (path.endsWith('/pulls/42')) return pullRequestEvent().pull_request
    if (path.endsWith('/pulls/42/reviews') && options.method === 'POST') {
      return { id: 200, state: 'APPROVED', commit_id: HEAD_SHA, user: accountUser(PUBLISHER.login) }
    }
    throw new Error(`unexpected API path ${path}`)
  }
}

/**
 * Evaluate approval through the shared scorer with delegation defaults.
 * @param {object} options Evaluation overrides.
 * @returns {Promise<object>} Approval result.
 */
export const evaluateDelegation = options => evaluateApproval({
  event: pullRequestEvent(), policySource,
  getMergedCount: async () => 0,
  getOwnership: async () => ({ totalLines: 0, reviewerLines: {} }),
  ...options,
})
