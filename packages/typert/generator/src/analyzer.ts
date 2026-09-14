/**
 * TypeScript project analyzer for the compiler-independent Typert model.
 * Programs, symbols, and syntax nodes remain extraction-only implementation
 * details; callers receive only the model declared in {@link ./model.ts}.
 * @module @deepseek-ai/dsh-typert-generator/analyzer
 */

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import type {
  CrossFaceLink,
  DocumentationModel,
  EventModel,
  EnumMemberModel,
  ExportModel,
  FaceModel,
  InvocationModel,
  InvocationParameterModel,
  JsDocTagModel,
  KeywordTypeName,
  MemberBase,
  MemberModel,
  MemberVisibility,
  ObjectModel,
  PackageModel,
  ParameterModel,
  RemoteBoundaryModel,
  RemoteTypeImportModel,
  SchemaModel,
  ServiceModel,
  SignatureModel,
  SourceDeclarationModel,
  SourceLocation,
  SymbolId,
  TypeDeclarationModel,
  TypeNodeId,
  TypeNodeModel,
  TypeOperatorName,
  TypeParameterModel,
  TypeTargetModel,
  TypertFace,
  WorkspaceModel,
} from './model.ts'

type WithoutId<T> = T extends { readonly id: TypeNodeId } ? Omit<T, 'id'> : never

type TypeNodeInput = WithoutId<TypeNodeModel>

const PUBLIC_REMOTE_TYPE_ROOTS = new Set([
  '@deepseek-ai/dsh-util-values',
])

/** Analysis failure with a source-oriented diagnostic. */
export class TypertAnalysisError extends Error {
  override name = 'TypertAnalysisError'
}

class SourceEditQueued extends Error {}

/** Missing-annotation handling at public business boundaries. */
export type AnalysisMode = 'check' | 'write'

/** Workspace analysis configuration. */
export interface WorkspaceAnalyzerOptions {
  /** Workspace root containing the face tsconfigs. */
  readonly root: string
  /** Host aggregate path, relative to {@link root}; absent files are skipped. */
  readonly hostConfig?: string
  /** Client aggregate path, relative to {@link root}; absent files are skipped. */
  readonly clientConfig?: string
  /** Optional package-name subset for an incremental generation pass. */
  readonly packages?: readonly string[]
  /** Independently compiled faces to materialize; both are analyzed by default. */
  readonly faces?: readonly TypertFace[]
  /** Whether to repeat TypeScript project diagnostics before model extraction. */
  readonly checkDiagnostics?: boolean
  /** Whether missing annotations fail or are written before a clean re-analysis. */
  readonly mode?: AnalysisMode
  /** Shared workspace memo; supply one instance to reuse parses across analyzers. */
  readonly caches?: WorkspaceCaches
}

/** One package face whose public export graph contains Typert business declarations. */
export interface DiscoveredTypertPackage {
  readonly package: string
  readonly root: string
  readonly faces: readonly TypertFace[]
}

/** One parsed tsconfig, memoizable per workspace snapshot. */
export interface ParsedConfig {
  /** Absolute config path. */
  readonly path: string
  /** The TypeScript parse result. */
  readonly parsed: ts.ParsedCommandLine
}

/** One package face registration discovered from an aggregate tsconfig. */
export interface PackageRegistration {
  /** The face whose aggregate references this package project. */
  readonly face: TypertFace
  /** The package manifest name. */
  readonly name: string
  /** Real package root directory. */
  readonly root: string
  /** The package's own parsed tsconfig. */
  readonly config: ParsedConfig
  /** The parsed package.json content. */
  readonly manifest: Record<string, unknown>
  /** Export subpaths owned by this face for dual-face packages. */
  readonly exportSubpaths?: readonly string[]
}

interface ExportRecord {
  readonly model: ExportModel
  readonly symbol: ts.Symbol
  readonly declaration: ts.Declaration
  readonly sourceFile: ts.SourceFile
}

interface SourceEdit {
  readonly file: string
  readonly position: number
  readonly text: string
}

interface ModuleIdentity {
  readonly package: string
  readonly subpath: string
}

/** The package import a type reference reaches after following package-local forwarding modules. */
interface PackageImport {
  readonly module: ModuleIdentity
  /** Name the type is exported under at that package subpath. */
  readonly name: string
}

/** One `import` binding of a local name; `name` is absent for a namespace import. */
interface ImportBinding {
  readonly specifier: string
  readonly name?: string
}

/** One outgoing `export` edge of a forwarding module for one exported name. */
interface ForwardedExport {
  readonly specifier: string
  readonly name: string
}

interface StaticLookupDeclaration {
  readonly key: string
  readonly hostSymbol: SymbolId
  readonly wireType: ts.TypeNode
  readonly site: ts.Node
}

interface StaticContextDeclaration {
  readonly key: string
  readonly wireType: ts.TypeNode
  readonly site: ts.Node
}

interface GatewayBinding {
  readonly service: string
  readonly namespace: string
  readonly site: ts.Node
}

type ReferenceSite = ts.TypeReferenceNode | ts.ExpressionWithTypeArguments | ts.ImportTypeNode

const EMPTY_DOCUMENTATION: DocumentationModel = { tags: [] }

interface FaceProgramHost {
  readonly host: ts.CompilerHost
  readonly files: Map<string, ts.SourceFile | undefined>
}

/**
 * Process-wide parse cache for the bundled TypeScript default libraries.
 * `typescript/lib/lib.*.d.ts` content is immutable for the process lifetime,
 * so parses are shared across every {@link WorkspaceCaches} instance; the key
 * carries the parse-affecting settings, keeping reuse exact.
 */
const defaultLibraryParses = new Map<string, ts.SourceFile | undefined>()

function defaultLibraryKey(fileName: string, languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions): string {
  const options = typeof languageVersionOrOptions === 'object'
    ? languageVersionOrOptions
    : { languageVersion: languageVersionOrOptions }
  return [
    fileName,
    String(options.languageVersion),
    String(options.impliedNodeFormat ?? ''),
    String(options.jsDocParsingMode ?? ''),
  ].join('\0')
}

/**
 * Shared memo over one immutable workspace snapshot. Passing one instance to
 * several analyzers (the batched and write-mode children reuse their parent's
 * automatically) reuses parsed tsconfigs, the registration inventory, and
 * per-face compiler hosts whose parsed and bound source files and module
 * resolutions carry across programs. Callers that mutate workspace files
 * between analyses must start from a fresh instance; write-mode source edits
 * invalidate themselves through {@link invalidate}.
 */
export class WorkspaceCaches {
  /** Parsed tsconfig files by absolute config path. */
  readonly configs = new Map<string, ParsedConfig>()
  /** Registration inventories keyed by root and aggregate config paths. */
  readonly registrations = new Map<string, PackageRegistration[]>()
  private readonly hosts = new Map<TypertFace, FaceProgramHost>()

  /**
   * Parse one tsconfig once per workspace snapshot.
   * @param path - absolute config path.
   * @returns the memoized parse result.
   */
  config(path: string): ParsedConfig {
    let parsed = this.configs.get(path)
    if (parsed === undefined) {
      parsed = parseConfig(path)
      this.configs.set(path, parsed)
    }
    return parsed
  }

  /**
   * Return the shared compiler host for one face. Every program of one face
   * is built from the same aggregate compiler options (the first call wins),
   * so parsed source files, binder state, and module resolutions are safe to
   * reuse across the face's batched programs.
   * @param face - the face whose programs share this host.
   * @param options - the face's effective compiler options.
   * @returns a compiler host with source-file and module-resolution caches.
   */
  programHost(face: TypertFace, options: ts.CompilerOptions): ts.CompilerHost {
    let entry = this.hosts.get(face)
    if (entry === undefined) {
      const host = ts.createCompilerHost(options)
      const files = new Map<string, ts.SourceFile | undefined>()
      const resolutionCache = ts.createModuleResolutionCache(
        host.getCurrentDirectory(),
        fileName => host.getCanonicalFileName(fileName),
        options,
      )
      const base = host.getSourceFile.bind(host)
      // The snapshot contract makes shouldCreateNewSourceFile irrelevant: it
      // only fires under oldProgram reuse, which these fresh programs never
      // request, and invalidate() is the one supported re-read path.
      host.getSourceFile = (fileName, languageVersionOrOptions, onError) => {
        if (isStandardLibraryFile(fileName)) {
          const key = defaultLibraryKey(fileName, languageVersionOrOptions)
          if (!defaultLibraryParses.has(key)) {
            defaultLibraryParses.set(key, base(fileName, languageVersionOrOptions, onError))
          }
          return defaultLibraryParses.get(key)
        }
        if (!files.has(fileName)) files.set(fileName, base(fileName, languageVersionOrOptions, onError))
        return files.get(fileName)
      }
      host.getModuleResolutionCache = () => resolutionCache
      entry = { host, files }
      this.hosts.set(face, entry)
    }
    return entry.host
  }

  /**
   * Drop cached parses of one edited source file so the next analysis reads
   * the written content.
   * @param file - path of the edited file.
   */
  invalidate(file: string): void {
    const target = realPath(file)
    for (const { files } of this.hosts.values()) {
      for (const key of [...files.keys()]) {
        if (realPath(key) === target) files.delete(key)
      }
    }
  }
}

/** Analyze host and client as independent TypeScript programs. */
export class WorkspaceAnalyzer {
  private readonly options: Required<Pick<
    WorkspaceAnalyzerOptions,
    'root' | 'hostConfig' | 'clientConfig' | 'faces' | 'checkDiagnostics' | 'mode'
  >> & Pick<WorkspaceAnalyzerOptions, 'packages'>
  private queuedEdit: SourceEdit | undefined
  private readonly crossFaceLinks = new Map<string, CrossFaceLink>()
  private readonly checkedProjects = new Set<string>()
  private registrations: PackageRegistration[] = []
  private readonly caches: WorkspaceCaches

  constructor(options: WorkspaceAnalyzerOptions) {
    this.options = {
      root: realPath(options.root),
      hostConfig: options.hostConfig ?? 'tsconfig.host.json',
      clientConfig: options.clientConfig ?? 'tsconfig.client.json',
      faces: options.faces ?? ['host', 'client'],
      checkDiagnostics: options.checkDiagnostics ?? true,
      mode: options.mode ?? 'check',
      ...(options.packages === undefined ? {} : { packages: options.packages }),
    }
    this.caches = options.caches ?? new WorkspaceCaches()
  }

  /**
   * Build the workspace model. Write mode applies inferred annotations and then
   * returns a fresh check-mode analysis of the edited projects.
   * @returns the independent face models and their explicit cross-face links.
   */
  analyze(): WorkspaceModel {
    this.registrations = this.loadRegistrations()
    const selected = this.options.packages === undefined
      ? undefined
      : new Set(this.options.packages)
    const faces: FaceModel[] = []
    try {
      for (const face of this.options.faces) {
        const registrations = this.registrations.filter(registration =>
          registration.face === face && (selected === undefined || selected.has(registration.name)))
        if (registrations.length === 0) continue
        if (this.options.checkDiagnostics) {
          for (const registration of registrations) this.checkProject(registration)
        }
        const aggregatePath = resolve(this.options.root, face === 'host' ? this.options.hostConfig : this.options.clientConfig)
        const aggregate = this.caches.config(aggregatePath)
        const rootNames = [...new Set(registrations.flatMap(registration => registration.config.parsed.fileNames))]
        const options: ts.CompilerOptions = {
          ...aggregate.parsed.options,
          composite: false,
          incremental: false,
          noEmit: true,
        }
        const host = this.caches.programHost(face, options)
        const program = ts.createProgram({ rootNames, options, host })
        faces.push(new FaceAnalyzer({
          root: this.options.root,
          face,
          program,
          host,
          registrations,
          allRegistrations: this.registrations,
          mode: this.options.mode,
          queueEdit: (edit) => { this.queueEdit(edit) },
          crossFaceLinks: this.crossFaceLinks,
        }).analyze())
      }
    } catch (error) {
      if (!(error instanceof SourceEditQueued) || this.options.mode !== 'write' || this.queuedEdit === undefined) throw error
    }

    if (this.queuedEdit !== undefined) {
      this.applyEdit(this.queuedEdit)
      return new WorkspaceAnalyzer({ ...this.options, caches: this.caches, mode: 'write' }).analyze()
    }

    if (this.options.mode === 'write') {
      return new WorkspaceAnalyzer({ ...this.options, caches: this.caches, mode: 'check' }).analyze()
    }

    return {
      faces,
      crossFaceLinks: [...this.crossFaceLinks.values()].sort(compareCrossFaceLinks),
    }
  }

