/**
 * Runs the full-corpus import gate (`transform-corpus-check.ts`) in the
 * launcher it is written for, and reports its findings as this suite's failure.
 *
 * Spawned rather than imported, because the gate's oracle is NODE's ESM loader:
 * whether a built bundle imports is judged by `await import(file)` there.
 * Vitest replaces that loader with vite's module runner, which imports files
 * Node cannot — a `.css` import resolves, and koffi loads a second time — so an
 * in-process run measures a different loader and reports the pinned baseline
 * exemptions as stale. A gate whose verdict depends on how it was launched is
 * not a gate.
 *
 * The corpus is the build output, so this skips on a tree that has none.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, test, TestRunner } from 'vitest'

const runner = fileURLToPath(new URL('./transform-corpus-check.ts', import.meta.url))

test('every built bundle imports under Node', (context) => {
  const finished = spawnSync(process.execPath, ['--import', 'tsx/esm', runner], { encoding: 'utf8' })
  const output = `${finished.stdout}${finished.stderr}`
  if (output.includes('no built bundles found')) {
    context.skip('the workspace has no build output to sweep')
    return
  }
  // The runner prefixes every finding with '- ', so a failure reads as the
  // findings themselves rather than as a diff of its whole report.
  expect(output.split('\n').filter(line => line.startsWith('- ')).join('\n')).toBe('')
  expect(finished.status, output).toBe(0)
}, 900_000)

// The hook replaces only the chosen bundle; shared build artifacts stay intact.
// The admitted evidence is Node's unknown-`.css`-extension refusal whatever
// stylesheet it names; another extension, error code, or message is a finding.
test.each([
  ['expected-css', 0, 'baselineExempt=1 unexpectedBaselineFailure=0'],
  ['other-css', 0, 'baselineExempt=1 unexpectedBaselineFailure=0'],
  ['other-extension', 1, '- UNEXPECTED BASELINE FAILURE'],
  ['error', 1, '- UNEXPECTED BASELINE FAILURE'],
  ['other-code', 1, '- UNEXPECTED BASELINE FAILURE'],
  ['clean', 1, '- STALE EXEMPTION'],
] as const)('classifies dockkit import: %s', (mode, status, finding) => {
  const root = new URL('../../../../../', import.meta.url)
  const bundle = 'packages/client/ui-dockkit/lib/index.js'
  const cssBase = fileURLToPath(new URL('packages/client/ui-dockkit/lib/components/dockkit.module', root))
  const extension = mode === 'other-extension' ? '.wasm' : '.css'
  // The other stylesheet is the dependency's, which the launcher resolves into
  // its source tree: the sweep reports it where an exact-path admission would
  // reject the bundle.
  const file = mode === 'other-css'
    ? fileURLToPath(new URL('packages/client/ui-primitives/src/StateDot.module.css', root))
    : `${cssBase}${extension}`
  const message = mode === 'error'
    ? 'dockkit-negative-control'
    : `Unknown file extension "${extension}" for ${file}`
  const source = mode === 'clean'
    ? 'export {}'
    : `throw Object.assign(new Error(${JSON.stringify(message)}), { code: ${JSON.stringify(mode === 'other-code' ? 'ERR_OTHER' : 'ERR_UNKNOWN_FILE_EXTENSION')} })`
  const script = `
    import { registerHooks } from 'node:module'
    const target = ${JSON.stringify(new URL(bundle, root).href)}
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === target) return { url: target, shortCircuit: true }
        return nextResolve(specifier, context)
      },
      load(url, context, nextLoad) {
        if (url === target) {
          return { format: 'module', shortCircuit: true, source: ${JSON.stringify(source)} }
        }
        return nextLoad(url, context)
      },
    })
    process.argv = [process.execPath, 'corpus-classification', ${JSON.stringify(bundle)}]
    await import(${JSON.stringify(pathToFileURL(runner).href)})
  `
  const finished = spawnSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', script], {
    cwd: fileURLToPath(root), encoding: 'utf8', timeout: TestRunner.getCurrentTest()!.timeout,
  })
  const output = `${finished.stdout}${finished.stderr}`
  expect(finished.error).toBeUndefined()
  expect(finished.signal).toBeNull()
  expect(finished.status, output).toBe(status)
  expect(output).toContain(finding)
  if (finding.startsWith('- UNEXPECTED BASELINE FAILURE')) {
    expect(output).toContain(`- UNEXPECTED BASELINE FAILURE ${bundle}: ${message}\n`)
  }
})
