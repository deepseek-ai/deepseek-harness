/** Typed native fixture shared by CUA composition and recorded-session replay. */
import type { NativeChannelFactory } from '@deepseek-ai/dsh-cua/native-client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

export const png: string

/** @returns An isolated desktop substitute and its observable native requests. */
export function createNativeFixture(): {
  createChannel: NativeChannelFactory
  calls: Array<{ id: string; method: string; params: Record<string, JsonValue> }>
  events: string[]
  state: { count: number; openedChannels: number; closedChannels: number }
  /** @returns A barrier reached when the next click waits for native cancellation. */
  holdNextClick(): Promise<void>
}
