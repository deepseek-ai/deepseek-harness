import assert from 'node:assert/strict'
import { isAbsolute, join } from 'node:path'

// The Actions runner exports RUNNER_TOOL_CACHE after step env. Run inside the
// setup-node process so version installs use runner temp rather than shared state.
const temp = process.env.RUNNER_TEMP
assert(temp && isAbsolute(temp), 'Node compatibility setup requires an absolute RUNNER_TEMP')
process.env.RUNNER_TOOL_CACHE = join(temp, 'node-compat-toolcache')