  /**
   * Analyze an explicit package selection through bounded compiler programs.
   * The resulting model is identical in shape to {@link analyze}; stable graph
   * ids let repeated dependency declarations merge without flattening types.
   * @param batchSize - maximum selected packages in one face program.
   * @returns one merged workspace model.
   */
  analyzeInBatches(batchSize = 8): WorkspaceModel {
    if (this.options.packages === undefined) {
      throw new TypertAnalysisError('typert: batched analysis requires an explicit package selection')
    }
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new TypertAnalysisError(`typert: batch size must be a positive integer, received ${String(batchSize)}`)
    }
    const batches: WorkspaceModel[] = []
    for (let index = 0; index < this.options.packages.length; index += batchSize) {
      batches.push(new WorkspaceAnalyzer({
        ...this.options,
        caches: this.caches,
        packages: this.options.packages.slice(index, index + batchSize),
      }).analyze())
    }
    return mergeWorkspaceModels(batches)
  }

  /**
   * Discover package faces from public-export-reachable Cordis augmentations
   * and explicit `@typert` roots without constructing a type-checker program.
   * @returns contributors grouped by package with deterministic face order.
   */
  discoverPackages(): DiscoveredTypertPackage[] {
    const registrations = this.loadRegistrations()
      .filter(registration => this.options.faces.includes(registration.face))
      .filter(registration => this.registrationHasSurface(registration))
    const packages = new Map<string, { root: string; faces: Set<TypertFace> }>()
    for (const registration of registrations) {
      const current = packages.get(registration.name) ?? {
        root: slash(relative(this.options.root, registration.root)),
        faces: new Set<TypertFace>(),
      }
      current.faces.add(registration.face)
      packages.set(registration.name, current)
    }
    return [...packages]
      .map(([packageName, value]) => ({
        package: packageName,
        root: value.root,
        faces: [...value.faces].sort(),
      }))
      .sort((left, right) => left.package.localeCompare(right.package))
  }

  /**
   * Index top-level exported type declarations without promoting them to graph
   * roots. Consumers use this lexical index for ambiguity checks while all
   * semantic traversal continues through {@link TypeGraph}.
   * @returns declarations from the selected faces and package projects.
   */
  indexSourceDeclarations(): SourceDeclarationModel[] {
    const selected = this.options.packages === undefined ? undefined : new Set(this.options.packages)
    const declarations: SourceDeclarationModel[] = []
    for (const registration of this.loadRegistrations()) {
      if (!this.options.faces.includes(registration.face)
        || (selected !== undefined && !selected.has(registration.name))) continue
      for (const file of registration.config.parsed.fileNames) {
        const relativeFile = slash(relative(this.options.root, file))
        if (!existsSync(file)
          || !isWithin(realPath(file), join(registration.root, 'src'))
          || !/\.(?:cts|mts|ts)$/.test(file)
        ) continue
        const sourceFile = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
        for (const statement of sourceFile.statements) {
          if (!isTypeDeclaration(statement)
            || statement.name === undefined
            || !hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue
          const position = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile))
          declarations.push({
            face: registration.face,
            package: registration.name,
            name: statement.name.text,
            kind: ts.isClassDeclaration(statement)
              ? 'class'
              : ts.isInterfaceDeclaration(statement)
                ? 'interface'
                : ts.isTypeAliasDeclaration(statement)
                  ? 'alias'
                  : 'enum',
            location: {
              file: relativeFile,
              line: position.line + 1,
              column: position.character + 1,
            },
            text: declarationText(statement),
          })
        }
      }
    }
    return uniqueBy(declarations, declaration =>
      `${declaration.face}\0${declaration.location.file}\0${String(declaration.location.line)}\0${declaration.name}`)
      .sort((left, right) => left.face.localeCompare(right.face)
        || left.location.file.localeCompare(right.location.file)
        || left.location.line - right.location.line)
  }

  private loadRegistrations(): PackageRegistration[] {
    const inventoryKey = `${this.options.root}\0${this.options.hostConfig}\0${this.options.clientConfig}`
    const cached = this.caches.registrations.get(inventoryKey)
    if (cached !== undefined) return cached
    const registrations: PackageRegistration[] = []
    for (const face of ['host', 'client'] as const) {
      const aggregatePath = resolve(this.options.root, face === 'host' ? this.options.hostConfig : this.options.clientConfig)
      if (!existsSync(aggregatePath)) continue
      const aggregate = this.caches.config(aggregatePath)
      for (const reference of aggregate.parsed.projectReferences ?? []) {
        const configPath = projectConfigPath(reference.path)
        const packageRoot = dirname(configPath)
        if (!isWithin(realPath(packageRoot), join(this.options.root, 'packages'))) continue
        const manifestPath = join(packageRoot, 'package.json')
        if (!existsSync(manifestPath)) continue
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
        if (typeof manifest.name !== 'string') continue
        const registration: PackageRegistration = {
          face,
          name: manifest.name,
          root: realPath(packageRoot),
          config: this.caches.config(configPath),
          manifest,
        }
        if (!isDualFacePackage(manifest)) {
          registrations.push(registration)
        } else if (configPath === join(packageRoot, 'tsconfig.json')) {
          registrations.push(
            { ...registration, face: 'host', exportSubpaths: hostExportSubpaths(manifest) },
            { ...registration, face: 'client', exportSubpaths: clientExportSubpaths(manifest) },
          )
        } else {
          registrations.push({
            ...registration,
            exportSubpaths: face === 'host'
              ? hostExportSubpaths(manifest)
              : clientExportSubpaths(manifest),
          })
        }
      }
    }
    const inventory = uniqueBy(registrations, registration => `${registration.face}\0${registration.name}`)
      .sort((left, right) =>
        left.face.localeCompare(right.face) || left.name.localeCompare(right.name))
    this.caches.registrations.set(inventoryKey, inventory)
    return inventory
  }

  private entrySourcePaths(registration: PackageRegistration): string[] {
    return packageExportTargets(registration.manifest)
      .filter(([subpath, target]) => (registration.exportSubpaths === undefined
        || registration.exportSubpaths.includes(subpath))
        && !target.includes('*')
        && subpath !== './package.json'
        && subpath !== './typert'
        && subpath !== './client/typert'
        && subpath !== './remote'
        && !target.endsWith('.json'))
      .map(([, target]) => sourcePathForExport(registration.root, target))
      .filter(existsSync)
  }

  private registrationHasSurface(registration: PackageRegistration): boolean {
    const seen = new Set<string>()
    const queue = this.entrySourcePaths(registration)
    while (queue.length > 0) {
      const file = realPath(queue.shift() as string)
      if (seen.has(file) || !isWithin(file, registration.root)) continue
      seen.add(file)
      const source = readFileSync(file, 'utf8')
      const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
      if (sourceFileHasSurface(sourceFile)) return true
      for (const imported of ts.preProcessFile(source).importedFiles) {
        const resolved = ts.resolveModuleName(
          imported.fileName,
          file,
          registration.config.parsed.options,
          ts.sys,
        ).resolvedModule
        if (resolved !== undefined && isWithin(resolved.resolvedFileName, registration.root)) {
          queue.push(resolved.resolvedFileName)
        }
      }
    }
    return false
  }

  private checkProject(registration: PackageRegistration): void {
    if (this.checkedProjects.has(registration.config.path)) return
    this.checkedProjects.add(registration.config.path)
    const program = ts.createProgram({
      rootNames: registration.config.parsed.fileNames,
      options: {
        ...registration.config.parsed.options,
        composite: false,
        incremental: false,
        noEmit: true,
        // Source-plane workspace aliases resolve referenced packages to source.
        // Widen only this diagnostic program's root so those imports do not
        // produce an artificial TS6059 before Typert checks the public edge.
        rootDir: this.options.root,
      },
    })
    const diagnostics = [
      ...program.getSyntacticDiagnostics(),
      ...program.getSemanticDiagnostics(),
    ].filter((diagnostic): diagnostic is ts.DiagnosticWithLocation => diagnostic.file !== undefined
      && diagnostic.start !== undefined
      && isWithin(diagnostic.file.fileName, registration.root))
    if (diagnostics.length === 0) return
    throw new TypertAnalysisError(
      diagnostics
        .map(diagnostic => formatProgramDiagnostic(this.options.root, registration.face, diagnostic))
        .join('\n'),
    )
  }

  private queueEdit(edit: SourceEdit): void {
    this.queuedEdit = edit
  }

  private applyEdit(edit: SourceEdit): void {
    const source = readFileSync(edit.file, 'utf8')
    writeFileSync(edit.file, source.slice(0, edit.position) + edit.text + source.slice(edit.position))
    this.caches.invalidate(edit.file)
  }
}

interface FaceAnalyzerOptions {
  readonly root: string
  readonly face: TypertFace
  readonly program: ts.Program
  /** Program host whose module-resolution cache serves import resolution outside the checker. */
  readonly host: ts.CompilerHost
  readonly registrations: readonly PackageRegistration[]
  readonly allRegistrations: readonly PackageRegistration[]
  readonly mode: AnalysisMode
  readonly queueEdit: (edit: SourceEdit) => void
  readonly crossFaceLinks: Map<string, CrossFaceLink>
}

class FaceAnalyzer {
  private readonly root: string
  private readonly face: TypertFace
  private readonly program: ts.Program
  private readonly host: ts.CompilerHost
  private readonly checker: ts.TypeChecker
  private readonly registrations: readonly PackageRegistration[]
  private readonly allRegistrations: readonly PackageRegistration[]
  private readonly mode: AnalysisMode
  private readonly queueEdit: (edit: SourceEdit) => void
  private readonly crossFaceLinks: Map<string, CrossFaceLink>
  private readonly sourceFiles = new Map<string, ts.SourceFile>()
  private readonly declarations = new Map<SymbolId, TypeDeclarationModel>()
  private readonly declarationStates = new Set<SymbolId>()
  private readonly nodes = new Map<TypeNodeId, TypeNodeModel>()
  private readonly exportsByPackage = new Map<string, ExportRecord[]>()
  private readonly nodeOrdinals = new Map<string, number>()
  private staticLookups: readonly StaticLookupDeclaration[] | undefined
  private staticContexts: ReadonlyMap<string, StaticContextDeclaration> | undefined

  constructor(options: FaceAnalyzerOptions) {
    this.root = options.root
    this.face = options.face
    this.program = options.program
    this.host = options.host
    this.checker = options.program.getTypeChecker()
    this.registrations = options.registrations
    this.allRegistrations = options.allRegistrations
    this.mode = options.mode
    this.queueEdit = options.queueEdit
    this.crossFaceLinks = options.crossFaceLinks
    for (const sourceFile of this.program.getSourceFiles()) {
      this.sourceFiles.set(realPath(sourceFile.fileName), sourceFile)
    }
  }

