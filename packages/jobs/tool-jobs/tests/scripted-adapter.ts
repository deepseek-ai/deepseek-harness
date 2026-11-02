/**
 * A narrow scripted `LlmAdapter` for this package's specs: each model call
 * consumes the next scripted stream, and every request is retained so a spec
 * can assert what the model saw.
 */
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

/** One scripted model call: fixed chunks, or a function of the request. */
export type ScriptedCall = readonly StreamChunk[] | ((options: GenerateOptions) => readonly StreamChunk[])

/** An adapter whose model calls follow a fixed script, recording each request. */
export class ScriptedAdapter extends LlmAdapter {
  /** Every request this adapter has served, in call order. */
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: ScriptedCall[]) {
    super()
  }

  /** Append calls once the runtime values they name (an opaque job id) are known. */
  push(...calls: ScriptedCall[]): void {
    this.script.push(...calls)
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const call = this.script.shift()
    if (call === undefined) throw new Error('scripted adapter exhausted')
    yield* typeof call === 'function' ? call(options) : call
  }
}
