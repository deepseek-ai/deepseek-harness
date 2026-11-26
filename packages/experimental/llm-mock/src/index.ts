/**
 * Keyless mock model route: registers provider `mock` with one model `mock`, whose every call streams the
 * configured reply as one text block and stops. It makes no network request and reads no credential.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, StreamChunk } from '@deepseek-ai/dsh-llm'

export const name = 'llm-mock'
export const inject = ['llm']

const MOCK_PROVIDER = 'mock'
const MOCK_MODEL = 'mock'

/** Mock route settings. */
export interface Config {
  /** Text every model call returns. */
  reply: string
}
export const Config: z<Config> = z.object({
  reply: z.string().min(1).default('This is a mock model reply.').description('Text every model call returns.'),
})

/** Adapter that answers every call on the mock route with one fixed text block. */
class MockAdapter extends LlmAdapter {
  constructor(private readonly reply: string) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Mock' }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: MOCK_MODEL, name: 'Mock model', inputModalities: ['text'] }])
  }

  // oxlint-disable-next-line typescript/require-await -- the adapter contract is an AsyncIterable; the fixed reply needs no await
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: this.reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.reply } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * Register the mock route for this plugin's lifetime.
 * @param ctx - plugin context providing `llm`.
 * @param config - validated settings.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.llm.registerAdapter([MOCK_PROVIDER], new MockAdapter(config.reply))
}