  analyze(): FaceModel {
    for (const registration of this.registrations) {
      this.exportsByPackage.set(registration.name, this.collectExports(registration))
    }
    const packages = this.registrations
      .map(registration => this.analyzePackage(registration))
      .filter(hasPackageSurface)
    this.validateInvocationIdentity(packages)
    return {
      face: this.face,
      packages,
      graph: {
        declarations: [...this.declarations.values()].sort((left, right) => left.id.localeCompare(right.id)),
        nodes: [...this.nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
      },
    }
  }

  private analyzePackage(registration: PackageRegistration): PackageModel {
    const records = this.exportsByPackage.get(registration.name) as ExportRecord[]
    const reachable = this.reachableFiles(registration, records.map(record => record.sourceFile))
    const services: ServiceModel[] = []
    const events: EventModel[] = []

    for (const sourceFile of reachable) {
      for (const statement of sourceFile.statements) {
        if (!ts.isModuleDeclaration(statement)
          || !ts.isStringLiteral(statement.name)
          || statement.name.text !== '@deepseek-ai/cordis'
          || statement.body === undefined
          || !ts.isModuleBlock(statement.body)) continue
        for (const member of statement.body.statements) {
          if (!ts.isInterfaceDeclaration(member)) continue
          if (member.name.text === 'Context') {
            services.push(...this.collectServices(member, records))
          } else if (member.name.text === 'Events') {
            events.push(...this.collectEvents(member))
          }
        }
      }
    }
    const explicitServices = this.collectExplicitServices(records)

    const objects: ObjectModel[] = []
    const schemas: SchemaModel[] = []
    const seenBusinessSymbols = new Set<SymbolId>()
    for (const record of records) {
      const declaration = record.declaration
      if (!isTypeDeclaration(declaration)) continue
      if (this.registrationForFile(declaration.getSourceFile().fileName) === undefined) continue
      const symbol = this.resolveSymbol(record.symbol)
      const symbolId = this.symbolId(symbol)
      if (seenBusinessSymbols.has(symbolId)) continue
      const mode = typertMode(declaration)
      if (mode !== 'object' && mode !== 'schema') continue
      seenBusinessSymbols.add(symbolId)
      this.ensureDeclaration(symbol, declaration)
      const documentation = documentationOf(declaration)
      if (mode === 'object') {
        objects.push({
          ...documentation,
          export: record.model,
          symbol: symbolId,
          passing: 'reference',
        })
      } else {
        schemas.push({
          ...documentation,
          export: record.model,
          symbol: symbolId,
          type: this.referenceNode(symbol, declaration),
        })
      }
    }

    return {
      name: registration.name,
      root: slash(relative(this.root, registration.root)),
      exports: records.map(record => record.model)
        .sort((left, right) => left.subpath.localeCompare(right.subpath) || left.name.localeCompare(right.name)),
      services: uniqueBy([...explicitServices, ...services], service => service.key)
        .sort((left, right) => left.key.localeCompare(right.key)),
      events: uniqueBy(events, event => event.name).sort((left, right) => left.name.localeCompare(right.name)),
      objects: objects.sort((left, right) => left.export.name.localeCompare(right.export.name)),
      schemas: schemas.sort((left, right) => left.export.name.localeCompare(right.export.name)),
      invocations: this.face === 'host'
        ? this.collectInvocations(registration, reachable).sort((left, right) => left.id.localeCompare(right.id))
        : [],
    }
  }

  private collectExports(registration: PackageRegistration): ExportRecord[] {
    const targets = packageExportTargets(registration.manifest)
      .filter(([subpath]) => registration.exportSubpaths === undefined
        || registration.exportSubpaths.includes(subpath))
    const records: ExportRecord[] = []
    for (const [subpath, target] of targets) {
      if (target.includes('*') || subpath === './package.json'
        || subpath === './typert' || subpath === './client/typert' || subpath === './remote'
        // Data exports (bundle patch lists, JSON manifests) carry no TypeScript API.
        || target.endsWith('.json') || target.endsWith('.yml') || target.endsWith('.yaml')) continue
      const sourcePath = sourcePathForExport(registration.root, target)
      const sourceFile = this.sourceFiles.get(realPath(sourcePath))
      if (sourceFile === undefined) {
        throw new TypertAnalysisError(
          `typert(${this.face}): ${registration.name} export ${subpath} resolves to missing source ${sourcePath}`,
        )
      }
      const moduleSymbol = this.checker.getSymbolAtLocation(sourceFile)
      if (moduleSymbol === undefined) continue
      for (const exported of this.checker.getExportsOfModule(moduleSymbol)) {
        const symbol = this.resolveSymbol(exported)
        const declaration = preferredDeclaration(symbol) as ts.Declaration
        const aliases = exported === symbol || exported.name === symbol.name
          ? [exported.name]
          : [exported.name, symbol.name]
        records.push({
          model: {
            subpath,
            name: exported.name,
            symbol: this.symbolId(symbol),
            aliases,
          },
          symbol,
          declaration,
          sourceFile,
        })
      }
    }
    const unique = uniqueBy(records, record => `${record.model.subpath}\0${record.model.name}`)
    this.collectCrossFaceReExports(registration, unique)
    return unique
  }

  private collectCrossFaceReExports(
    registration: PackageRegistration,
    records: readonly ExportRecord[],
  ): void {
    const publicSymbols = new Set(records.map(record => record.symbol))
    const entryFiles = uniqueBy(records, record => record.sourceFile.fileName).map(record => record.sourceFile)
    for (const sourceFile of this.reachableFiles(registration, entryFiles)) {
      for (const statement of sourceFile.statements) {
        if (!ts.isExportDeclaration(statement)
          || statement.moduleSpecifier === undefined
          || !ts.isStringLiteral(statement.moduleSpecifier)) continue
        const module = moduleIdentity(statement.moduleSpecifier.text)
        if (module === undefined) continue
        const toFace = this.allRegistrations
          .find(candidate => candidate.name === module.package && candidate.face !== this.face)?.face
        if (toFace === undefined) continue

        if (statement.exportClause !== undefined && ts.isNamespaceExport(statement.exportClause)) {
          const namespace = this.resolveSymbol(
            this.checker.getSymbolAtLocation(statement.exportClause.name) as ts.Symbol,
          )
          if (publicSymbols.has(namespace)) {
            this.fail(statement.exportClause, 'cross-face namespace re-exports are not supported')
          }
          continue
        }

        const exports = statement.exportClause === undefined
          ? this.moduleExports(statement.moduleSpecifier)
            .map(symbol => ({ symbol: this.resolveSymbol(symbol), requestedName: symbol.name, site: statement }))
          : statement.exportClause.elements.map(element => ({
            symbol: this.resolveSymbol(this.checker.getSymbolAtLocation(element.name) as ts.Symbol),
            requestedName: element.propertyName?.text ?? element.name.text,
            site: element,
          }))
        for (const exported of exports) {
          if (!publicSymbols.has(exported.symbol)) continue
          const name = this.packageExportName(module, exported.symbol, toFace, exported.requestedName)
          if (name === undefined) {
            this.fail(
              exported.site,
              `cross-face re-export ${exported.requestedName} is not exported by ${module.package} at ${module.subpath}`,
            )
          }
          this.recordCrossFaceLink(registration.name, toFace, module, name)
        }
      }
    }
  }

  private moduleExports(moduleSpecifier: ts.StringLiteral): ts.Symbol[] {
    /* v8 ignore next -- a semantically valid export declaration from a resolved module always has a module symbol. */
    const moduleSymbol = this.checker.getSymbolAtLocation(moduleSpecifier) as ts.Symbol
    return this.checker.getExportsOfModule(moduleSymbol)
  }

  private reachableFiles(
    registration: PackageRegistration,
    entryFiles: readonly ts.SourceFile[],
  ): ts.SourceFile[] {
    const reachable = new Map<string, ts.SourceFile>()
    const queue = [...entryFiles]
    while (queue.length > 0) {
      const sourceFile = queue.shift() as ts.SourceFile
      const fileName = realPath(sourceFile.fileName)
      if (reachable.has(fileName) || !isWithin(fileName, registration.root)) continue
      reachable.set(fileName, sourceFile)
      for (const statement of sourceFile.statements) {
        if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement))
          || statement.moduleSpecifier === undefined
          || !ts.isStringLiteral(statement.moduleSpecifier)) continue
        const resolvedPath = this.resolveImport(statement.moduleSpecifier.text, sourceFile.fileName)
        if (resolvedPath === undefined || !isWithin(resolvedPath, registration.root)) continue
        queue.push(this.sourceFiles.get(resolvedPath) as ts.SourceFile)
      }
    }
    return [...reachable.values()].sort((left, right) => left.fileName.localeCompare(right.fileName))
  }

  private resolveImport(specifier: string, fromFile: string): string | undefined {
    const resolved = ts.resolveModuleName(
      specifier,
      fromFile,
      this.program.getCompilerOptions(),
      this.host,
      this.host.getModuleResolutionCache?.(),
    ).resolvedModule
    return resolved === undefined ? undefined : realPath(resolved.resolvedFileName)
  }

  /**
   * Follow the import that names `symbol` at `site` through modules of the
   * referencing package until a package specifier appears. Each forwarding
   * module and requested export name pair is entered once; its explicit export
   * edges are tried before its star edges. A relative specifier that resolves
   * outside `from`, a namespace hop, or a module with no edge leading to a
   * package specifier yields undefined.
   */
  private packageImportOf(
    site: ReferenceSite,
    moduleSpecifier: string,
    symbol: ts.Symbol,
    from: PackageRegistration,
  ): PackageImport | undefined {
    const visited = new Map<string, Set<string>>()
    const walk = (sourceFile: ts.SourceFile, specifier: string, name: string): PackageImport | undefined => {
      const module = moduleIdentity(specifier)
      if (module !== undefined) return { module, name }
      const resolvedPath = this.resolveImport(specifier, sourceFile.fileName)
      if (resolvedPath === undefined || !isWithin(resolvedPath, from.root)) return undefined
      const names = visited.get(resolvedPath)
      if (names?.has(name)) return undefined
      if (names === undefined) visited.set(resolvedPath, new Set([name]))
      else names.add(name)
      const forward = this.sourceFiles.get(resolvedPath) as ts.SourceFile
      for (const edge of this.forwardedExports(forward, name, symbol)) {
        const found = walk(forward, edge.specifier, edge.name)
        if (found !== undefined) return found
      }
      return undefined
    }
    return walk(site.getSourceFile(), moduleSpecifier, authoredExportName(site, moduleSpecifier))
  }

  /** Export edges of `sourceFile` that carry `name`: explicit edges in source order, then star edges exporting `symbol`. */
  private forwardedExports(sourceFile: ts.SourceFile, name: string, symbol: ts.Symbol): ForwardedExport[] {
    const explicit: ForwardedExport[] = []
    const stars: ForwardedExport[] = []
    for (const statement of sourceFile.statements) {
      if (!ts.isExportDeclaration(statement)
        || (statement.exportClause === undefined && statement.moduleSpecifier === undefined)
        || (statement.exportClause !== undefined && ts.isNamespaceExport(statement.exportClause))) continue
      if (statement.exportClause === undefined) {
        const specifier = (statement.moduleSpecifier as ts.StringLiteral).text
        const exported = this.moduleExports(statement.moduleSpecifier as ts.StringLiteral)
          .find(candidate => candidate.name === name && this.resolveSymbol(candidate) === symbol)
        if (exported !== undefined) stars.push({ specifier, name })
        continue
      }
      const element = statement.exportClause.elements.find(candidate => candidate.name.text === name)
      if (element === undefined) continue
      if (statement.moduleSpecifier !== undefined) {
        explicit.push({ specifier: (statement.moduleSpecifier as ts.StringLiteral).text, name: element.propertyName?.text ?? name })
        continue
      }
      const binding = importBindingOf(sourceFile, element.propertyName?.text ?? name)
      if (binding?.name !== undefined) explicit.push({ specifier: binding.specifier, name: binding.name })
    }
    return [...explicit, ...stars]
  }

  private collectServices(
    context: ts.InterfaceDeclaration,
    records: readonly ExportRecord[],
  ): ServiceModel[] {
    const bySymbol = new Map<SymbolId, ExportRecord[]>()
    for (const record of records) {
      const id = this.symbolId(record.symbol)
      const matches = bySymbol.get(id) ?? []
      matches.push(record)
      bySymbol.set(id, matches)
    }
    const result: ServiceModel[] = []
    for (const member of context.members) {
      if (!ts.isPropertySignature(member) || member.type === undefined) continue
      // An OPTIONAL key is not a service: `X | undefined` and `key?: X` both mark
      // a value the launcher or boot code installs before the tree mounts (a root
      // accessor, an environment snapshot), which no plugin provides and no
      // consumer can reach with `inject`. Describing one as a service would answer
      // "add the plugin that provides it" for a key where no such plugin exists.
      if (member.questionToken !== undefined
        || (ts.isUnionTypeNode(member.type)
          && member.type.types.some(node => node.kind === ts.SyntaxKind.UndefinedKeyword))) continue
      const authoredSymbol = this.symbolAtType(member.type)
      if (authoredSymbol === undefined) continue
      const authoredSymbolId = this.symbolId(authoredSymbol)
      const exported = bySymbol.get(authoredSymbolId)?.find(record => record.model.name === authoredSymbol.name)
        ?? bySymbol.get(authoredSymbolId)?.find(record => record.model.name !== 'default')
        ?? bySymbol.get(authoredSymbolId)?.[0]
      if (exported === undefined) continue
      let symbol = authoredSymbol
      let declaration = preferredDeclaration(symbol)
      const aliases = new Set<ts.Symbol>()
      while (declaration !== undefined && ts.isTypeAliasDeclaration(declaration)) {
        if (aliases.has(symbol)) break
        aliases.add(symbol)
        const target = this.symbolAtType(declaration.type)
        if (target === undefined) break
        symbol = target
        declaration = preferredDeclaration(symbol)
      }
      if (declaration === undefined || (!ts.isClassDeclaration(declaration) && !ts.isInterfaceDeclaration(declaration))) {
        this.fail(member, `service ${memberName(member.name)} does not resolve to an exported class or interface`)
      }
      const memberOwner = this.registrationForFile(member.getSourceFile().fileName)
      const declarationOwner = this.registrationForFile(declaration.getSourceFile().fileName)
      if (memberOwner?.name !== declarationOwner?.name) continue
      const symbolId = this.symbolId(symbol)
      const model = this.ensureDeclaration(symbol, declaration)
      const exposed = model.members
        .filter(exposableMember)
        .map(publicMember => publicMember.id)
      result.push({
        ...documentationOf(declaration),
        key: memberName(member.name),
        symbol: symbolId,
        export: exported.model,
        members: exposed,
        location: this.location(member),
      })
    }
    return result
  }

  private collectExplicitServices(records: readonly ExportRecord[]): ServiceModel[] {
    const result: ServiceModel[] = []
    const seen = new Set<SymbolId>()
    for (const record of records) {
      const tag = typertServiceTag(record.declaration)
      if (tag === undefined) continue
      const words = (ts.getTextOfJSDocComment(tag.comment) ?? '').trim().split(/\s+/)
      if (words.length !== 2 || !isRemoteSegment(words[1] ?? '')) {
        this.fail(tag, '@typert service requires exactly one nonempty Cordis service key without "/"')
      }
      if (!ts.isClassDeclaration(record.declaration)) {
        this.fail(record.declaration, '@typert service requires an exported class')
      }
      const symbol = this.resolveSymbol(record.symbol)
      const symbolId = this.symbolId(symbol)
      if (seen.has(symbolId)) continue
      seen.add(symbolId)
      const model = this.ensureDeclaration(symbol, record.declaration)
      result.push({
        ...documentationOf(record.declaration),
        key: words[1] as string,
        symbol: symbolId,
        export: record.model,
        members: model.members.filter(exposableMember).map(member => member.id),
        location: this.location(record.declaration),
      })
    }
    return result
  }

  private collectInvocations(
    registration: PackageRegistration,
    reachable: readonly ts.SourceFile[],
  ): InvocationModel[] {
    const result: InvocationModel[] = []
    for (const sourceFile of reachable) {
      for (const statement of sourceFile.statements) {
        if (!ts.isClassDeclaration(statement)) continue
        const marked = statement.members.flatMap((member) => {
          const invocation = this.remoteMarker(member)
          if (invocation === undefined) return []
          if (!ts.isMethodDeclaration(member)) {
            this.fail(member, 'Remote decorators require a public instance method')
          }
          return [{ method: member, invocation }]
        })
        const first = marked[0]
        if (first === undefined) continue
        const binding = this.gatewayBinding(statement)
        if (binding === undefined) {
          this.fail(
            first.method,
            'Remote methods require TypertRemoteService or readonly typertGateway = bindTypertRemote(this, serviceKey)',
          )
        }
        for (const { method, invocation } of marked) {
          result.push(this.invocationModel(registration, binding, method, invocation))
        }
      }
    }
    return result
  }

  private invocationModel(
    registration: PackageRegistration,
    binding: GatewayBinding,
    method: ts.MethodDeclaration,
    invocation:
      | { readonly kind: 'direct'; readonly exportName?: string; readonly mode?: 'stream' }
      | { readonly kind: 'context'; readonly context: string; readonly exportName?: string },
  ): InvocationModel {
    if (visibilityOf(method) !== 'public' || hasModifier(method, ts.SyntaxKind.StaticKeyword)) {
      this.fail(method, 'Remote decorators require a public instance method')
    }
    if (hasModifier(method, ts.SyntaxKind.AbstractKeyword) || method.body === undefined) {
      this.fail(method, 'Remote methods must have a concrete implementation')
    }
    if (!ts.isIdentifier(method.name)) {
      this.fail(method, 'Remote method names must be identifiers')
    }
    if ((method.typeParameters?.length ?? 0) > 0) {
      this.fail(method, 'generic Remote methods are not supported')
    }
    const methodName = method.name.text
    const exportedMethod = invocation.exportName ?? methodName

    const lookups = this.lookupDeclarations()
    const lookupByHost = new Map(lookups.map(lookup => [lookup.hostSymbol, lookup]))
    const parameters: InvocationParameterModel[] = []
    let cancellation: InvocationModel['cancellation']
    const wires = new Set<string>()
    for (const [parameterIndex, parameter] of method.parameters.entries()) {
      if (!ts.isIdentifier(parameter.name)) {
        this.fail(parameter, 'Remote parameters must use identifier bindings')
      }
      if (parameter.dotDotDotToken !== undefined) this.fail(parameter, 'Remote parameters cannot be rest parameters')
      if (parameter.initializer !== undefined) this.fail(parameter, 'Remote parameters cannot have default values')
      if (parameter.name.text === 'this') this.fail(parameter, 'Remote methods cannot declare an explicit this parameter')
      const optional = parameter.questionToken !== undefined
      const authoredType = this.requiredType(parameter, parameter.type, 'parameter')
      const cancellationName = parameter.name.text === 'signal'
      const cancellationType = this.isGlobalAbortSignal(authoredType)
      if (cancellationName || cancellationType) {
        if (!cancellationName || !cancellationType) {
          this.fail(parameter, 'Remote cancellation must use a parameter named signal with the global AbortSignal type')
        }
        if (parameterIndex !== method.parameters.length - 1) {
          this.fail(parameter, 'Remote cancellation signal must be the final parameter')
        }
        cancellation = { parameter: 'signal' }
        continue
      }
      const hostSymbol = this.symbolAtType(authoredType)
      const lookup = hostSymbol === undefined ? undefined : lookupByHost.get(this.symbolId(hostSymbol))
      let modeled: InvocationParameterModel
      if (lookup !== undefined) {
        if (optional) this.fail(parameter, `lookup parameter for ${lookup.key} cannot be optional`)
        if (parameter.name.text !== lookup.key) {
          this.fail(parameter, `lookup parameter for ${lookup.key} must also be named ${lookup.key}`)
        }
        const boundary = this.remoteBoundary(
          lookup.wireType,
          `${registration.name}#${binding.namespace}/${exportedMethod}:${lookup.key}Id`,
          true,
        )
        modeled = {
          name: parameter.name.text,
          wire: `${lookup.key}Id`,
          source: 'lookup',
          lookup: lookup.key,
          boundary,
        }
      } else {
        if (hostSymbol !== undefined && this.isWorkspaceClass(hostSymbol)) {
          this.fail(parameter, `non-JSON class parameter ${hostSymbol.name} requires a TypertLookupMap entry`)
        }
        modeled = {
          name: parameter.name.text,
          wire: parameter.name.text,
          source: 'json',
          ...optional ? { optional: true as const } : {},
          boundary: this.remoteBoundary(
            authoredType,
            `${registration.name}#${binding.namespace}/${exportedMethod}:${parameter.name.text}`,
            false,
            'undefined',
            optional,
          ),
        }
      }
      if (wires.has(modeled.wire)) this.fail(parameter, `duplicate Remote wire field ${modeled.wire}`)
      wires.add(modeled.wire)
      parameters.push(modeled)
    }

    let receiver: InvocationModel['invocation'] = { kind: 'direct' }
    if (invocation.kind === 'context') {
      const context = this.contextDeclarations().get(invocation.context)
      if (context === undefined) {
        this.fail(method, `Remote Scope ${invocation.context} has no TypertContextMap entry`)
      }
      const wire = `${invocation.context}Id`
      if (wires.has(wire)) this.fail(method, `Remote Scope wire field ${wire} conflicts with a method parameter`)
      receiver = {
        kind: 'context',
        context: invocation.context,
        wire,
        boundary: this.remoteBoundary(
          context.wireType,
          `${registration.name}#${binding.namespace}/${exportedMethod}:${wire}`,
          true,
        ),
      }
    }

    let scope: InvocationModel['scope']
    if (invocation.kind === 'direct') {
      const lookupParameters = parameters.filter(parameter => parameter.source === 'lookup')
      const parameter = lookupParameters.length === 1 ? lookupParameters[0] : undefined
      const context = parameter?.lookup === undefined
        ? undefined
        : this.contextDeclarations().get(parameter.lookup)
      if (parameter !== undefined && context !== undefined) {
        const contextBoundary = this.remoteBoundary(
          context.wireType,
          `${registration.name}#${binding.namespace}/${exportedMethod}:scope:${context.key}`,
          true,
        )
        if (contextBoundary.typeSymbol !== parameter.boundary.typeSymbol) {
          this.fail(
            method,
            `Remote scope ${context.key} wire type ${contextBoundary.typeSymbol} does not match lookup wire type ${parameter.boundary.typeSymbol}`,
          )
        }
        scope = { context: context.key, wire: parameter.wire }
      }
    }

    const mode = invocation.kind === 'direct' ? invocation.mode : undefined
    const resultType = this.remoteResultType(method, mode)
    return {
      id: `${registration.name}#${binding.namespace}/${exportedMethod}`,
      service: binding.service,
      namespace: binding.namespace,
      method: exportedMethod,
      ...(exportedMethod === methodName ? {} : { implementation: methodName }),
      ...(mode === undefined ? {} : { mode }),
      invocation: receiver,
      ...(scope === undefined ? {} : { scope }),
      parameters,
      ...(cancellation === undefined ? {} : { cancellation }),
      result: this.remoteBoundary(
        resultType,
        `${registration.name}#${binding.namespace}/${exportedMethod}:result`,
        false,
        'undefined-or-void',
      ),
      location: this.location(method.name),
    }
  }

  private gatewayBinding(declaration: ts.ClassDeclaration): GatewayBinding | undefined {
    const field = this.gatewayFieldBinding(declaration)
    const base = this.gatewayServiceBinding(declaration)
    if (field !== undefined && base !== undefined) {
      this.fail(field.site, 'TypertRemoteService subclasses must not declare a second typertRemote binding')
    }
    return field ?? base
  }

  private gatewayFieldBinding(declaration: ts.ClassDeclaration): GatewayBinding | undefined {
    const candidates = declaration.members.filter((member): member is ts.PropertyDeclaration =>
      ts.isPropertyDeclaration(member) && memberName(member.name) === 'typertRemote')
    const [property, duplicate] = candidates
    if (property === undefined) return undefined
    if (duplicate !== undefined) this.fail(duplicate, 'Service has more than one typertGateway field')
    if (visibilityOf(property) !== 'public'
      || hasModifier(property, ts.SyntaxKind.StaticKeyword)
      || !hasModifier(property, ts.SyntaxKind.ReadonlyKeyword)) {
      this.fail(property, 'typertGateway must be a public readonly instance field')
    }
    if (property.initializer === undefined
      || !ts.isCallExpression(property.initializer)
      || !this.isTypeMetaSymbol(property.initializer.expression, 'bindTypertRemote')) {
      this.fail(property, 'typertGateway must call bindTypertRemote()')
    }
    const call = property.initializer
    if (call.arguments.length < 2 || call.arguments.length > 3) {
      this.fail(call, 'bindTypertRemote() requires this, service key, and an optional options object')
    }
    if (call.arguments[0]?.kind !== ts.SyntaxKind.ThisKeyword) {
      this.fail(call.arguments[0] ?? call, 'bindTypertRemote() first argument must be this')
    }
    return this.gatewayBindingArguments(call, property)
  }

  private gatewayServiceBinding(declaration: ts.ClassDeclaration): GatewayBinding | undefined {
    const heritage = (declaration.heritageClauses ?? [])
      .filter(clause => clause.token === ts.SyntaxKind.ExtendsKeyword)
      .flatMap(clause => [...clause.types])
      .find(type => this.isTypeMetaSymbol(type.expression, 'TypertRemoteService'))
    if (heritage === undefined) return undefined

    const constructor = declaration.members.find(ts.isConstructorDeclaration)
    if (constructor?.body === undefined) {
      this.fail(heritage, 'TypertRemoteService subclasses must declare a constructor with super(ctx, serviceKey)')
    }
    const call = constructor.body.statements.flatMap((statement) => {
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return []
      return statement.expression.expression.kind === ts.SyntaxKind.SuperKeyword ? [statement.expression] : []
    })[0]
    if (call === undefined) {
      this.fail(constructor, 'TypertRemoteService constructor must call super(ctx, serviceKey) directly')
    }
    if (call.arguments.length < 2 || call.arguments.length > 3) {
      this.fail(call, 'TypertRemoteService super() requires context, service key, and an optional options object')
    }
    return this.gatewayBindingArguments(call, heritage)
  }

  private gatewayBindingArguments(call: ts.CallExpression, site: ts.Node): GatewayBinding {
    const serviceArgument = call.arguments[1]
    if (serviceArgument === undefined) this.fail(call, 'Gateway service key must be a string literal')
    const service = stringLiteralValue(serviceArgument)
    if (service === undefined) this.fail(serviceArgument, 'Gateway service key must be a string literal')
    let namespace = service
    const options = call.arguments[2]
    if (options !== undefined) {
      if (!ts.isObjectLiteralExpression(options)) {
        this.fail(options, 'bindTypertRemote() options must be an object literal')
      }
      for (const propertyOption of options.properties) {
        if (!ts.isPropertyAssignment(propertyOption)
          || memberName(propertyOption.name) !== 'namespace') {
          this.fail(propertyOption, 'bindTypertRemote() only supports a namespace option')
        }
        const value = stringLiteralValue(propertyOption.initializer)
        if (value === undefined) this.fail(propertyOption.initializer, 'Gateway namespace must be a string literal')
        namespace = value
      }
    }
    if (!isRemoteSegment(service)) this.fail(serviceArgument, 'Gateway service key must contain only RPC endpoint segment characters')
    if (!isRemoteSegment(namespace)) this.fail(options ?? call, 'Gateway namespace must contain only RPC endpoint segment characters')
    return { service, namespace, site }
  }

  private remoteMarker(
    member: ts.ClassElement,
  ):
    | { readonly kind: 'direct'; readonly exportName?: string; readonly mode?: 'stream' }
    | { readonly kind: 'context'; readonly context: string; readonly exportName?: string }
    | undefined {
    let found:
      | { readonly kind: 'direct'; readonly exportName?: string; readonly mode?: 'stream' }
      | { readonly kind: 'context'; readonly context: string; readonly exportName?: string }
      | undefined
    for (const decorator of ts.canHaveDecorators(member) ? ts.getDecorators(member) ?? [] : []) {
      const expression = decorator.expression
      let marker: typeof found
      if (this.isTypeMetaSymbol(expression, 'Remote')) {
        marker = { kind: 'direct' }
      } else if (ts.isCallExpression(expression)
        && this.isTypeMetaSymbol(expression.expression, 'Remote')) {
        if (expression.arguments.length !== 1) this.fail(expression, 'Remote() requires one name or options object')
        const argument = expression.arguments[0]
        if (argument === undefined) this.fail(expression, 'Remote() requires one name or options object')
        const exportName = stringLiteralValue(argument)
        if (exportName !== undefined) {
          if (!isRemoteSegment(exportName)) {
            this.fail(argument, 'Remote() name must contain only RPC endpoint segment characters')
          }
          marker = { kind: 'direct', exportName }
        } else {
          if (!ts.isObjectLiteralExpression(argument) || argument.properties.length !== 1) {
            this.fail(argument, 'Remote() options must contain exactly mode: "stream"')
          }
          const [property] = argument.properties
          if (property === undefined) this.fail(argument, 'Remote() options must contain exactly mode: "stream"')
          if (!ts.isPropertyAssignment(property)
            || memberName(property.name) !== 'mode'
            || stringLiteralValue(property.initializer) !== 'stream') {
            this.fail(property, 'Remote() options must contain exactly mode: "stream"')
          }
          marker = { kind: 'direct', mode: 'stream' }
        }
      } else if (ts.isCallExpression(expression)
        && this.isTypeMetaSymbol(expression.expression, 'RemoteScope')) {
        if (expression.arguments.length < 1 || expression.arguments.length > 2) {
          this.fail(expression, 'RemoteScope() requires a Context key and optional exported method name')
        }
        const context = stringLiteralValue(expression.arguments[0])
        if (context === undefined || !isRemoteSegment(context)) {
          this.fail(expression.arguments[0] ?? expression, 'RemoteScope() key must be a string literal containing only RPC endpoint segment characters')
        }
        const exportArgument = expression.arguments[1]
        const exportName = exportArgument === undefined ? undefined : stringLiteralValue(exportArgument)
        if (exportArgument !== undefined && (exportName === undefined || !isRemoteSegment(exportName))) {
          this.fail(exportArgument, 'RemoteScope() name must be a string literal containing only RPC endpoint segment characters')
        }
        marker = { kind: 'context', context, ...exportName === undefined ? {} : { exportName } }
      } else {
        continue
      }
      if (found !== undefined) this.fail(decorator, 'a method can have only one Remote invocation decorator')
      found = marker
    }
    return found
  }

  private remoteResultType(method: ts.MethodDeclaration, mode?: 'stream'): ts.TypeNode {
    const authored = this.requiredType(method, method.type, 'return')
    if (ts.isTypeReferenceNode(authored)) {
      const symbol = this.checker.getSymbolAtLocation(authored.typeName)
      const resolved = symbol === undefined ? undefined : this.resolveSymbol(symbol)
      const resultType = authored.typeArguments?.[0]
      const wrappers = mode === 'stream' ? ['Iterable', 'AsyncIterable'] : ['Promise']
      const declaration = resolved === undefined ? undefined : preferredDeclaration(resolved)
      if (resolved !== undefined
        && wrappers.includes(resolved.name)
        && resultType !== undefined
        && authored.typeArguments?.length === 1
        && declaration !== undefined
        && isStandardLibraryFile(declaration.getSourceFile().fileName)) {
        return resultType
      }
    }
    if (mode === 'stream') {
      this.fail(method, 'stream Remote methods must return Iterable<T> or AsyncIterable<T>')
    }
    return authored
  }

  private isGlobalAbortSignal(type: ts.TypeNode): boolean {
    const symbol = this.symbolAtType(type)
    if (symbol?.name !== 'AbortSignal') return false
    return symbol.declarations?.some(declaration =>
      isStandardLibraryFile(declaration.getSourceFile().fileName)) === true
  }

  private lookupDeclarations(): readonly StaticLookupDeclaration[] {
    if (this.staticLookups !== undefined) return this.staticLookups
    const byKey = new Map<string, StaticLookupDeclaration>()
    const byHost = new Map<SymbolId, StaticLookupDeclaration>()
    for (const declaration of this.typeMetaMapMembers('TypertLookupMap')) {
      if (!ts.isPropertySignature(declaration) || declaration.type === undefined) {
        this.fail(declaration, 'TypertLookupMap entries must be required properties')
      }
      const key = memberName(declaration.name)
      if (!isRemoteSegment(key)) this.fail(declaration.name, 'TypertLookupMap key must contain only RPC endpoint segment characters')
      if (!ts.isTypeReferenceNode(declaration.type)
        || !this.isTypeMetaSymbol(declaration.type.typeName, 'TypertLookup')
        || declaration.type.typeArguments?.length !== 2) {
        this.fail(declaration.type, 'TypertLookupMap values must be TypertLookup<Host, Wire>')
      }
      const hostType = declaration.type.typeArguments[0]
      const wireType = declaration.type.typeArguments[1]
      if (hostType === undefined || wireType === undefined) {
        this.fail(declaration.type, 'TypertLookupMap values must be TypertLookup<Host, Wire>')
      }
      const host = this.symbolAtType(hostType)
      if (host === undefined) this.fail(hostType, 'TypertLookup Host must be a named type')
      const entry: StaticLookupDeclaration = {
        key,
        hostSymbol: this.symbolId(host),
        wireType,
        site: declaration,
      }
      if (byKey.has(key)) this.fail(declaration, `duplicate TypertLookupMap key ${key}`)
      if (byHost.has(entry.hostSymbol)) this.fail(declaration, `Host type ${host.name} has more than one Typert lookup`)
      byKey.set(key, entry)
      byHost.set(entry.hostSymbol, entry)
    }
    this.staticLookups = [...byKey.values()]
    return this.staticLookups
  }

  private contextDeclarations(): ReadonlyMap<string, StaticContextDeclaration> {
    if (this.staticContexts !== undefined) return this.staticContexts
    const result = new Map<string, StaticContextDeclaration>()
    for (const declaration of this.typeMetaMapMembers('TypertContextMap')) {
      if (!ts.isPropertySignature(declaration) || declaration.type === undefined) {
        this.fail(declaration, 'TypertContextMap entries must be required properties')
      }
      const key = memberName(declaration.name)
      if (!isRemoteSegment(key)) this.fail(declaration.name, 'TypertContextMap key must contain only RPC endpoint segment characters')
      if (!ts.isTypeReferenceNode(declaration.type)
        || !this.isTypeMetaSymbol(declaration.type.typeName, 'TypertContext')
        || declaration.type.typeArguments?.length !== 1) {
        this.fail(declaration.type, 'TypertContextMap values must be TypertContext<Wire>')
      }
      if (result.has(key)) this.fail(declaration, `duplicate TypertContextMap key ${key}`)
      const wireType = declaration.type.typeArguments[0]
      if (wireType === undefined) this.fail(declaration.type, 'TypertContextMap values must be TypertContext<Wire>')
      result.set(key, {
        key,
        wireType,
        site: declaration,
      })
    }
    this.staticContexts = result
    return result
  }

  private typeMetaMapMembers(name: 'TypertLookupMap' | 'TypertContextMap'): ts.TypeElement[] {
    const result: ts.TypeElement[] = []
    for (const sourceFile of this.program.getSourceFiles()) {
      for (const statement of sourceFile.statements) {
        if (!ts.isModuleDeclaration(statement)
          || !ts.isStringLiteral(statement.name)
          || statement.name.text !== '@deepseek-ai/dsh-typert-protocol'
          || statement.body === undefined
          || !ts.isModuleBlock(statement.body)) continue
        for (const nested of statement.body.statements) {
          if (ts.isInterfaceDeclaration(nested) && nested.name.text === name) result.push(...nested.members)
        }
      }
    }
    return result
  }

  private remoteBoundary(
    authoredType: ts.TypeNode,
    fallbackTypeSymbol: string,
    requireNamed: boolean,
    topLevelAbsence: 'reject' | 'undefined' | 'undefined-or-void' = 'reject',
    optional = false,
  ): RemoteBoundaryModel {
    const type = this.convertType(authoredType)
    const declaredType = this.checker.getTypeFromTypeNode(authoredType)
    // An optional parameter's authored node carries no `undefined`; the codec
    // still has to accept the omitted wire field the consumer sends.
    const resolvedType = optional
      ? this.checker.getNullableType(declaredType, ts.TypeFlags.Undefined)
      : declaredType
    const codecType = this.resolvedRemoteCodecType(authoredType, resolvedType, topLevelAbsence)
    const acceptsUndefined = topLevelAbsence !== 'reject' && this.includesRemoteAbsence(resolvedType)
    const rootSymbol = this.namedWorkspaceType(authoredType)
    const imports = new Map<SymbolId, RemoteTypeImportModel>()
    const visit = (node: ts.Node): void => {
      if ((ts.isTypeReferenceNode(node) || ts.isImportTypeNode(node))) {
        const symbol = ts.isTypeReferenceNode(node)
          ? this.checker.getSymbolAtLocation(node.typeName)
          : node.qualifier === undefined ? undefined : this.checker.getSymbolAtLocation(node.qualifier)
        if (symbol !== undefined) {
          const resolved = this.resolveSymbol(symbol)
          const declaration = preferredDeclaration(resolved)
          if (declaration !== undefined
            && !isStandardLibraryFile(declaration.getSourceFile().fileName)
            && this.registrationForFile(declaration.getSourceFile().fileName) !== undefined) {
            const imported = this.publicRemoteType(resolved, node)
            imports.set(imported.symbol, imported)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(authoredType)
    if (rootSymbol !== undefined) {
      const imported = this.publicRemoteType(rootSymbol, authoredType)
      return {
        type,
        codecType,
        acceptsUndefined,
        typeSymbol: `${imported.specifier}#${imported.name}`,
        imports: [...imports.values()].sort((left, right) =>
          left.specifier.localeCompare(right.specifier) || left.name.localeCompare(right.name)),
      }
    }
    if (requireNamed) this.fail(authoredType, 'lookup and Context wire types must be named public types')
    return {
      type,
      codecType,
      acceptsUndefined,
      typeSymbol: fallbackTypeSymbol,
      imports: [...imports.values()].sort((left, right) =>
        left.specifier.localeCompare(right.specifier) || left.name.localeCompare(right.name)),
    }
  }

  /**
   * Project one authored Remote boundary through the complete face Program.
   * Consumer declarations retain the authored alias, while codecs use this
   * concrete graph so declaration-merged mapped and conditional types are
   * validated without teaching the compiler-independent emitter TypeScript's
   * type evaluator.
   */
  private resolvedRemoteCodecType(
    authoredType: ts.TypeNode,
    resolvedType: ts.Type,
    topLevelAbsence: 'reject' | 'undefined' | 'undefined-or-void',
  ): TypeNodeId {
    this.assertRemoteJsonType(
      resolvedType,
      authoredType,
      new Set(),
      topLevelAbsence !== 'reject',
      topLevelAbsence === 'undefined-or-void',
    )
    const completed = new Map<ts.Type, TypeNodeId>()
    const active = new Map<ts.Type, TypeNodeId>()
    const recursiveDeclarations = new Map<ts.Type, SymbolId>()
    const convert = (type: ts.Type): TypeNodeId => {
      const cached = completed.get(type)
      if (cached !== undefined) return cached
      const activeId = active.get(type)
      if (activeId !== undefined) {
        if (this.checker.isArrayType(type) || this.checker.isArrayLikeType(type)) {
          const element = this.checker.getIndexTypeOfType(type, ts.IndexKind.Number)
          const elementId = element === undefined ? undefined : active.get(element)
          if (element !== undefined && elementId !== undefined) {
            return this.addNode(authoredType, {
              kind: 'array',
              element: this.resolvedCycleReference(
                element,
                authoredType,
                elementId,
                recursiveDeclarations,
              ),
            })
          }
        }
        return this.resolvedCycleReference(type, authoredType, activeId, recursiveDeclarations)
      }
      const id = this.allocateNodeId(authoredType)
      active.set(type, id)
      try {
        const add = (model: TypeNodeInput): TypeNodeId => {
          this.nodes.set(id, { id, ...model })
          completed.set(type, id)
          return id
        }
        const flags = type.flags
        if ((flags & ts.TypeFlags.Any) !== 0) return add({ kind: 'keyword', name: 'any' })
        if ((flags & ts.TypeFlags.Unknown) !== 0) return add({ kind: 'keyword', name: 'unknown' })
        if ((flags & ts.TypeFlags.Never) !== 0) return add({ kind: 'keyword', name: 'never' })
        if ((flags & ts.TypeFlags.String) !== 0) return add({ kind: 'keyword', name: 'string' })
        if ((flags & ts.TypeFlags.Number) !== 0) return add({ kind: 'keyword', name: 'number' })
        if ((flags & ts.TypeFlags.BigInt) !== 0) return add({ kind: 'keyword', name: 'bigint' })
        if ((flags & ts.TypeFlags.Boolean) !== 0) return add({ kind: 'keyword', name: 'boolean' })
        if ((flags & ts.TypeFlags.ESSymbol) !== 0) return add({ kind: 'keyword', name: 'symbol' })
        if ((flags & ts.TypeFlags.Undefined) !== 0) return add({ kind: 'keyword', name: 'undefined' })
        if ((flags & ts.TypeFlags.Void) !== 0) return add({ kind: 'keyword', name: 'void' })
        if ((flags & ts.TypeFlags.Null) !== 0) return add({ kind: 'literal', value: null, text: 'null' })
        if ((flags & ts.TypeFlags.StringLiteral) !== 0) {
          const value = (type as ts.StringLiteralType).value
          return add({ kind: 'literal', value, text: JSON.stringify(value) })
        }
        if ((flags & ts.TypeFlags.NumberLiteral) !== 0) {
          const value = (type as ts.NumberLiteralType).value
          return add({ kind: 'literal', value, text: String(value) })
        }
        if ((flags & ts.TypeFlags.BigIntLiteral) !== 0) {
          const value = (type as ts.BigIntLiteralType).value
          const text = `${value.negative ? '-' : ''}${value.base10Value}n`
          return add({ kind: 'literal', value: BigInt(`${value.negative ? '-' : ''}${value.base10Value}`), text })
        }
        if ((flags & ts.TypeFlags.BooleanLiteral) !== 0) {
          const value = (type as ts.Type & { readonly intrinsicName?: string }).intrinsicName === 'true'
          return add({ kind: 'literal', value, text: String(value) })
        }
        if (type.isUnionOrIntersection()) {
          return add({
            kind: (flags & ts.TypeFlags.Union) !== 0 ? 'union' : 'intersection',
            types: type.types.map(convert),
          })
        }
        if ((flags & ts.TypeFlags.TypeParameter) !== 0) {
          this.fail(authoredType, 'Remote codec contains an unresolved type parameter')
        }
        if ((flags & ts.TypeFlags.Object) === 0) {
          this.fail(
            authoredType,
            `Remote codec type ${this.checker.typeToString(type, authoredType, ts.TypeFormatFlags.NoTruncation)} has no concrete Zod projection`,
          )
        }
        if (this.checker.isTupleType(type)) {
          const reference = type as ts.TypeReference
          const target = reference.target as ts.TupleType
          const arguments_ = this.checker.getTypeArguments(reference)
          return add({
            kind: 'tuple',
            elements: arguments_.map((argument, index) => {
              const elementFlags = target.elementFlags[index] ?? ts.ElementFlags.Required
              return {
                type: convert(argument),
                optional: (elementFlags & ts.ElementFlags.Optional) !== 0,
                rest: (elementFlags & (ts.ElementFlags.Rest | ts.ElementFlags.Variadic)) !== 0,
              }
            }),
          })
        }
        if (this.checker.isArrayType(type) || this.checker.isArrayLikeType(type)) {
          const element = this.checker.getIndexTypeOfType(type, ts.IndexKind.Number)
          if (element === undefined) this.fail(authoredType, 'Remote codec array has no element type')
          return add({ kind: 'array', element: convert(element) })
        }
        if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
          this.fail(authoredType, 'Remote codec cannot contain callable or constructable values')
        }
        const members: MemberModel[] = []
        for (const property of this.checker.getPropertiesOfType(type)) {
          const declaration = property.valueDeclaration ?? property.declarations?.[0]
          const propertyType = this.checker.getTypeOfSymbolAtLocation(property, declaration ?? authoredType)
          const symbolKey = property.getName()
          members.push({
            ...EMPTY_DOCUMENTATION,
            id: `${id}#${symbolKey}`,
            name: symbolKey,
            ...(symbolKey.startsWith('__@') ? { computed: 'symbol' as const } : {}),
            optional: (property.flags & ts.SymbolFlags.Optional) !== 0,
            readonly: declaration !== undefined && hasModifier(declaration, ts.SyntaxKind.ReadonlyKeyword),
            async: false,
            abstract: false,
            static: false,
            visibility: 'public',
            location: this.location(authoredType),
            text: '',
            kind: 'property',
            type: convert(propertyType),
          })
        }
        for (const [index, info] of this.checker.getIndexInfosOfType(type).entries()) {
          members.push({
            ...EMPTY_DOCUMENTATION,
            id: `${id}#index:${String(index)}`,
            name: '(index)',
            optional: false,
            readonly: info.isReadonly,
            async: false,
            abstract: false,
            static: false,
            visibility: 'public',
            location: this.location(authoredType),
            text: '',
            kind: 'index',
            signature: {
              typeParameters: [],
              parameters: [{
                name: 'key',
                binding: 'identifier',
                type: convert(info.keyType),
                optional: false,
                rest: false,
                receiver: false,
              }],
              returns: convert(info.type),
            },
          })
        }
        return add({ kind: 'object', members })
      } finally {
        active.delete(type)
      }
    }
    return convert(resolvedType)
  }

  private assertRemoteJsonType(
    type: ts.Type,
    site: ts.TypeNode,
    active: Set<ts.Type>,
    allowUndefined: boolean,
    allowVoid: boolean,
  ): void {
    const flags = type.flags
    if ((flags & ts.TypeFlags.Undefined) !== 0 && allowUndefined) return
    if ((flags & ts.TypeFlags.Void) !== 0 && allowVoid) return
    if ((flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
      this.fail(site, `Remote boundary contains unconstrained ${this.checker.typeToString(type)} data`)
    }
    if ((flags & (ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0) {
      this.fail(site, `Remote boundary contains non-JSON type ${this.checker.typeToString(type)}`)
    }
    if ((flags & (ts.TypeFlags.StringLike
      | ts.TypeFlags.NumberLike
      | ts.TypeFlags.BooleanLike
      | ts.TypeFlags.Null
      | ts.TypeFlags.Never)) !== 0) return
    if (type.isUnion()) {
      for (const member of type.types) {
        this.assertRemoteJsonType(member, site, active, allowUndefined, allowVoid)
      }
      return
    }
    if (type.isIntersection()) {
      const material = type.types.filter(member => !this.isRemotePhantomConstraint(member))
      if (material.length === 0) this.fail(site, 'Remote boundary contains a symbol-only object')
      for (const member of material) this.assertRemoteJsonType(member, site, active, false, false)
      return
    }
    if ((flags & ts.TypeFlags.TypeParameter) !== 0) {
      this.fail(site, 'Remote boundary contains an unresolved type parameter')
    }
    if ((flags & ts.TypeFlags.Object) === 0) {
      this.fail(site, `Remote boundary contains non-JSON type ${this.checker.typeToString(type)}`)
    }
    const symbol = type.getSymbol()
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0]
    if (declaration !== undefined && (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration))) {
      this.fail(site, `Remote boundary contains class instance ${symbol?.name ?? this.checker.typeToString(type)}`)
    }
    if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
      this.fail(site, 'Remote boundary contains callable or constructable data')
    }
    if (active.has(type)) return
    active.add(type)
    try {
      if (this.checker.isTupleType(type)) {
        const reference = type as ts.TypeReference
        const target = reference.target as ts.TupleType
        const arguments_ = this.checker.getTypeArguments(reference)
        arguments_.forEach((argument, index) => {
          const elementFlags = target.elementFlags[index] ?? ts.ElementFlags.Required
          this.assertRemoteJsonType(
            argument,
            site,
            active,
            (elementFlags & ts.ElementFlags.Optional) !== 0,
            false,
          )
        })
        return
      }
      if (this.checker.isArrayType(type) || this.checker.isArrayLikeType(type)) {
        const element = this.checker.getIndexTypeOfType(type, ts.IndexKind.Number)
        if (element === undefined) this.fail(site, 'Remote boundary array has no element type')
        this.assertRemoteJsonType(element, site, active, false, false)
        return
      }
      const properties = this.checker.getPropertiesOfType(type)
      if (properties.some(property => property.getName().startsWith('__@'))) {
        this.fail(site, 'Remote boundary contains a symbol-keyed property')
      }
      for (const property of properties) {
        const propertyDeclaration = property.valueDeclaration ?? property.declarations?.[0]
        const propertyType = this.checker.getTypeOfSymbolAtLocation(property, propertyDeclaration ?? site)
        this.assertRemoteJsonType(
          propertyType,
          site,
          active,
          (property.flags & ts.SymbolFlags.Optional) !== 0,
          false,
        )
      }
      for (const info of this.checker.getIndexInfosOfType(type)) {
        if ((info.keyType.flags & ts.TypeFlags.ESSymbolLike) !== 0) {
          this.fail(site, 'Remote boundary contains a symbol index signature')
        }
        this.assertRemoteJsonType(info.type, site, active, false, false)
      }
    } finally {
      active.delete(type)
    }
  }

  private includesRemoteAbsence(type: ts.Type): boolean {
    if ((type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0) return true
    return type.isUnion() && type.types.some(member => this.includesRemoteAbsence(member))
  }

  private isRemotePhantomConstraint(type: ts.Type): boolean {
    if ((type.flags & ts.TypeFlags.Unknown) !== 0) return true
    if ((type.flags & ts.TypeFlags.Any) !== 0 || (type.flags & ts.TypeFlags.Object) === 0) return false
    if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) return false
    if (this.checker.getIndexInfosOfType(type).length > 0) return false
    return this.checker.getPropertiesOfType(type).every(property => property.getName().startsWith('__@'))
  }

  private resolvedCycleReference(
    type: ts.Type,
    site: ts.TypeNode,
    resolvedType: TypeNodeId,
    recursiveDeclarations: Map<ts.Type, SymbolId>,
  ): TypeNodeId {
    const symbol = type.aliasSymbol ?? type.getSymbol()
    if (symbol === undefined) this.fail(site, 'Remote codec contains an unnamed recursive type')
    const resolved = this.resolveSymbol(symbol)
    const declaration = preferredDeclaration(resolved)
    if (declaration === undefined || isStandardLibraryFile(declaration.getSourceFile().fileName)) {
      this.fail(site, `Remote codec recursive type ${resolved.name} has no workspace declaration`)
    }
    const owner = this.registrationForFile(declaration.getSourceFile().fileName)
    if (owner === undefined) this.fail(site, `Remote codec recursive type ${resolved.name} is not owned by this face`)
    let id = recursiveDeclarations.get(type)
    if (id === undefined) {
      id = `${this.symbolId(resolved)}#remote-codec:${resolvedType}`
      recursiveDeclarations.set(type, id)
      this.declarations.set(id, {
        ...EMPTY_DOCUMENTATION,
        id,
        package: owner.name,
        name: `${resolved.name}RemoteCodec`,
        kind: 'alias',
        abstract: false,
        exported: false,
        location: this.location(declaration),
        text: '',
        typeParameters: [],
        extends: [],
        implements: [],
        members: [],
        type: resolvedType,
      })
    }
    return this.addNode(site, {
      kind: 'reference',
      name: `${resolved.name}RemoteCodec`,
      target: { kind: 'declaration', symbol: id },
      arguments: [],
    })
  }

  private namedWorkspaceType(node: ts.TypeNode): ts.Symbol | undefined {
    if (!ts.isTypeReferenceNode(node) && !ts.isImportTypeNode(node)) return undefined
    const symbol = ts.isTypeReferenceNode(node)
      ? this.checker.getSymbolAtLocation(node.typeName)
      : node.qualifier === undefined ? undefined : this.checker.getSymbolAtLocation(node.qualifier)
    if (symbol === undefined) return undefined
    const resolved = this.resolveSymbol(symbol)
    const declaration = preferredDeclaration(resolved)
    if (declaration === undefined
      || isStandardLibraryFile(declaration.getSourceFile().fileName)
      || this.registrationForFile(declaration.getSourceFile().fileName) === undefined) return undefined
    return resolved
  }

  private publicRemoteType(symbol: ts.Symbol, site: ts.Node): RemoteTypeImportModel {
    const declaration = preferredDeclaration(symbol)
    if (declaration === undefined) this.fail(site, `type ${symbol.name} has no declaration`)
    const registration = this.registrationForFile(declaration.getSourceFile().fileName)
    if (registration === undefined) this.fail(site, `type ${symbol.name} is not owned by a workspace package`)
    const candidates: RemoteTypeImportModel[] = []
    for (const [subpath, target] of packageExportTargets(registration.manifest)) {
      if ((subpath === '.' && !PUBLIC_REMOTE_TYPE_ROOTS.has(registration.name))
        || subpath === './package.json' || subpath === './typert'
        || subpath === './client/typert' || subpath === './remote' || target.includes('*')) continue
      const sourceFile = this.sourceFiles.get(realPath(sourcePathForExport(registration.root, target)))
      if (sourceFile === undefined) continue
      const moduleSymbol = this.checker.getSymbolAtLocation(sourceFile)
      if (moduleSymbol === undefined) continue
      for (const exported of this.checker.getExportsOfModule(moduleSymbol)) {
        if (this.resolveSymbol(exported) !== symbol) continue
        candidates.push({
          symbol: this.symbolId(symbol),
          specifier: packageExportSpecifier(registration.name, subpath),
          name: exported.name,
        })
      }
    }
    const selected = candidates.sort((left, right) =>
      left.specifier.localeCompare(right.specifier) || left.name.localeCompare(right.name))[0]
    if (selected === undefined) {
      this.fail(site, `Remote boundary type ${symbol.name} must be exported from a public non-root type subpath`)
    }
    return selected
  }

  private isWorkspaceClass(symbol: ts.Symbol): boolean {
    const declaration = preferredDeclaration(symbol)
    return declaration !== undefined
      && ts.isClassDeclaration(declaration)
      && this.registrationForFile(declaration.getSourceFile().fileName) !== undefined
  }

  private isTypeMetaSymbol(node: ts.Node, name: string): boolean {
    const symbol = this.checker.getSymbolAtLocation(node)
    if (symbol === undefined) return false
    const resolved = this.resolveSymbol(symbol)
    if (resolved.name !== name) return false
    const declaration = preferredDeclaration(resolved)
    if (declaration === undefined) return false
    const registration = this.registrationForFile(declaration.getSourceFile().fileName)
    if (registration?.name === '@deepseek-ai/dsh-typert-protocol') return true
    for (let current: ts.Node | undefined = declaration; current !== undefined; current = optionalParent(current)) {
      if (ts.isModuleDeclaration(current)
        && ts.isStringLiteral(current.name)
        && current.name.text === '@deepseek-ai/dsh-typert-protocol') return true
    }
    return false
  }

  private validateInvocationIdentity(packages: readonly PackageModel[]): void {
    const endpoints = new Map<string, InvocationModel>()
    const ids = new Map<string, InvocationModel>()
    for (const invocation of packages.flatMap(packageModel => packageModel.invocations)) {
      const endpoint = `${invocation.namespace}/${invocation.method}`
      const existingEndpoint = endpoints.get(endpoint)
      if (existingEndpoint !== undefined) {
        throw new TypertAnalysisError(
          `typert(${this.face}): ${invocation.location.file}:${String(invocation.location.line)}:${String(invocation.location.column)}: Remote endpoint ${endpoint} conflicts with ${existingEndpoint.id}`,
        )
      }
      const existingId = ids.get(invocation.id)
      if (existingId !== undefined) {
        throw new TypertAnalysisError(
          `typert(${this.face}): ${invocation.location.file}:${String(invocation.location.line)}:${String(invocation.location.column)}: Remote invocation id ${invocation.id} conflicts with ${existingId.id}`,
        )
      }
      endpoints.set(endpoint, invocation)
      ids.set(invocation.id, invocation)
    }
  }

  private collectEvents(events: ts.InterfaceDeclaration): EventModel[] {
    const result: EventModel[] = []
    for (const member of events.members) {
      const documentation = documentationOf(member)
      const mode = documentation.tags.find(tag => tag.name === 'mode')?.comment?.trim()
      if (ts.isMethodSignature(member)) {
        const signature = this.signature(member, member.type)
        result.push({
          ...documentation,
          name: memberName(member.name),
          signature: this.addNode(member, { kind: 'function', signature }),
          text: memberText(member),
          ...(mode === undefined ? {} : { mode }),
          location: this.location(member),
        })
      } else if (ts.isPropertySignature(member) && member.type !== undefined) {
        result.push({
          ...documentation,
          name: memberName(member.name),
          signature: this.convertType(member.type),
          text: memberText(member),
          ...(mode === undefined ? {} : { mode }),
          location: this.location(member),
        })
      }
    }
    return result
  }

  private ensureDeclaration(
    symbol: ts.Symbol,
    selected: ts.ClassDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration,
  ): TypeDeclarationModel {
    const resolved = this.resolveSymbol(symbol)
    const id = this.symbolId(resolved)
    const existing = this.declarations.get(id)
    if (existing !== undefined) return existing
    const declarationParts = (resolved.declarations as ts.Declaration[]).filter(isTypeDeclaration)
    if (declarationParts.length > 1 && !declarationParts.every(ts.isInterfaceDeclaration)) {
      this.fail(
        selected,
        `merged ${ts.SyntaxKind[selected.kind]} declaration ${resolved.name} is not supported`,
      )
    }
    if (selected.name === undefined) {
      this.fail(selected, `anonymous ${ts.SyntaxKind[selected.kind]} cannot be represented as a named type declaration`)
    }
    const owner = this.registrationForFile(selected.getSourceFile().fileName) as PackageRegistration

    this.declarationStates.add(id)
    if (declarationParts.length > 1) {
      const analyzedParts = declarationParts.map((declarationPart) => {
        const part = declarationPart as ts.InterfaceDeclaration
        const partOwner = this.registrationForFile(part.getSourceFile().fileName)
        if (partOwner === undefined) {
          this.fail(part, `merged interface ${resolved.name} contains a declaration outside this face`)
        }
        const typeParameters = this.typeParameters(part.typeParameters)
        const heritage = this.heritage(part)
        const members = this.members(part.members, id)
        return {
          typeParameters,
          heritage,
          members,
          model: {
            ...documentationOf(part),
            package: partOwner.name,
            location: this.location(part),
            typeParameters,
            extends: heritage.extends,
            members: members.map(member => member.id),
          },
        }
      })
      const parameters = this.mergeTypeParameters(analyzedParts.map(part => part.typeParameters), selected, resolved.name)
      const model: TypeDeclarationModel = {
        ...documentationOf(selected),
        id,
        package: owner.name,
        name: declarationName(selected),
        kind: 'interface',
        abstract: false,
        exported: hasModifier(selected, ts.SyntaxKind.ExportKeyword),
        location: this.location(selected),
        text: declarationText(selected),
        typeParameters: parameters,
        extends: analyzedParts.flatMap(part => part.heritage.extends),
        implements: [],
        members: analyzedParts.flatMap(part => part.members),
        parts: analyzedParts.map(part => part.model),
      }
      this.declarations.set(id, model)
      this.declarationStates.delete(id)
      return model
    }
    const parameters = ts.isEnumDeclaration(selected) ? [] : this.typeParameters(selected.typeParameters)
    const heritage = ts.isTypeAliasDeclaration(selected) || ts.isEnumDeclaration(selected)
      ? { extends: [] as TypeNodeId[], implements: [] as TypeNodeId[] }
      : this.heritage(selected)
    const kind = ts.isClassDeclaration(selected)
      ? 'class'
      : ts.isInterfaceDeclaration(selected)
        ? 'interface'
        : ts.isTypeAliasDeclaration(selected)
          ? 'alias'
          : 'enum'
    const model: TypeDeclarationModel = {
      ...documentationOf(selected),
      id,
      package: owner.name,
      name: declarationName(selected),
      kind,
      abstract: hasModifier(selected, ts.SyntaxKind.AbstractKeyword),
      exported: hasModifier(selected, ts.SyntaxKind.ExportKeyword),
      location: this.location(selected),
      text: declarationText(selected),
      typeParameters: parameters,
      extends: heritage.extends,
      implements: heritage.implements,
      members: ts.isTypeAliasDeclaration(selected) || ts.isEnumDeclaration(selected)
        ? []
        : this.members(selected.members, id),
      ...(ts.isTypeAliasDeclaration(selected) ? { type: this.convertType(selected.type) } : {}),
      ...(ts.isEnumDeclaration(selected) ? { enumMembers: this.enumMembers(selected) } : {}),
    }
    this.declarations.set(id, model)
    this.declarationStates.delete(id)
    return model
  }

  private enumMembers(declaration: ts.EnumDeclaration): EnumMemberModel[] {
    return declaration.members.map(member => ({
      ...documentationOf(member),
      name: memberName(member.name),
      ...(member.initializer === undefined ? {} : { initializer: member.initializer.getText() }),
      location: this.location(member),
    }))
  }

  private heritage(
    declaration: ts.ClassDeclaration | ts.InterfaceDeclaration,
  ): { extends: TypeNodeId[]; implements: TypeNodeId[] } {
    const result = { extends: [] as TypeNodeId[], implements: [] as TypeNodeId[] }
    for (const clause of declaration.heritageClauses ?? []) {
      const target = clause.token === ts.SyntaxKind.ExtendsKeyword ? result.extends : result.implements
      for (const type of clause.types) target.push(this.convertHeritage(type))
    }
    return result
  }

  private convertHeritage(node: ts.ExpressionWithTypeArguments): TypeNodeId {
    const symbol = this.checker.getSymbolAtLocation(node.expression) as ts.Symbol
    return this.addNode(node, {
      kind: 'reference',
      name: node.expression.getText(),
      target: this.targetForReference(this.resolveSymbol(symbol), node),
      arguments: node.typeArguments?.map(argument => this.convertType(argument)) ?? [],
    })
  }

  private members(
    members: ts.NodeArray<ts.TypeElement | ts.ClassElement>,
    ownerId: string,
  ): MemberModel[] {
    const result: MemberModel[] = []
    for (const member of members) {
      if (ts.isPropertyDeclaration(member)
        && memberName(member.name) === 'typertRemote'
        && member.initializer !== undefined
        && ts.isCallExpression(member.initializer)
        && this.isTypeMetaSymbol(member.initializer.expression, 'bindTypertRemote')) continue
      if (ts.isMethodDeclaration(member) && member.body !== undefined
        && members.some(candidate => candidate !== member
          && (ts.isMethodDeclaration(candidate) || ts.isMethodSignature(candidate))
          && memberName(candidate.name) === memberName(member.name)
          && (!ts.isMethodDeclaration(candidate) || candidate.body === undefined))) continue
      const visibility = visibilityOf(member)
      const isStatic = hasModifier(member, ts.SyntaxKind.StaticKeyword)
      if (visibility !== 'public' || isStatic || ts.isConstructorDeclaration(member)) continue
      const base = this.memberBase(member, ownerId, visibility, isStatic)
      if (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) {
        const type = this.requiredType(member, member.type, 'property')
        result.push({ ...base, kind: 'property', type: this.convertType(type) })
      } else if (ts.isMethodSignature(member) || ts.isMethodDeclaration(member)) {
        result.push({ ...base, kind: 'method', signature: this.signature(member, member.type) })
      } else if (ts.isGetAccessorDeclaration(member)) {
        result.push({ ...base, kind: 'getter', signature: this.signature(member, member.type) })
      } else if (ts.isSetAccessorDeclaration(member)) {
        result.push({ ...base, kind: 'setter', signature: this.signature(member, member.type) })
      } else if (ts.isCallSignatureDeclaration(member)) {
        result.push({ ...base, kind: 'call', signature: this.signature(member, member.type) })
      } else if (ts.isConstructSignatureDeclaration(member)) {
        result.push({ ...base, kind: 'construct', signature: this.signature(member, member.type) })
      } else if (ts.isIndexSignatureDeclaration(member)) {
        result.push({ ...base, kind: 'index', signature: this.signature(member, member.type) })
      }
    }
    return result
  }

  private memberBase(
    member: ts.TypeElement | ts.ClassElement,
    ownerId: string,
    visibility: MemberVisibility,
    isStatic: boolean,
  ): MemberBase {
    const identity = member.name !== undefined
      ? this.memberIdentity(member.name)
      : {
        name: ts.isCallSignatureDeclaration(member)
          ? '(call)'
          : ts.isConstructSignatureDeclaration(member)
            ? '(construct)'
            : '(index)',
      }
    return {
      ...documentationOf(member),
      id: `${ownerId}#${identity.name}@${String(member.getStart())}`,
      ...identity,
      optional: 'questionToken' in member && member.questionToken !== undefined,
      readonly: hasModifier(member, ts.SyntaxKind.ReadonlyKeyword),
      async: hasModifier(member, ts.SyntaxKind.AsyncKeyword),
      abstract: hasModifier(member, ts.SyntaxKind.AbstractKeyword),
      static: isStatic,
      visibility,
      location: this.location(member),
      text: memberText(member),
    }
  }

  private memberIdentity(name: ts.PropertyName): Pick<MemberBase, 'name' | 'jsonName' | 'computed'> {
    if (!ts.isComputedPropertyName(name)) return { name: memberName(name) }
    const expression = name.expression
    if (ts.isStringLiteral(expression) || ts.isNumericLiteral(expression)
      || ts.isNoSubstitutionTemplateLiteral(expression)) {
      return { name: memberName(name), jsonName: expression.text }
    }
    const type = this.checker.getTypeAtLocation(expression)
    return {
      name: memberName(name),
      computed: (type.flags & ts.TypeFlags.UniqueESSymbol) !== 0 ? 'symbol' : 'dynamic',
    }
  }

  private signature(
    node: ts.SignatureDeclarationBase,
    explicitReturn: ts.TypeNode | undefined,
  ): SignatureModel {
    const parameters: ParameterModel[] = node.parameters.map(parameter => ({
      name: memberName(parameter.name),
      binding: ts.isIdentifier(parameter.name)
        ? 'identifier'
        : ts.isObjectBindingPattern(parameter.name)
          ? 'object'
          : 'array',
      type: this.convertType(this.requiredType(parameter, parameter.type, 'parameter')),
      optional: parameter.questionToken !== undefined || parameter.initializer !== undefined,
      rest: parameter.dotDotDotToken !== undefined,
      receiver: ts.isIdentifier(parameter.name) && parameter.name.text === 'this',
      ...(parameter.initializer === undefined ? {} : { initializer: parameter.initializer.getText() }),
    }))
    return {
      typeParameters: this.typeParameters(node.typeParameters),
      parameters,
      returns: ts.isSetAccessorDeclaration(node)
        ? this.addNode(node, { kind: 'keyword', name: 'void' })
        : this.convertType(this.requiredType(node, explicitReturn, 'return')),
    }
  }

  private typeParameters(
    parameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
  ): TypeParameterModel[] {
    return parameters?.map(parameter => ({
      id: `${this.locationKey(parameter)}#${parameter.name.text}`,
      name: parameter.name.text,
      const: hasModifier(parameter, ts.SyntaxKind.ConstKeyword),
      ...(parameter.constraint === undefined ? {} : { constraint: this.convertType(parameter.constraint) }),
      ...(parameter.default === undefined ? {} : { default: this.convertType(parameter.default) }),
      ...(hasModifier(parameter, ts.SyntaxKind.InKeyword) && hasModifier(parameter, ts.SyntaxKind.OutKeyword)
        ? { variance: 'in-out' as const }
        : hasModifier(parameter, ts.SyntaxKind.InKeyword)
          ? { variance: 'in' as const }
          : hasModifier(parameter, ts.SyntaxKind.OutKeyword)
            ? { variance: 'out' as const }
            : {}),
    })) ?? []
  }

  private mergeTypeParameters(
    parts: readonly (readonly TypeParameterModel[])[],
    site: ts.Node,
    declarationName: string,
  ): TypeParameterModel[] {
    const first = parts[0] as readonly TypeParameterModel[]
    return first.map((parameter, index) => {
      const peers = parts.map(part => part[index] as TypeParameterModel)
      const constraint = peers.find(peer => peer.constraint !== undefined)?.constraint
      const fallback = peers.find(peer => peer.default !== undefined)?.default
      const variances = [...new Set(peers.flatMap(peer => peer.variance === undefined ? [] : [peer.variance]))]
      if (variances.length > 1) {
        this.fail(site, `merged interface ${declarationName} has incompatible variance modifiers`)
      }
      return {
        id: parameter.id,
        name: parameter.name,
        const: peers.some(peer => peer.const),
        ...(constraint === undefined ? {} : { constraint }),
        ...(fallback === undefined ? {} : { default: fallback }),
        ...(variances[0] === undefined ? {} : { variance: variances[0] }),
      }
    })
  }

  private requiredType(
    owner: ts.Node,
    type: ts.TypeNode | undefined,
    purpose: 'property' | 'parameter' | 'return',
  ): ts.TypeNode {
    if (type !== undefined) return type
    if (this.mode === 'check') {
      this.fail(owner, `public ${purpose} is missing an explicit type annotation`)
    }
    const inferred = this.inferType(owner, purpose)
    const rendered = ts.createPrinter().printNode(ts.EmitHint.Unspecified, inferred, owner.getSourceFile())
    const position = annotationPosition(owner, purpose)
    this.queueEdit({ file: realPath(owner.getSourceFile().fileName), position, text: `: ${rendered}` })
    throw new SourceEditQueued()
  }

  private inferType(
    owner: ts.Node,
    purpose: 'property' | 'parameter' | 'return',
  ): ts.TypeNode {
    let type: ts.Type
    if (purpose === 'return') {
      const signature = this.checker.getSignatureFromDeclaration(owner as ts.SignatureDeclaration) as ts.Signature
      type = this.checker.getReturnTypeOfSignature(signature)
    } else {
      type = this.checker.getTypeAtLocation(owner)
    }
    return this.checker.typeToTypeNode(
      type,
      owner,
      ts.NodeBuilderFlags.NoTruncation | ts.NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope,
    ) as ts.TypeNode
  }

  private convertType(node: ts.TypeNode): TypeNodeId {
    const id = this.allocateNodeId(node)
    const add = (model: TypeNodeInput): TypeNodeId => {
      this.nodes.set(id, { id, ...model })
      return id
    }

    const keyword = keywordName(node.kind)
    if (keyword !== undefined) return add({ kind: 'keyword', name: keyword })
    if (ts.isParenthesizedTypeNode(node)) {
      return add({ kind: 'parenthesized', type: this.convertType(node.type) })
    }
    if (ts.isLiteralTypeNode(node)) return add(literalModel(node))
    if (ts.isTypeReferenceNode(node)) {
      const symbol = this.checker.getSymbolAtLocation(node.typeName) as ts.Symbol
      return add({
        kind: 'reference',
        name: node.typeName.getText(),
        target: this.targetForReference(this.resolveSymbol(symbol), node),
        arguments: node.typeArguments?.map(argument => this.convertType(argument)) ?? [],
      })
    }
    if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
      return add({
        kind: ts.isUnionTypeNode(node) ? 'union' : 'intersection',
        types: node.types.map(type => this.convertType(type)),
      })
    }
    if (ts.isArrayTypeNode(node)) return add({ kind: 'array', element: this.convertType(node.elementType) })
    if (ts.isTupleTypeNode(node)) {
      return add({
        kind: 'tuple',
        elements: node.elements.map((element) => {
          const named = ts.isNamedTupleMember(element) ? element : undefined
          const raw = named?.type ?? element
          const optional = named?.questionToken !== undefined || ts.isOptionalTypeNode(raw)
          const rest = named?.dotDotDotToken !== undefined || ts.isRestTypeNode(raw)
          const type = ts.isOptionalTypeNode(raw) || ts.isRestTypeNode(raw) ? raw.type : raw
          return {
            ...(named === undefined ? {} : { name: named.name.text }),
            type: this.convertType(type),
            optional,
            rest,
          }
        }),
      })
    }
    if (ts.isTypeLiteralNode(node)) return add({ kind: 'object', members: this.members(node.members, id) })
    if (ts.isFunctionTypeNode(node)) {
      return add({ kind: 'function', signature: this.signature(node, node.type) })
    }
    if (ts.isConstructorTypeNode(node)) {
      return add({
        kind: 'constructor',
        abstract: hasModifier(node, ts.SyntaxKind.AbstractKeyword),
        signature: this.signature(node, node.type),
      })
    }
    if (ts.isIndexedAccessTypeNode(node)) {
      return add({
        kind: 'indexed-access',
        object: this.convertType(node.objectType),
        index: this.convertType(node.indexType),
      })
    }
    if (ts.isTypeOperatorNode(node)) {
      return add({
        kind: 'operator',
        operator: ts.tokenToString(node.operator) as TypeOperatorName,
        type: this.convertType(node.type),
      })
    }
    if (ts.isConditionalTypeNode(node)) {
      return add({
        kind: 'conditional',
        check: this.convertType(node.checkType),
        extends: this.convertType(node.extendsType),
        whenTrue: this.convertType(node.trueType),
        whenFalse: this.convertType(node.falseType),
      })
    }
    if (ts.isInferTypeNode(node)) {
      return add({ kind: 'infer', parameter: this.typeParameters(ts.factory.createNodeArray([node.typeParameter]))[0] as TypeParameterModel })
    }
    if (ts.isMappedTypeNode(node)) {
      const parameter = this.typeParameters(ts.factory.createNodeArray([node.typeParameter]))[0] as TypeParameterModel
      return add({
        kind: 'mapped',
        parameter,
        ...(node.nameType === undefined ? {} : { nameType: this.convertType(node.nameType) }),
        ...(node.type === undefined ? {} : { value: this.convertType(node.type) }),
        readonly: modifierMode(node.readonlyToken),
        optional: modifierMode(node.questionToken),
      })
    }
    if (ts.isTemplateLiteralTypeNode(node)) {
      return add({
        kind: 'template-literal',
        head: node.head.text,
        spans: node.templateSpans.map(span => ({ type: this.convertType(span.type), text: span.literal.text })),
      })
    }
    if (ts.isTypeQueryNode(node)) {
      return add({
        kind: 'type-query',
        expression: node.exprName.getText(),
        arguments: node.typeArguments?.map(argument => this.convertType(argument)) ?? [],
      })
    }
    if (ts.isImportTypeNode(node)) {
      const argument = node.argument as ts.LiteralTypeNode & { readonly literal: ts.StringLiteral }
      const symbol = node.qualifier === undefined ? undefined : this.checker.getSymbolAtLocation(node.qualifier)
      return add({
        kind: 'import-type',
        module: argument.literal.text,
        ...(node.qualifier === undefined ? {} : { qualifier: node.qualifier.getText() }),
        arguments: node.typeArguments?.map(argument => this.convertType(argument)) ?? [],
        typeof: node.isTypeOf,
        ...(node.attributes === undefined ? {} : { attributes: importTypeAttributesText(node) }),
        ...(symbol === undefined ? {} : { target: this.targetForReference(this.resolveSymbol(symbol), node) }),
      })
    }
    if (ts.isTypePredicateNode(node)) {
      return add({
        kind: 'predicate',
        asserts: node.assertsModifier !== undefined,
        parameter: node.parameterName.getText(),
        ...(node.type === undefined ? {} : { type: this.convertType(node.type) }),
      })
    }
    /* v8 ignore else -- every source TypeNode kind accepted by TypeScript is handled above; this arm keeps
     * future compiler kinds fail-loud. */
    if (ts.isThisTypeNode(node)) return add({ kind: 'this' })
    /* v8 ignore next -- paired with the exhaustive TypeNode guard above. */
    this.fail(node, `unsupported TypeScript type node ${ts.SyntaxKind[node.kind]}`)
  }

  private addNode(site: ts.Node, model: TypeNodeInput): TypeNodeId {
    const id = this.allocateNodeId(site)
    this.nodes.set(id, { id, ...model })
    return id
  }

  private referenceNode(symbol: ts.Symbol, site: ts.Node): TypeNodeId {
    return this.addNode(site, {
      kind: 'reference',
      name: symbol.name,
      target: { kind: 'declaration', symbol: this.symbolId(symbol) },
      arguments: [],
    })
  }

  private targetForReference(symbol: ts.Symbol, site: ReferenceSite): TypeTargetModel {
    const declaration = preferredDeclaration(symbol)
    /* v8 ignore next -- a symbol from a semantically valid source type reference always has a declaration. */
    if (declaration === undefined) this.fail(site, `type symbol ${symbol.name} has no declaration`)
    if (ts.isTypeParameterDeclaration(declaration)) {
      return {
        kind: 'type-parameter',
        parameter: `${this.locationKey(declaration)}#${declaration.name.text}`,
      }
    }
    if (isStandardLibraryFile(declaration.getSourceFile().fileName)) {
      return { kind: 'standard', name: symbol.name }
    }

    const moduleSpecifier = moduleSpecifierOf(site)
    const from = this.registrationForFile(site.getSourceFile().fileName) as PackageRegistration
    const owner = this.registrationForFile(declaration.getSourceFile().fileName)
    if (owner !== undefined) {
      if (owner.name !== from.name) {
        const imported = moduleSpecifier === undefined
          ? undefined
          : this.packageImportOf(site, moduleSpecifier, symbol, from)
        if (imported === undefined) {
          this.fail(site, `reference to ${symbol.name} crosses a package without an explicit package import`)
        }
        if (this.packageExportName(imported.module, symbol, owner.face, imported.name) === undefined) {
          this.fail(
            site,
            `package reference ${imported.name} is not exported by ${imported.module.package} at ${imported.module.subpath}`,
          )
        }
      }
      const typeDeclaration = declaration as ts.ClassDeclaration | ts.InterfaceDeclaration
        | ts.TypeAliasDeclaration | ts.EnumDeclaration
      if (!this.declarationStates.has(this.symbolId(symbol))) this.ensureDeclaration(symbol, typeDeclaration)
      return { kind: 'declaration', symbol: this.symbolId(symbol) }
    }

    const imported = moduleSpecifier === undefined
      ? undefined
      : this.packageImportOf(site, moduleSpecifier, symbol, from)
    const packageFaces = imported === undefined
      ? []
      : [...new Set(this.allRegistrations.filter(candidate => candidate.name === imported.module.package).map(candidate => candidate.face))]
    const otherFace = packageFaces.find(face => face !== this.face)
    if (otherFace !== undefined && imported !== undefined) {
      const { module } = imported
      const exportName = this.packageExportName(module, symbol, otherFace, imported.name)
      if (exportName === undefined) {
        this.fail(site, `cross-face reference ${imported.name} is not exported by ${module.package} at ${module.subpath}`)
      }
      this.recordCrossFaceLink(from.name, otherFace, module, exportName)
      return {
        kind: 'cross-face',
        face: otherFace,
        package: module.package,
        subpath: module.subpath,
        name: exportName,
      }
    }

    if (imported !== undefined) {
      return {
        kind: 'external',
        module: imported.module.package,
        subpath: imported.module.subpath,
        name: symbol.name,
      }
    }

    const external = externalModuleIdentityForFile(declaration.getSourceFile().fileName)
    if (external !== undefined) {
      return {
        kind: 'external',
        module: external.package,
        subpath: external.subpath,
        name: symbol.name,
      }
    }

    this.fail(site, `reference to ${symbol.name} crosses a package or face without an explicit import`)
  }

  private recordCrossFaceLink(
    fromPackage: string,
    toFace: TypertFace,
    module: ModuleIdentity,
    name: string,
  ): void {
    const link: CrossFaceLink = {
      fromFace: this.face,
      fromPackage,
      toFace,
      toPackage: module.package,
      subpath: module.subpath,
      name,
    }
    const key = [
      link.fromFace,
      link.fromPackage,
      link.toFace,
      link.toPackage,
      link.subpath,
      link.name,
    ].join('\0')
    this.crossFaceLinks.set(key, link)
  }

  private packageExportName(
    module: ModuleIdentity,
    symbol: ts.Symbol,
    face: TypertFace,
    requestedName: string,
  ): string | undefined {
    const registration = this.allRegistrations.find(candidate =>
      candidate.face === face && candidate.name === module.package)
    if (registration === undefined) return undefined
    const target = packageExportTargets(registration.manifest)
      .find(([subpath]) => subpath === module.subpath)?.[1]
    if (target === undefined) return undefined
    const sourceFile = this.sourceFiles.get(realPath(sourcePathForExport(registration.root, target))) as ts.SourceFile
    const moduleSymbol = this.checker.getSymbolAtLocation(sourceFile) as ts.Symbol
    const exported = this.checker.getExportsOfModule(moduleSymbol)
      .find(candidate => candidate.name === requestedName && this.resolveSymbol(candidate) === symbol)
    return exported?.name
  }

  private symbolAtType(node: ts.TypeNode): ts.Symbol | undefined {
    if (ts.isTypeReferenceNode(node)) {
      return this.resolveSymbol(this.checker.getSymbolAtLocation(node.typeName) as ts.Symbol)
    }
    const type = this.checker.getTypeAtLocation(node)
    const symbol = type.aliasSymbol ?? type.getSymbol()
    return symbol === undefined ? undefined : this.resolveSymbol(symbol)
  }

  private resolveSymbol(symbol: ts.Symbol): ts.Symbol {
    return (symbol.flags & ts.SymbolFlags.Alias) === 0 ? symbol : this.checker.getAliasedSymbol(symbol)
  }

  private symbolId(symbol: ts.Symbol): SymbolId {
    const declaration = preferredDeclaration(symbol)
    if (declaration === undefined) return `symbol:${symbol.name}`
    const location = this.location(declaration)
    return `${this.packageNameForFile(declaration.getSourceFile().fileName)}:${location.file}#${symbol.name}`
  }

  private registrationForFile(file: string): PackageRegistration | undefined {
    const path = realPath(file)
    return this.allRegistrations
      .find(registration => registration.face === this.face && isWithin(path, registration.root))
  }

  private packageNameForFile(file: string): string {
    const path = realPath(file)
    return this.allRegistrations.find(registration => isWithin(path, registration.root))?.name ?? '<external>'
  }

  private allocateNodeId(site: ts.Node): TypeNodeId {
    const location = this.locationKey(site)
    const ordinal = (this.nodeOrdinals.get(location) ?? 0) + 1
    this.nodeOrdinals.set(location, ordinal)
    return `type:${location}#${String(ordinal)}`
  }

  private locationKey(node: ts.Node): string {
    const location = this.location(node)
    return `${location.file}:${String(location.line)}:${String(location.column)}`
  }

  private location(node: ts.Node): SourceLocation {
    const sourceFile = node.getSourceFile()
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    return {
      file: slash(relative(this.root, sourceFile.fileName)),
      line: position.line + 1,
      column: position.character + 1,
    }
  }

  private fail(node: ts.Node, message: string): never {
    const location = this.location(node)
    throw new TypertAnalysisError(
      `typert(${this.face}): ${location.file}:${String(location.line)}:${String(location.column)}: ${message}`,
    )
  }
}

function mergeWorkspaceModels(models: readonly WorkspaceModel[]): WorkspaceModel {
  const faces = new Map<TypertFace, {
    packages: Map<string, PackageModel>
    declarations: Map<SymbolId, TypeDeclarationModel>
    nodes: Map<TypeNodeId, TypeNodeModel>
  }>()
  const links = new Map<string, CrossFaceLink>()
  for (const model of models) {
    for (const face of model.faces) {
      const merged = faces.get(face.face) ?? {
        packages: new Map(),
        declarations: new Map(),
        nodes: new Map(),
      }
      for (const packageModel of face.packages) merged.packages.set(packageModel.name, packageModel)
      for (const declaration of face.graph.declarations) {
        if (!merged.declarations.has(declaration.id)) merged.declarations.set(declaration.id, declaration)
      }
      for (const node of face.graph.nodes) {
        if (!merged.nodes.has(node.id)) merged.nodes.set(node.id, node)
      }
      faces.set(face.face, merged)
    }
    for (const link of model.crossFaceLinks) {
      links.set([
        link.fromFace,
        link.fromPackage,
        link.toFace,
        link.toPackage,
        link.subpath,
        link.name,
      ].join('\0'), link)
    }
  }
  return {
    faces: [...faces].sort(([left], [right]) =>
      (left === 'host' ? 0 : 1) - (right === 'host' ? 0 : 1)).map(([face, model]) => ({
      face,
      packages: [...model.packages.values()].sort((left, right) => left.name.localeCompare(right.name)),
      graph: {
        declarations: [...model.declarations.values()].sort((left, right) => left.id.localeCompare(right.id)),
        nodes: [...model.nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
      },
    })),
    crossFaceLinks: [...links.values()].sort(compareCrossFaceLinks),
  }
}

function parseConfig(path: string): ParsedConfig {
  const compilerPath = path.split(sep).join('/')
  const read = ts.readConfigFile(compilerPath, file => ts.sys.readFile(file))
  if (read.error !== undefined) throw new TypertAnalysisError(formatDiagnostic(read.error))
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(compilerPath), undefined, compilerPath)
  if (parsed.errors.length > 0) throw new TypertAnalysisError(parsed.errors.map(formatDiagnostic).join('\n'))
  return { path, parsed }
}

function projectConfigPath(path: string): string {
  if (extname(path) === '.json') return path
  return join(path, 'tsconfig.json')
}

function sourceFileHasSurface(sourceFile: ts.SourceFile): boolean {
  for (const statement of sourceFile.statements) {
    if ((ts.isClassDeclaration(statement)
      || ts.isInterfaceDeclaration(statement)
      || ts.isTypeAliasDeclaration(statement)
      || ts.isEnumDeclaration(statement))
      && (typertMode(statement) !== undefined || typertServiceTag(statement) !== undefined)) return true
    if (ts.isClassDeclaration(statement)) {
      for (const member of statement.members) {
        if (ts.isPropertyDeclaration(member)
          && memberName(member.name) === 'typertRemote'
          && member.initializer !== undefined
          && ts.isCallExpression(member.initializer)
          && expressionName(member.initializer.expression) === 'bindTypertRemote') return true
        for (const decorator of ts.canHaveDecorators(member) ? ts.getDecorators(member) ?? [] : []) {
          const expression = ts.isCallExpression(decorator.expression)
            ? decorator.expression.expression
            : decorator.expression
          const name = expressionName(expression)
          if (name === 'Remote' || name === 'RemoteScope') return true
        }
      }
    }
    if (!ts.isModuleDeclaration(statement)
      || !ts.isStringLiteral(statement.name)
      || statement.name.text !== '@deepseek-ai/cordis'
      || statement.body === undefined
      || !ts.isModuleBlock(statement.body)) continue
    if (statement.body.statements.some(member => ts.isInterfaceDeclaration(member)
      && (member.name.text === 'Context' || member.name.text === 'Events')
      && member.members.length > 0)) return true
  }
  return false
}

function hasPackageSurface(model: PackageModel): boolean {
  return model.services.length > 0
    || model.events.length > 0
    || model.objects.length > 0
    || model.schemas.length > 0
    || model.invocations.length > 0
}

function isDualFacePackage(manifest: Record<string, unknown>): boolean {
  const dsh = manifest.dsh
  const client = dsh !== null && typeof dsh === 'object'
    ? (dsh as Record<string, unknown>).client
    : undefined
  return client !== null
    && typeof client === 'object'
    && clientExportSubpaths(manifest).length > 0
}

function hostExportSubpaths(manifest: Record<string, unknown>): string[] {
  return packageExportTargets(manifest)
    .map(([subpath]) => subpath)
    .filter(subpath => subpath !== './client'
      && !subpath.startsWith('./client/')
      && subpath !== './remote')
}

function clientExportSubpaths(manifest: Record<string, unknown>): string[] {
  return packageExportTargets(manifest)
    .map(([subpath]) => subpath)
    .filter(subpath => subpath === './client' || subpath.startsWith('./client/'))
}

function packageExportTargets(manifest: Record<string, unknown>): [string, string][] {
  const exportsField = manifest.exports
  if (typeof exportsField === 'string') return [['.', exportsField]]
  if (exportsField === null || typeof exportsField !== 'object') {
    const types = manifest.types
    return typeof types === 'string' ? [['.', types]] : []
  }
  if (Array.isArray(exportsField)
    || !Object.keys(exportsField).some(key => key.startsWith('.'))) {
    const target = exportTarget(exportsField)
    return target === undefined ? [] : [['.', target]]
  }
  const result: [string, string][] = []
  for (const [subpath, value] of Object.entries(exportsField as Record<string, unknown>)) {
    if (!subpath.startsWith('.')) continue
    const target = exportTarget(value)
    if (target !== undefined) result.push([subpath, target])
  }
  return result.sort(([left], [right]) => left.localeCompare(right))
}

function exportTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const target = exportTarget(candidate)
      if (target !== undefined) return target
    }
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  const conditions = value as Record<string, unknown>
  for (const key of ['types', 'import', 'default']) {
    const target = exportTarget(conditions[key])
    if (target !== undefined) return target
  }
  for (const candidate of Object.values(conditions)) {
    const target = exportTarget(candidate)
    if (target !== undefined) return target
  }
  return undefined
}

