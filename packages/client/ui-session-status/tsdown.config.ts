import { clientBundle } from '../tsdown.client.ts'

export default clientBundle(import.meta.dirname, ['lib/types/index.js'], { hostPhase: true })
