import { join } from 'node:path'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'

const NOTICE = 'landlock-run: partial enforcement (older Landlock ABI)'
const MISSING_RUNNER_ENV = 'DSH_SNAPSHOT_MISSING_SANDBOX_RUNNER'

/**
 * Snapshot-only provider for deterministic runner classification. Its default
 * launch reproduces older-ABI Landlock; an explicit scenario flag selects a
 * missing executable under the valid workspace cwd. Keep the Landlock tuple
 * aligned with `RUNNER_FAILURE_RULES` in `packages/sandbox/sandbox-local/src/index.ts`.
 */
export default class PartialLandlockSandboxProvider extends SandboxProvider {
  async confine(argv: readonly string[], policy: SandboxPolicy): Promise<ConfinedArgv> {
    if (process.env[MISSING_RUNNER_ENV] === '1') {
      return {
        argv: [join(policy.workspaceRoot, '.dsh-missing-sandbox-runner'), ...argv],
        enforcement: 'full',
        denialSignatures: ['permission denied'],
        runnerFailureRules: [{ fatalSignatures: ['snapshot-runner: '] }],
      }
    }
    return {
      argv: [
        'bash',
        '-c',
        `printf '%s\\n' '${NOTICE}' >&2; exec "$@"`,
        'partial-landlock-run',
        ...argv,
      ],
      enforcement: 'partial',
      denialSignatures: ['permission denied'],
      runnerFailureRules: [{
        allowedExitCodes: [125],
        fatalSignatures: ['landlock-run: '],
        informationalLines: [NOTICE],
      }],
    }
  }
}