function sourcePathForExport(packageRoot: string, target: string): string {
  const normalized = target.replace(/^\.\//, '')
  if (normalized.startsWith('lib/types/')) {
    return resolve(packageRoot, 'src', normalized.slice('lib/types/'.length).replace(/\.d\.(?:mts|cts|ts)$/, '.ts'))
  }
  if (normalized.startsWith('lib/')) {
    return resolve(packageRoot, 'src', normalized.slice('lib/'.length).replace(/\.(?:mjs|cjs|js|d\.ts)$/, '.ts'))
  }
  return resolve(packageRoot, normalized)
}

function preferredDeclaration(symbol: ts.Symbol): ts.Declaration | undefined {
  return symbol.declarations?.find(isTypeDeclaration)
    ?? symbol.valueDeclaration
    ?? symbol.declarations?.[0]
}

function optionalParent(node: ts.Node): ts.Node | undefined {
  return (node as ts.Node & { readonly parent?: ts.Node }).parent
}

function isTypeDeclaration(
  node: ts.Node,
): node is ts.ClassDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration {
  return ts.isClassDeclaration(node)
    || ts.isInterfaceDeclaration(node)
    || ts.isTypeAliasDeclaration(node)
    || ts.isEnumDeclaration(node)
}

function declarationName(
  declaration: ts.ClassDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration,
): string {
  return (declaration.name as ts.Identifier).text
}

function memberText(member: ts.TypeElement | ts.ClassElement): string {
  const sourceFile = member.getSourceFile()
  const full = member.getText(sourceFile)
  const body = (member as { body?: ts.Node }).body
  const signature = body === undefined ? full : full.slice(0, full.length - body.getText(sourceFile).length)
  return signature.replace(/\s*;?\s*$/, '').replace(/\s+/g, ' ').trim()
}

function declarationText(
  declaration: ts.ClassDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration,
): string {
  const printer = ts.createPrinter({ removeComments: true })
  const projected = ts.isClassDeclaration(declaration) ? classShape(declaration) : declaration
  return printer.printNode(ts.EmitHint.Unspecified, projected, declaration.getSourceFile()).replace(/\r/g, '')
}

function classShape(node: ts.ClassDeclaration): ts.ClassDeclaration {
  const nonPublic = (member: ts.ClassElement): boolean =>
    (ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined)?.some(modifier =>
      modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword) ?? false
  const members = node.members.flatMap((member): ts.ClassElement[] => {
    if (nonPublic(member) || (ts.isPropertyDeclaration(member) && ts.isPrivateIdentifier(member.name))) return []
    if (ts.isMethodDeclaration(member)) {
      return [ts.factory.updateMethodDeclaration(
        member,
        member.modifiers,
        member.asteriskToken,
        member.name,
        member.questionToken,
        member.typeParameters,
        member.parameters,
        member.type,
        undefined,
      )]
    }
    if (ts.isConstructorDeclaration(member)) {
      return [ts.factory.updateConstructorDeclaration(member, member.modifiers, member.parameters, undefined)]
    }
    if (ts.isGetAccessorDeclaration(member)) {
      return [ts.factory.updateGetAccessorDeclaration(
        member,
        member.modifiers,
        member.name,
        member.parameters,
        member.type,
        undefined,
      )]
    }
    if (ts.isSetAccessorDeclaration(member)) {
      return [ts.factory.updateSetAccessorDeclaration(
        member,
        member.modifiers,
        member.name,
        member.parameters,
        undefined,
      )]
    }
    if (ts.isPropertyDeclaration(member)) {
      return [ts.factory.updatePropertyDeclaration(
        member,
        member.modifiers,
        member.name,
        member.questionToken ?? member.exclamationToken,
        member.type,
        undefined,
      )]
    }
    return [member]
  })
  return ts.factory.updateClassDeclaration(
    node,
    node.modifiers,
    node.name,
    node.typeParameters,
    node.heritageClauses,
    members,
  )
}

function documentationOf(node: ts.Node): DocumentationModel {
  const blocks = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc)
  const block = blocks.at(-1)
  if (block === undefined) return EMPTY_DOCUMENTATION
  const description = normalizedDocText(ts.getTextOfJSDocComment(block.comment))
  const tags: JsDocTagModel[] = ts.getJSDocTags(node).map((tag) => {
    const named = tag as ts.JSDocTag & { name?: ts.Node }
    const comment = normalizedDocText(ts.getTextOfJSDocComment(tag.comment))
    return {
      name: tag.tagName.text,
      ...(named.name === undefined ? {} : { argument: named.name.getText() }),
      ...(comment === undefined ? {} : { comment }),
      text: tag.getText(tag.getSourceFile()).trim(),
    }
  })
  return {
    ...(description === undefined ? {} : {
      description,
      summary: firstSentence(description),
    }),
    tags,
    jsDoc: rawJsDoc(node),
  }
}

