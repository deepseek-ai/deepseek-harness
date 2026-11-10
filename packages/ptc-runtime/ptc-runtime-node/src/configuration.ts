/** Pure configuration changes for Node PTC profile editors. */
import type { PtcProgramFormat } from '@deepseek-ai/dsh-ptc-runtime'
import type { Config } from './config.ts'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/**
 * Select retained Node execution while preserving Script and scoped REPL syntax.
 * @param programFormat - Effective syntax; omission uses the Node provider's default function-body syntax.
 * @returns All three settings to merge into the profile atomically, replacing stale values; function bodies switch to the retained REPL.
 */
export function resolvePersistentExecution(
  programFormat: PtcProgramFormat = 'function-body',
): Pick<Required<Config>, 'executionMode' | 'scriptPersistence' | 'replScoped'> {
  switch (programFormat) {
    case 'script': return { executionMode: 'vm-script', scriptPersistence: true, replScoped: false }
    case 'function-body':
    case 'repl': return { executionMode: 'persistent-in-memory', scriptPersistence: false, replScoped: false }
    case 'scoped-repl': return { executionMode: 'persistent-in-memory', scriptPersistence: false, replScoped: true }
    /* v8 ignore next -- The runtime supplies the closed, typed program-format union. */
    default: return assertNever(programFormat)
  }
}
