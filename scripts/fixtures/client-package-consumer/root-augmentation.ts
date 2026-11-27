/**
 * Type compatibility commitment to external TypeScript consumers, two-file scenario: this file augments the package
 * root. [`two-file-assertions.ts`](two-file-assertions.ts) reads the result.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'consumer.root': { kind: 'single'; scope: 'root'; owner: { readonly label: string } }
  }
  interface GlobalStandardProps {
    rootSeat: () => string
  }
}