function normalizedDocText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.replace(/\s+/g, ' ').trim()
  /* v8 ignore next -- TypeScript represents whitespace-only JSDoc as undefined before this helper is called. */
  return normalized.length === 0 ? undefined : normalized
}

function firstSentence(value: string): string {
  return (/^(.*?[.!?])(?:\s|$)/.exec(value)?.[1] ?? value).trim()
}

function rawJsDoc(node: ts.Node): string {
  const sourceFile = node.getSourceFile()
  const source = sourceFile.getFullText()
  const ranges = ts.getLeadingCommentRanges(source, node.getFullStart()) as ts.CommentRange[]
  const range = ranges.filter(candidate => source.slice(candidate.pos, candidate.pos + 3) === '/**').at(-1) as ts.CommentRange
  const raw = source.slice(range.pos, range.end)
  const { line } = sourceFile.getLineAndCharacterOfPosition(range.pos)
  const lineStart = sourceFile.getPositionOfLineAndCharacter(line, 0)
  const indent = source.slice(lineStart, range.pos)
  return raw.split('\n')
    .map((text, index) => index > 0 && text.startsWith(indent) ? text.slice(indent.length) : text)
    .join('\n')
}

function typertMode(node: ts.Node): 'object' | 'schema' | undefined {
  for (const tag of ts.getJSDocTags(node)) {
    if (tag.tagName.text !== 'typert') continue
    const mode = (ts.getTextOfJSDocComment(tag.comment) ?? '').trim().split(/\s+/, 1)[0]
    if (mode === 'object') return 'object'
    if (mode === '' || mode === 'schema' || mode === 'type') return 'schema'
  }
  return undefined
}

