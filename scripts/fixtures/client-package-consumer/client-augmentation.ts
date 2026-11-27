/**
 * Type compatibility commitment to external TypeScript consumers, two-file scenario: this file augments the `/client`
 * subpath. [`two-file-assertions.ts`](two-file-assertions.ts) reads the result.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots/client'

declare module '@deepseek-ai/dsh-client-ui-slots/client' {
  interface SlotMap {
    'consumer.client': { kind: 'single'; scope: 'root'; owner: { readonly count: number } }
  }
  interface GlobalStandardProps {
    clientSeat: () => number
  }
}
