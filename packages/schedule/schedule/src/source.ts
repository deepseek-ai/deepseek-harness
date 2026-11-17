/** Independently owned Sources compose through typed inputs and outputs. */
import { SourceError, SourceInput, SourceOutput } from '@deepseek-ai/dsh-schedule'
import type { SourceReceiver } from './source-types.ts'

export { SourceInput, SourceOutput, TimeSource } from '@deepseek-ai/dsh-schedule'

/** One source instance; subclasses own their producers, input processing, and output policy. */
export abstract class AutomationSource<T> {
  /** Output connected by downstream Sources or runtimes. */
  readonly output: SourceOutput<T> = new SourceOutput<T>()
  private readonly inputs = new Set<{ dispose(): Promise<void> }>()
  private closing: Promise<void> | undefined

  /**
   * Create an input owned by this Source; a composite can expose its bound connect function directly.
   * Its drain resolves after accepted calls settle; receiver failures remain with the send or broadcast.
   * @param receive - Accepts typed upstream values, possibly emitting derived output before it settles.
   * @returns The endpoint, owned until its drain completes and automatically drained before output closes.
   * @throws SourceError with SOURCE_CLOSED after this Source starts disposal.
   */
  protected createInput<Input>(receive: SourceReceiver<Input>): SourceInput<Input> {
    if (this.closing !== undefined) throw new SourceError('This source has been disposed.', 'SOURCE_CLOSED')
    const inputs = this.inputs
    const input = new class extends SourceInput<Input> {
      override dispose(): Promise<void> {
        const closed = super.dispose()
        void closed.then(() => { inputs.delete(this) })
        return closed
      }
    }(receive)
    inputs.add(input)
    return input
  }

  /**
   * Stop input admission and drain accepted inputs while output remains usable, then close and drain output.
   * Subclasses stop their producers before calling this method. Borrowed upstream Sources are not disposed.
   * A receiver must not await this Source's disposal from its own accepted call; cleanup waits for that call.
   */
  dispose(): Promise<void> {
    if (this.closing === undefined) {
      this.closing = this.inputs.size === 0
        ? this.output.dispose()
        : Promise.all([...this.inputs].map(input => input.dispose())).then(() => this.output.dispose())
    }
    return this.closing
  }

  /**
   * Broadcast through the output's directed connections; overlapping calls are not serialized.
   * @param value - Shared typed output; receivers must not mutate it.
   * @returns Resolves after every receiver accepts, or rejects with the output's aggregate failure.
   */
  protected emit(value: T): Promise<void> { return this.output.emit(value) }
}
