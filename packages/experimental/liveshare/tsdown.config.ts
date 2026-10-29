import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  import.meta.dirname,
  [
    'lib/types/index.js',
    'lib/types/viewer-declarations.js',
    'lib/types/owner-gateway/cli.js',
  ],
  { hostPhase: true },
)
