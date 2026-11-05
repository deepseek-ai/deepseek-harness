/** Fetch optional popularity counts separately from immutable package metadata. */
import type { MarketSortKeyDeclaration } from '@deepseek-ai/dsh-plugin-market-index'
import { PUBLIC_NPM_REGISTRY, type FetchLimits } from './fetchers.ts'
import type { GeneratedEntry } from './generate.ts'

/** Declarations for the standardized metric definitions. */
export const METRIC_DECLARATIONS = {
  github_stars: { title: { en: 'GitHub stars', zh: 'GitHub 星标数' }, order: 'desc' },
  npm_weekly_downloads: { title: { en: 'npm weekly downloads', zh: 'npm 周下载量' }, order: 'desc' },
} satisfies Record<string, MarketSortKeyDeclaration>

/**
 * Create a per-run reader that shares requests for the same repository or package.
 * @param limits - deadline for each metric request.
 * @param registry - the registry used to discover npm packages; only public npm supplies downloads.
 * @param warn - reports unavailable metrics without failing package discovery.
 * @param githubToken - nonblank GitHub API token; absent skips GitHub star requests.
 * @returns an entry reader; failed or invalid counts are omitted, including on repeated runs.
 */
export function metricReader(
  limits: FetchLimits, registry: string, warn: (message: string) => void, githubToken?: string,
): (entry: GeneratedEntry) => Promise<GeneratedEntry> {
  const requests = new Map<string, Promise<number | undefined>>()
  async function count(url: string, field: string): Promise<number | undefined> {
    const authenticated = githubToken !== undefined && new URL(url).origin === 'https://api.github.com'
    let response: Response | undefined
    let value: unknown
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(limits.timeoutMs),
        ...authenticated ? { headers: { Authorization: `Bearer ${githubToken}` } } : {},
      })
      if (!response.ok) {
        await response.body?.cancel()
        warn(`${url}: HTTP ${response.status}; metric omitted`)
        return undefined
      }
      value = await response.json()
    } catch (error) {
      const reason = authenticated ? 'GitHub metric request failed' : String(error)
      warn(`${url}: ${response === undefined ? '' : `HTTP ${response.status}; `}${reason}; metric omitted`)
      return undefined
    }
    const result = typeof value === 'object' && value !== null && field in value ? (value as Record<string, unknown>)[field] : undefined
    if (typeof result === 'number' && Number.isSafeInteger(result) && result >= 0) return result
    warn(`${url}: ${field} must be a non-negative safe integer; metric omitted`)
    return undefined
  }
  function shared(url: string, field: string): Promise<number | undefined> {
    let request = requests.get(url)
    if (request === undefined) {
      request = count(url, field)
      requests.set(url, request)
    }
    return request
  }
  return async (entry) => {
    const sortKeys: Record<string, number> = {}
    const source = entry.versions[0]?.source
    const repositoryUrl = source?.type === 'git' ? source.url : entry.repository?.url
    const repository = repositoryUrl === undefined ? undefined : new URL(repositoryUrl)
    const match = repository?.hostname === 'github.com' ? /^\/([^/]+)\/([^/]+?)\/?$/u.exec(repository.pathname) : null
    if (githubToken !== undefined && match !== null) {
      const stars = await shared(`https://api.github.com/repos/${match[1]}/${match[2]?.replace(/\.git$/u, '')}`, 'stargazers_count')
      if (stars !== undefined) sortKeys.github_stars = stars
    }
    // Private registries can publish unrelated packages under a public npm name.
    if (registry === PUBLIC_NPM_REGISTRY && entry.versions.some(({ source }) => source.type === 'npm')) {
      const downloads = await shared(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(entry.name)}`, 'downloads')
      if (downloads !== undefined) sortKeys.npm_weekly_downloads = downloads
    }
    return Object.keys(sortKeys).length === 0 ? entry : { ...entry, metadata: { ...entry.metadata, sortKeys } }
  }
}