function typertServiceTag(node: ts.Node): ts.JSDocTag | undefined {
  return ts.getJSDocTags(node).find(tag => tag.tagName.text === 'typert'
    && (ts.getTextOfJSDocComment(tag.comment) ?? '').trim().split(/\s+/, 1)[0] === 'service')
}

function memberName(name: ts.PropertyName | ts.BindingName): string {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name)
    || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text
  if (ts.isComputedPropertyName(name)) return `[${name.expression.getText()}]`
  return name.getText()
}

function stringLiteralValue(node: ts.Node | undefined): string | undefined {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined
}

function isRemoteSegment(value: string): boolean {
  // Generation bootstraps workspace artifacts before dsh-typert-protocol is built,
  // so this extraction-only copy must mirror isTypertRemoteSegment().
  return value !== '.' && value !== '..' && /^[A-Za-z0-9_$.-]+$/.test(value)
}

function expressionName(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  return undefined
}

function packageExportSpecifier(packageName: string, subpath: string): string {
  return subpath === '.' ? packageName : `${packageName}${subpath.slice(1)}`
}

function visibilityOf(node: ts.Node): MemberVisibility {
  if ('name' in node && node.name !== undefined && ts.isPrivateIdentifier(node.name as ts.Node)) return 'private'
  if (hasModifier(node, ts.SyntaxKind.PrivateKeyword)) return 'private'
  if (hasModifier(node, ts.SyntaxKind.ProtectedKeyword)) return 'protected'
  return 'public'
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some(modifier => modifier.kind === kind) ?? false
}

