import { clientLibrary } from '../../client/tsdown.client.ts'

export default clientLibrary(
  import.meta.dirname,
  ['lib/types/index.js'],
)
