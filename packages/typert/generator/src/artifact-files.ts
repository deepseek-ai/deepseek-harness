/**
 * Package-local files of generated Typert artifacts. The tsdown plugin and
 * standalone workspace generation both write through this module, so a pass
 * over the same artifacts leaves the same bytes on disk.
 * @module @deepseek-ai/dsh-typert-generator/artifact-files
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkspaceEmitResult } from './workspace.ts'

const REMOTE_CLIENT_FILES = [
  'typert.remote-client.js',
  'typert.remote-client.d.ts',
  'typert.remote-client.d.ts.map',
] as const

/**
 * Write one package's artifacts under `<packageDir>/lib`: `typert.<face>.js`
 * and `typert.<face>.d.ts` per artifact, plus the three
 * `typert.remote-client.*` files when an artifact carries Remote methods. A
 * Host artifact without Remote methods removes any Remote client files left
 * by an earlier pass. Files are written one by one, so a failed write can
 * leave this package's outputs partially replaced.
 * @param packageDir - absolute package root.
 * @param artifacts - artifacts of that package only.
 * @throws A file-system error when the output directory or a file cannot be written.
 */
export function writePackageArtifacts(packageDir: string, artifacts: readonly WorkspaceEmitResult[]): void {
  const output = join(packageDir, 'lib')
  mkdirSync(output, { recursive: true })
  let emittedRemote = false
  for (const artifact of artifacts) {
    writeFileSync(join(output, `typert.${artifact.face}.js`), artifact.js)
    writeFileSync(join(output, `typert.${artifact.face}.d.ts`), artifact.dts)
    if (artifact.remote !== undefined) {
      emittedRemote = true
      writeFileSync(join(output, 'typert.remote-client.js'), artifact.remote.js)
      writeFileSync(join(output, 'typert.remote-client.d.ts'), artifact.remote.dts)
      writeFileSync(join(output, 'typert.remote-client.d.ts.map'), artifact.remote.dtsMap)
    }
  }
  if (!emittedRemote && artifacts.some(artifact => artifact.face === 'host')) {
    for (const file of REMOTE_CLIENT_FILES) rmSync(join(output, file), { force: true })
  }
}

/**
 * Write every artifact of one workspace pass into its own package, in
 * artifact order, with {@link writePackageArtifacts}. A failed write stops
 * the pass; earlier packages keep their new files and later ones keep their
 * previous files.
 * @param root - workspace root that each artifact's `packageRoot` is relative to.
 * @param artifacts - artifacts returned by one `WorkspaceTypertGenerator` pass.
 * @throws A file-system error when an output directory or file cannot be written.
 */
export function writeWorkspaceArtifacts(root: string, artifacts: readonly WorkspaceEmitResult[]): void {
  for (const artifact of artifacts) writePackageArtifacts(join(root, artifact.packageRoot), [artifact])
}
