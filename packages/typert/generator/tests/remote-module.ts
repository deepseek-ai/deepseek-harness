/** Source-only evaluator for generated Remote and Host invocation artifacts. */

import { readFileSync } from 'node:fs'
import ts from 'typescript'

/**
 * Load generated JavaScript with the current protocol factory, not built workspace libraries.
 * @param source - generated JavaScript containing only Zod and pure Remote-info imports.
 * @returns the evaluated generated module.
 */
export async function executableRemoteModule<Module>(source: string): Promise<Module> {
  const zodImport = `from ${JSON.stringify(import.meta.resolve('zod'))}`
  const factory = ts.transpileModule(
    readFileSync(new URL('../../protocol/src/remote-info.ts', import.meta.url), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } },
  ).outputText
  const factoryUrl = `data:text/javascript,${encodeURIComponent(factory)}`
  const executable = source
    .replace(/from (['"])zod\1/g, zodImport)
    .replace(/from (['"])@deepseek-ai\/dsh-typert-protocol\/remote-info\1/g, `from ${JSON.stringify(factoryUrl)}`)
  return await import(`data:text/javascript,${encodeURIComponent(executable)}`) as Module
}
