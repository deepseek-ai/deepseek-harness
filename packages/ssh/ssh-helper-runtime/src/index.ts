/** Private SEA dispatcher for the SSH helper and its managed process workers. */
/* v8 ignore file -- the executable artifact suite runs this entry through pkg's SEA loader. */
import { registerHooks } from 'node:module'
import { statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isSea } from 'node:sea'
import { pathToFileURL } from 'node:url'

/**
 * Dispatch the co-shipped helper or worker once from the private SEA bootstrap.
 * @returns after the selected process entry has completed its cleanup.
 * @throws when invoked outside SEA or when native resources cannot be loaded.
 */
export async function runSshHelperRuntime(): Promise<void> {
  if (!isSea()) throw new Error('SSH helper runtime must run from its packaged executable')

  // The operating system executes Landlock outside the SEA virtual filesystem.
  const nativeManifest = join(dirname(process.execPath), 'native', 'system', 'package.json')
  statSync(nativeManifest)
  const platformPackage = `@deepseek-ai/node-addon-system-${process.platform}-${process.arch}/package.json`
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === platformPackage) return { url: pathToFileURL(nativeManifest).href, shortCircuit: true }
      return nextResolve(specifier, context)
    },
  })

  const selection = process.env.DSH_SUBPROCESS_RUNNER
  Reflect.deleteProperty(process.env, 'DSH_SUBPROCESS_RUNNER')
  if (process.env.DSH_PTC_RUNTIME_NODE === '1') {
    Reflect.deleteProperty(process.env, 'DSH_PTC_RUNTIME_NODE')
    await import('@deepseek-ai/dsh-ptc-runtime-node/process')
  } else if (selection !== undefined) {
    const { runSelectedSubprocessRunner } = await import('@deepseek-ai/dsh-subprocess-local/runner')
    await runSelectedSubprocessRunner(selection)
  } else {
    await import('@deepseek-ai/dsh-ssh/helper')
  }
}
