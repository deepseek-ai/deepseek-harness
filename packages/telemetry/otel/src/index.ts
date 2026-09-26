/** Cordis entry for independent ordinary-event and Session-log OTLP channels. */
import { Context, Service } from '@deepseek-ai/cordis'
import { EventLogReporter, type EventLogOptions } from './event-log.ts'
import { SessionLogReporter, type SessionLogOptions } from './session-log.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    otel: OTel
  }
}

/** Shared transport provider. Mounting creates no queue, identity, or network connection. */
export default class OTel extends Service {
  constructor(ctx: Context) { super(ctx, 'otel') }

  /**
   * Create an independent ordinary-event channel with count-based batching.
   * The injected consumer must drain it during its fiber disposal.
   * @param options - transport, scope, resource, queue, and diagnostic settings selected by the consumer.
   * @returns the caller-owned channel; no state is shared with other channels.
   */
  createEventReporter(options: EventLogOptions): EventLogReporter { return new EventLogReporter(options) }

  /**
   * Create an independent byte-bounded Session-log channel.
   * Authorization and redaction precede reporting; the consumer owns shutdown and its outer deadline.
   * @param options - transport, scope, resource, queue, and diagnostic settings selected by the consumer.
   * @returns the caller-owned channel, preserving complete accepted events within the request byte ceiling.
   */
  createSessionLogReporter(options: SessionLogOptions): SessionLogReporter { return new SessionLogReporter(options) }
}

export type { EventLogOptions, OTelEventRecord, OTelEventScalar, EventLogReporter } from './event-log.ts'
export type { SessionLogRecord, SessionLogOptions, SessionLogReporter } from './session-log.ts'
