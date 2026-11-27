/** An acknowledged document lease held until the test releases it. */
import type { OfficeLeaseStream } from '../../src/client/connection.ts'

/** @returns One live, acknowledged document lease. */
export function officeLease(): OfficeLeaseStream {
  const ended = Promise.withResolvers<undefined>()
  return {
    async *[Symbol.asyncIterator]() {
      yield { value: {}, accept() {} }
      await ended.promise
    },
    async dispose() { ended.resolve(undefined) },
  }
}