function exposableMember(member: MemberModel): boolean {
  return member.visibility === 'public' && !member.static
}

function keywordName(kind: ts.SyntaxKind): KeywordTypeName | undefined {
  switch (kind) {
    case ts.SyntaxKind.AnyKeyword: return 'any'
    case ts.SyntaxKind.BigIntKeyword: return 'bigint'
    case ts.SyntaxKind.BooleanKeyword: return 'boolean'
    case ts.SyntaxKind.NeverKeyword: return 'never'
    case ts.SyntaxKind.NumberKeyword: return 'number'
    case ts.SyntaxKind.ObjectKeyword: return 'object'
    case ts.SyntaxKind.StringKeyword: return 'string'
    case ts.SyntaxKind.SymbolKeyword: return 'symbol'
    case ts.SyntaxKind.UndefinedKeyword: return 'undefined'
    case ts.SyntaxKind.UnknownKeyword: return 'unknown'
    case ts.SyntaxKind.VoidKeyword: return 'void'
    default: return undefined
  }
}

function literalModel(node: ts.LiteralTypeNode): Omit<Extract<TypeNodeModel, { kind: 'literal' }>, 'id'> {
  const literal = node.literal
  if (ts.isStringLiteral(literal)) return { kind: 'literal', value: literal.text, text: literal.getText() }
  if (ts.isNoSubstitutionTemplateLiteral(literal)) {
    return { kind: 'literal', value: literal.text, text: literal.getText() }
  }
  if (ts.isNumericLiteral(literal)) return { kind: 'literal', value: Number(literal.text), text: literal.getText() }
  if (ts.isBigIntLiteral(literal)) return { kind: 'literal', value: BigInt(literal.text.slice(0, -1)), text: literal.getText() }
  if (literal.kind === ts.SyntaxKind.TrueKeyword) return { kind: 'literal', value: true, text: 'true' }
  if (literal.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'literal', value: false, text: 'false' }
  if (literal.kind === ts.SyntaxKind.NullKeyword) return { kind: 'literal', value: null, text: 'null' }
  /* v8 ignore else -- all remaining LiteralTypeNode syntax is a signed numeric or bigint literal. */
  if (ts.isPrefixUnaryExpression(literal)
    && (ts.isNumericLiteral(literal.operand) || ts.isBigIntLiteral(literal.operand))) {
    return {
      kind: 'literal',
      value: ts.isBigIntLiteral(literal.operand)
        ? BigInt(literal.getText().slice(0, -1))
        : Number(literal.getText()),
      text: literal.getText(),
    }
  }
  /* v8 ignore next -- TypeScript's LiteralTypeNode grammar is exhausted above; this contains future compiler syntax. */
  throw new TypertAnalysisError(`typert: unsupported literal type ${literal.getText()}`)
}

