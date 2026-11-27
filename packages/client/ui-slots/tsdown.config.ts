import { clientBundle } from '../tsdown.client.ts'

// The Host entry is hand-written JavaScript, so tsc emits nothing for it under lib/types.
export default clientBundle(
  import.meta.dirname,
  ['src/index.js'],
)
