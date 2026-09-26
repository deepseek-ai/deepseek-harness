/**
 * Shared TypeScript Program construction for repository gates that need real
 * cross-file symbols and types instead of isolated syntax trees.
 */

import { relative, resolve } from 'node:path'
import ts from 'typescript'

interface ProjectGraph {
  rootNames: string[]
  options: ts.CompilerOptions
}

/**
 * A compiler face: the two aggregates a repository-wide program may seed from.
 * The root solution is never one of them.
 */
export type CompilerFace = 'host' | 'client'

/** TypeScript config host shared by repository scripts. */
export const repositoryConfigHost: ts.ParseConfigFileHost = {
  useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  readDirectory: (...args) => ts.sys.readDirectory(...args),
  fileExists: fileName => ts.sys.fileExists(fileName),
  readFile: fileName => ts.sys.readFile(fileName),
  getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
  onUnRecoverableConfigFileDiagnostic(diagnostic) {
    throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
  },
}

/** One compiler face aggregate: its own config and every project it compiles. */
export interface FaceConfigs {
  /** The aggregate's `tsconfig.<face>.json`. */
  readonly root: ts.ParsedCommandLine
  /** Every config the face compiles, its own aggregate included, keyed by resolved config path. */
  readonly byPath: ReadonlyMap<string, ts.ParsedCommandLine>
}

/**
 * Parse one compiler face aggregate and every project it references. Never seed
 * the root solution: the two faces are separate graphs, and flattening
 * host+client into one program collides the cordis Context merges.
 * @param projectRoot - repository root holding `tsconfig.<face>.json`.
 * @param face - which aggregate to parse.
 * @returns the aggregate's root config and every config it compiles.
 */
export function faceConfigs(projectRoot: string, face: CompilerFace): FaceConfigs {
  const rootPath = resolve(projectRoot, `tsconfig.${face}.json`)
  const root = parseConfig(rootPath)
  const byPath = new Map<string, ts.ParsedCommandLine>([[rootPath, root]])
  const collect = (parsed: ts.ParsedCommandLine): void => {
    for (const reference of parsed.projectReferences ?? []) {
      const referencePath = ts.resolveProjectReferencePath(reference)
      if (byPath.has(referencePath)) continue
      const referenced = parseConfig(referencePath)
      byPath.set(referencePath, referenced)
      collect(referenced)
    }
  }
  collect(root)
  return { root, byPath }
}

/**
 * Flatten one compiler face aggregate into one semantic graph.
 * @param projectRoot - repository root holding `tsconfig.<face>.json`.
 * @param face - which aggregate to flatten.
 * @returns every root name the face compiles, with the aggregate's options.
 */
function loadProjectGraph(projectRoot: string, face: CompilerFace): ProjectGraph {
  const { root, byPath } = faceConfigs(projectRoot, face)
  const rootNames = new Set<string>()
  for (const parsed of byPath.values()) {
    for (const fileName of parsed.fileNames) rootNames.add(fileName)
  }
  return {
    rootNames: [...rootNames],
    options: root.options,
  }
}

/** Parse one config file and fail loud on any config diagnostic. */
function parseConfig(configPath: string): ts.ParsedCommandLine {
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, repositoryConfigHost)
  if (!parsed) throw new Error(`cannot parse TypeScript config ${configPath}`)
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'))
  }
  return parsed
}

/** Disable emit-only options after loading the root solution config. */
function semanticCompilerOptions(options: ts.CompilerOptions): ts.CompilerOptions {
  return {
    ...options,
    noEmit: true,
    composite: false,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
    incremental: false,
  }
}

/** A repository-scoped TypeScript Program and its shared TypeChecker. */
export class TypeScriptProject {
  /** The bound cross-file TypeScript program. */
  readonly program: ts.Program
  /** The checker shared by every semantic query in this project. */
  readonly checker: ts.TypeChecker

  /**
   * @param projectRoot - repository root the program is seeded and reported from.
   * @param face - which compiler face aggregate to flatten.
   */
  constructor(readonly projectRoot: string, face: CompilerFace = 'host') {
    const graph = loadProjectGraph(projectRoot, face)
    this.program = ts.createProgram(graph.rootNames, semanticCompilerOptions(graph.options))
    this.checker = this.program.getTypeChecker()
  }

  /**
   * Return every source file loaded into the flattened root project graph.
   * @returns program source files, including libraries and external dependencies.
   */
  sourceFiles(): readonly ts.SourceFile[] {
    return this.program.getSourceFiles()
  }

  /**
   * Render a loaded source file relative to the project root.
   * @param sourceFile - a source file from this project.
   * @returns a slash-separated repository-relative path.
   */
  relativePath(sourceFile: ts.SourceFile): string {
    return relative(this.projectRoot, sourceFile.fileName).replaceAll('\\', '/')
  }

  /**
   * Return one program source file by repository-relative path.
   * @param relativePath - path relative to the project root.
   * @returns the source file bound into this project.
   * @throws if a requested root or imported source was not loaded.
   */
  sourceFile(relativePath: string): ts.SourceFile {
    const sourceFile = this.program.getSourceFile(resolve(this.projectRoot, relativePath))
    if (!sourceFile) throw new Error(`TypeScript project did not load ${relativePath}`)
    return sourceFile
  }
}
