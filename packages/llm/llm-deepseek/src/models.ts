/** Default DeepSeek model catalog. */
import type { DeepSeekCatalogModel } from './types.ts'

/** Context window of both official models, as the official `/models` listing declares it. */
const OFFICIAL_CONTEXT_WINDOW = 1_048_576

/** Advisory official model entries; deployments may replace the catalog. */
export const DEFAULT_MODELS: DeepSeekCatalogModel[] = [
  {
    id: 'deepseek-flash',
    name: 'DeepSeek-V4.1-Flash',
    contextWindow: OFFICIAL_CONTEXT_WINDOW,
    inputModalities: ['text', 'image'],
    systemPromptUpdate: 'in-history',
    toolUpdate: 'addition-only',
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek-V4-Pro',
    description: 'Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost.',
    contextWindow: OFFICIAL_CONTEXT_WINDOW,
  },
]
