#!/usr/bin/env node
/** Private entry owned by the Python single-file runtime packaging. */
import { fileURLToPath } from 'node:url'

const selectorName = 'DSH_SUBPROCESS_RUNNER'
const selection = process.env[selectorName]
const aclRunner = process.platform === 'win32'
  ? fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner'))
  : undefined

if (aclRunner !== undefined && process.argv[2] === aclRunner) {
  process.argv.splice(1, 1)
  await import('@deepseek-ai/dsh-sandbox-windows-acl/runner')
} else if (process.env.DSH_PTC_RUNTIME_NODE === '1') {
  Reflect.deleteProperty(process.env, 'DSH_PTC_RUNTIME_NODE')
  await import('@deepseek-ai/dsh-ptc-runtime-node/process')
} else if (selection === undefined) {
  const { runCli } = await import('@deepseek-ai/dsh/lib/bin.js')
  await runCli()
} else {
  Reflect.deleteProperty(process.env, selectorName)
  const { runSelectedSubprocessRunner } = await import('@deepseek-ai/dsh-subprocess-local/runner')
  await runSelectedSubprocessRunner(selection)
}
