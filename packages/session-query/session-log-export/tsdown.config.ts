import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@deepseek-ai/dsh-session-log-export',
  ['lib/types/index.js'],
  { hostPhase: true },
)
