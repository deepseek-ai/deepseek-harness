import { staticLinked } from '../tsdown.client.ts'

export default staticLinked(
  import.meta.dirname,
  ['lib/types/index.js', 'lib/types/apply-injections.js'],
)
