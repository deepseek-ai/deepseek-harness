/** Run one headless task through the shipped PTC mode composition. Requires a model credential. */
import { spawn } from 'node:child_process'

const task = process.argv.slice(2).join(' ').trim()
  || 'Inspect this repository with PTC mode and report its top-level architecture.'

const child = spawn(process.execPath, [
  '--import',
  'tsx/esm',
  'apps/cli/src/bin.ts',
  '--profile',
  'headless',
  '--patch',
  'apps/cli/config/examples/ptc.yml',
  task,
], {
  stdio: 'inherit',
})
child.on('exit', (code, signal) => { process.exit(signal !== null ? 1 : code ?? 1) })
