/**
 * Test-only generation of every Host package's `./remote` face from source, for the assembled viewer
 * page: the CI coverage lane runs no workspace build, so the `lib/typert.remote-client.js` each face
 * names does not exist there.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { WorkspaceTypertGenerator } from '../../../typert/generator/src/index.ts'

/**
 * Write each Host package's generated Remote face into `dir`.
 * @param workspaceRoot - Repository root the generator discovers packages under.
 * @param dir - Staging directory the face modules are written to.
 * @returns Face module paths by package name.
 */
export function generateViewerRemoteFaces(workspaceRoot: string, dir: string): ReadonlyMap<string, string> {
  const generator = new WorkspaceTypertGenerator(workspaceRoot, { checkDiagnostics: false })
  const packages = generator.discover(['host'])
    .filter((candidate) => {
      const manifest = JSON.parse(readFileSync(join(workspaceRoot, candidate.root, 'package.json'), 'utf8')) as {
        readonly exports?: Record<string, unknown>
      }
      return manifest.exports !== undefined && Object.hasOwn(manifest.exports, './remote')
    })
    .map(candidate => candidate.package)
  const faces = new Map<string, string>()
  // Generated faces use the current source factory without requiring built workspace artifacts.
  const factoryPath = relative(dir, join(workspaceRoot, 'packages/typert/protocol/src/remote-info.ts')).split(sep).join('/')
  const factorySpecifier = factoryPath.startsWith('.') ? factoryPath : `./${factoryPath}`
  for (const artifact of generator.generate(packages, ['host'])) {
    if (artifact.remote === undefined) continue
    const file = join(dir, `${artifact.package.replaceAll('/', '__')}.js`)
    const source = artifact.remote.js.replace(
      /from (['"])@deepseek-ai\/dsh-typert-protocol\/remote-info\1/g,
      `from ${JSON.stringify(factorySpecifier)}`,
    )
    writeFileSync(file, source)
    faces.set(artifact.package, file)
  }
  return faces
}
