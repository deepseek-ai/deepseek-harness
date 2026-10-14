import { clientBundle } from '../tsdown.client.ts'

export default clientBundle(
  import.meta.dirname,
  ['lib/types/index.js', 'lib/types/protocol.js'],
  { hostPhase: true },
)
