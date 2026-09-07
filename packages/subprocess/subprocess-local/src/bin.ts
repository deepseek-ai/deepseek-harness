/** Thin executable/importable entry for the provider-private runner core. */

import { consumeRunnerSelection } from './runner-launch.ts'
import { reportSpawnRunnerFailure, runSpawnRunner } from './spawn-runner.ts'

/**
 * Run a selector already removed by a packaging bootstrap.
 * @param selection - private runner selector or Linux launch-request locator.
 */
export async function runSelectedSubprocessRunner(selection: string): Promise<void> {
  try {
    await runSpawnRunner(selection, process.argv.slice(2))
  } catch (error) {
    await reportSpawnRunnerFailure(selection, error)
  }
}

if (import.meta.main) {
  const selection = consumeRunnerSelection()
  if (selection === undefined) {
    process.exitCode = 127
  } else {
    void runSelectedSubprocessRunner(selection)
  }
}
