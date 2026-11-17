/** Host face of the synced configuration types package; the types live in `./types` and no Host behavior exists. */
export type * from './types.ts'

/** Register nothing on the Host. */
export function apply(): void {}
