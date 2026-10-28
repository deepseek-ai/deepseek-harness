/** Create immutable Desktop release tags using the explicitly supplied GitHub App installation token. */
import { valid } from 'semver'
import { z } from 'zod'
import { desktopReleaseTag } from './desktop-release-tag.ts'

const refSchema = z.object({ object: z.object({ type: z.string(), sha: z.string().regex(/^[a-f0-9]{40}$/u) }) })

/**
 * Create a lightweight release tag, or verify that an existing tag names the same packaged commit.
 * @param repository Owner/name of the package source repository.
 * @param version Validated packaged version.
 * @param commit Actual packaged commit, never the publishing workflow checkout commit.
 * @param installationToken Explicit GitHub App token; no ambient authentication fallback is used.
 * @param request HTTP implementation; defaults to fetch, tests inject an isolated fake.
 * @returns Created or already-present status. Conflicts and unknown responses reject without updating a ref.
 */
export async function publishDesktopTag(
  repository: string, version: string, commit: string, installationToken: string,
  request: typeof fetch = fetch,
): Promise<'created' | 'present'> {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository) || valid(version) !== version || !/^[a-f0-9]{40}$/u.test(commit)) {
    throw new Error('desktop tag: invalid repository, version or packaged commit')
  }
  if (!installationToken.trim()) throw new Error('desktop tag: GitHub App installation token is required')
  const tag = desktopReleaseTag(version)
  const base = `https://api.github.com/repos/${repository}/git`
  const headers = { Authorization: `Bearer ${installationToken}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
  const get = () => request(`${base}/ref/tags/${encodeURIComponent(tag)}`, { headers, redirect: 'error', signal: AbortSignal.timeout(30_000) })
  const matches = async (response: Response) => {
    if (!response.ok) throw new Error(`desktop tag: cannot verify tag (HTTP ${response.status})`)
    const ref = refSchema.parse(await response.json())
    if (ref.object.type !== 'commit') throw new Error('desktop tag: existing ref is not a lightweight commit tag; inspect it manually, refusing to replace it')
    if (ref.object.sha !== commit) throw new Error('desktop tag: existing tag points to another commit; refusing to move it')
  }
  const existing = await get()
  if (existing.status !== 404) { await matches(existing); return 'present' }
  await existing.body?.cancel()
  const response = await request(`${base}/refs`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: `refs/tags/${tag}`, sha: commit }), redirect: 'error', signal: AbortSignal.timeout(30_000),
  })
  if (response.status === 201) { await matches(response); return 'created' }
  const requestId = response.headers.get('x-github-request-id')
  const identity = requestId !== null && /^[A-Fa-f0-9:]{1,128}$/u.test(requestId) ? `; GitHub request ${requestId}` : ''
  const failure = `desktop tag: creation failed (HTTP ${response.status}${identity})`
  // A 422 can reject repository rules as well as report a concurrent tag creation.
  if (response.status === 422) {
    let detail: unknown
    try { detail = await response.json() } catch (error) {
      // Non-JSON error responses still retain the original HTTP status and request ID.
    }
    const rulesRejected = typeof detail === 'object' && detail !== null && 'message' in detail
      && typeof detail.message === 'string' && detail.message.startsWith('Repository rule violations found')
    const guidance = rulesRejected ? 'repository rules rejected tag creation; inspect the matching tag rulesets'
      : 'inspect repository rule insights and App permissions before retrying'
    let reconciled: Response
    try { reconciled = await get() } catch (cause) {
      throw new Error(`${failure}; follow-up tag lookup failed; ${guidance}`, { cause })
    }
    if (!reconciled.ok) {
      await reconciled.body?.cancel()
      throw new Error(`${failure}; follow-up tag lookup returned HTTP ${reconciled.status}; ${guidance}`)
    }
    try { await matches(reconciled) } catch (cause) {
      throw new Error(`${failure}; follow-up tag verification failed; inspect the existing tag before retrying`, { cause })
    }
    return 'present'
  }
  await response.body?.cancel()
  throw new Error(`${failure}; reconcile the tag before retrying`)
}
