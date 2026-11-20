/** Source-derived Remote contributions for Vitest suites that exercise plugin-owned mounts. */
import { resolve } from 'node:path'
import { normalizePath } from 'vite'
import { WorkspaceAnalyzer } from '../packages/typert/generator/src/analyzer.ts'
import { FaceModelEmitter } from '../packages/typert/generator/src/emitter.ts'

/**
 * Resolve one package's Remote contribution from its Host sources, without reading or writing build output.
 * @param root - workspace root containing the Host aggregate tsconfig.
 * @param packageName - Host package whose Remote methods the tests mount.
 * @returns a Vite plugin caching the generated module for one test run; invalid or artifact-dependent sources fail loading.
 */
export function sourceRemotePlugin(root: string, packageName: string) {
  const specifier = `${packageName}/remote`
  // A workspace TypeScript id keeps generated imports under the source paths resolver.
  const virtualId = normalizePath(resolve(root, '.vitest-source-remote', `${encodeURIComponent(packageName)}.ts`))
  let code: string | undefined
  return {
    name: `dsh-source-remote:${packageName}`,
    enforce: 'pre' as const,
    resolveId(source: string) {
      return source === specifier ? virtualId : undefined
    },
    load(id: string) {
      if (id !== virtualId) return
      if (code !== undefined) return code
      const model = new WorkspaceAnalyzer({
        root, packages: [packageName], faces: ['host'], checkDiagnostics: false, rejectBuildOutputs: true,
      }).analyze()
      const face = model.faces.find(candidate => candidate.face === 'host')
      const remote = face === undefined ? undefined : new FaceModelEmitter(face).emit(packageName).remote
      if (remote === undefined) throw new Error(`vitest source Remote: ${packageName} has no Host Remote contribution`)
      code = remote.js
      return code
    },
  }
}
