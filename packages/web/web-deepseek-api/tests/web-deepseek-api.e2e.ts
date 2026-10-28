import { describe, expect, it } from 'vitest'
import { DeepSeekFetchApiProvider, DeepSeekSearchApiProvider } from '@deepseek-ai/dsh-web-deepseek-api'

/** Real Search and Fetch API probes; the base names the deployment the key authenticates. */
const apiKey = process.env.DEEPSEEK_API_KEY
const baseURL = process.env.DEEPSEEK_SEARCH_API_TEST_BASE_URL ?? ''
const maybe = apiKey !== undefined && apiKey.length > 0 && baseURL.length > 0 ? describe : describe.skip

maybe('DeepSeek Search and Fetch real API', () => {
  it('returns citeable sources from the Search API', async () => {
    const provider = new DeepSeekSearchApiProvider(() => ({ apiKey: apiKey!, baseURL, count: 10 }))
    const result = await provider.search({ query: 'DeepSeek', maxResults: 3 }, AbortSignal.timeout(30_000))
    expect(result.sources.length).toBeGreaterThan(0)
    expect(result.sources.length).toBeLessThanOrEqual(3)
    for (const source of result.sources) expect(source.url).toMatch(/^https?:\/\//)
  }, 40_000)

  it('returns Markdown from the Fetch API', async () => {
    const provider = new DeepSeekFetchApiProvider(() => ({ apiKey: apiKey!, baseURL }))
    const result = await provider.fetch({ url: 'https://example.com' }, AbortSignal.timeout(30_000))
    expect(result.body.kind).toBe('text')
    expect(result.body.content.length).toBeGreaterThan(0)
    expect(result.statusCode).toBe(200)
  }, 40_000)
})