function modifierMode(token: ts.ReadonlyKeyword | ts.PlusToken | ts.MinusToken | ts.QuestionToken | undefined):
  'add' | 'remove' | 'preserve' {
  if (token?.kind === ts.SyntaxKind.PlusToken) return 'add'
  if (token?.kind === ts.SyntaxKind.MinusToken) return 'remove'
  return token === undefined ? 'preserve' : 'add'
}

function annotationPosition(
  node: ts.Node,
  purpose: 'property' | 'parameter' | 'return',
): number {
  if (purpose === 'return') return (node as ts.SignatureDeclarationBase).parameters.end + 1
  return (node as ts.ParameterDeclaration | ts.PropertyDeclaration | ts.PropertySignature).name.end
}

function moduleSpecifierOf(node: ReferenceSite): string | undefined {
  if (ts.isImportTypeNode(node)) {
    const argument = node.argument as ts.LiteralTypeNode & { readonly literal: ts.StringLiteral }
    return argument.literal.text
  }
  const symbol = ts.isTypeReferenceNode(node)
    ? node.typeName
    : node.expression
  const sourceFile = node.getSourceFile()
  const first = ts.isIdentifier(symbol) ? symbol.text : symbol.getFirstToken(sourceFile)?.getText(sourceFile)
  return first === undefined ? undefined : importBindingOf(sourceFile, first)?.specifier
}

function authoredExportName(node: ReferenceSite, moduleSpecifier: string): string {
  if (ts.isImportTypeNode(node)) return (node.qualifier as ts.EntityName).getText().split('.')[0] as string

  const referenced = ts.isTypeReferenceNode(node)
    ? node.typeName.getText().split('.')
    : node.expression.getText().split('.')
  const localName = referenced[0] as string
  const binding = importBindingOf(node.getSourceFile(), localName)
  /* v8 ignore next -- moduleSpecifierOf returns only the import inspected by importBindingOf. */
  if (binding === undefined) throw new TypertAnalysisError(`typert: cannot recover export name for ${localName} from ${moduleSpecifier}`)
  return binding.name ?? (referenced[1] as string)
}

function importBindingOf(sourceFile: ts.SourceFile, localName: string): ImportBinding | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause === undefined
      || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const specifier = statement.moduleSpecifier.text
    if (statement.importClause.name?.text === localName) return { specifier, name: 'default' }
    const bindings = statement.importClause.namedBindings
    if (bindings === undefined) continue
    if (ts.isNamespaceImport(bindings)) {
      if (bindings.name.text === localName) return { specifier }
      continue
    }
    const element = bindings.elements.find(candidate => candidate.name.text === localName)
    if (element !== undefined) return { specifier, name: element.propertyName?.text ?? element.name.text }
  }
  return undefined
}

function importTypeAttributesText(node: ts.ImportTypeNode): string {
  const sourceFile = node.getSourceFile()
  const children = node.getChildren(sourceFile)
  const comma = children.find(child => child.kind === ts.SyntaxKind.CommaToken) as ts.Node
  const close = children.find(child => child.kind === ts.SyntaxKind.CloseParenToken) as ts.Node
  return sourceFile.text.slice(comma.end, close.pos).trim()
}

function moduleIdentity(specifier: string): ModuleIdentity | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return undefined
  const parts = specifier.split('/')
  const packageLength = specifier.startsWith('@') ? 2 : 1
  const packageName = parts.slice(0, packageLength).join('/')
  const rest = parts.slice(packageLength).join('/')
  return {
    package: packageName,
    subpath: rest.length === 0 ? '.' : `./${rest}`,
  }
}

function externalModuleIdentityForFile(file: string): ModuleIdentity | undefined {
  const normalized = slash(file)
  const marker = '/node_modules/'
  const index = normalized.lastIndexOf(marker)
  if (index < 0) return undefined
  const parts = normalized.slice(index + marker.length).split('/')
  const packageLength = (parts[0] as string).startsWith('@') ? 2 : 1
  const packageName = parts.slice(0, packageLength).join('/')
  return { package: packageName, subpath: '.' }
}

function isStandardLibraryFile(file: string): boolean {
  const base = file.replaceAll('\\', '/')
  return /\/typescript\/lib\/lib\.[^/]+\.d\.ts$/.test(base)
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
}

function formatProgramDiagnostic(root: string, face: TypertFace, diagnostic: ts.DiagnosticWithLocation): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
  const file = slash(relative(root, diagnostic.file.fileName))
  return `typert(${face}): ${file}:${String(position.line + 1)}:${String(position.character + 1)}: TypeScript TS${String(diagnostic.code)}: ${message}`
}

const realPathCache = new Map<string, string>()

function realPath(path: string): string {
  const absolute = resolve(path)
  const cached = realPathCache.get(absolute)
  if (cached !== undefined) return cached
  // Only existing paths are memoized: a path can come into existence later,
  // but an existing path's canonical form is stable for the process lifetime
  // (analysis edits rewrite file contents, never the directory tree).
  if (!existsSync(absolute)) return absolute
  const resolved = realpathSync(absolute)
  realPathCache.set(absolute, resolved)
  return resolved
}

function isWithin(path: string, root: string): boolean {
  const absolute = realPath(path)
  const parent = realPath(root)
  return absolute === parent || absolute.startsWith(parent + sep)
}

function slash(value: string): string {
  return value.replaceAll('\\', '/')
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const result = new Map<string, T>()
  for (const value of values) if (!result.has(key(value))) result.set(key(value), value)
  return [...result.values()]
}

function compareCrossFaceLinks(left: CrossFaceLink, right: CrossFaceLink): number {
  return left.fromFace.localeCompare(right.fromFace)
    || left.fromPackage.localeCompare(right.fromPackage)
    || left.toFace.localeCompare(right.toFace)
    || left.toPackage.localeCompare(right.toPackage)
    || left.subpath.localeCompare(right.subpath)
    || left.name.localeCompare(right.name)
}
