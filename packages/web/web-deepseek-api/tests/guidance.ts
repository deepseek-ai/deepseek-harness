/** Endpoint guidance values for provider tests that construct a provider or a request directly. */
import type { DeepSeekWebGuidance } from '../src/transport.ts'

/**
 * Guidance of an operation whose capability uses its own base URL and key.
 * @param capability - the capability whose endpoint the guidance names.
 * @returns the guidance fields.
 */
export function customGuidance(capability: 'search' | 'fetch'): DeepSeekWebGuidance {
  return {
    subject: capability === 'search' ? 'Search' : 'Fetch', plugin: 'web-deepseek-api', custom: true,
    baseURLField: `${capability}BaseURL`, apiKeyEnvField: `${capability}ApiKeyEnv`,
  }
}
