import { clientShell } from '../tsdown.client.ts'

export default clientShell(
  import.meta.dirname,
  ['lib/types/index.js', 'lib/types/apply-injections.js'],
)
