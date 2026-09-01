/**
 * Package-invariant companion discovery and structural checks.
 * The runtime registry stays product-independent; this gate keeps each
 * published companion complete without requiring synthetic empty companions.
 */

import { existsSync, globSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { usesFlattenedPackageDependencies } from './package-dependency-policy.ts'

/** Package README sentence that records why an invariant companion is omitted. */
const OMITTED_COMPANION_REASON = /No (?:(?:runtime )?invariant )?companion is published(?: because|[.:;—])\s+\S/i

interface PackageManifest {
  name?: string
  dsh?: unknown
  exports?: Record<string, { types?: string; default?: string } | string | null | undefined>
  files?: string[]
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

/** One package and the files participating in its invariant publication rules. */
export interface PackageInvariantOwner {
  readonly dir: string
  readonly manifestPath: string
  readonly sourcePath: string
  readonly packageName: string
}

/** One gate violation with a repo-relative owner path. */
export interface PackageInvariantViolation {
  readonly path: string
  readonly message: string
}

/** Discover packages that own an invariant companion. */
export function packageInvariantOwners(root: string): PackageInvariantOwner[] {
  return packageInvariantPackages(root)
    .filter(owner => existsSync(resolve(root, owner.sourcePath)))
}

/** Discover every package under the repository package tree. */
function packageInvariantPackages(root: string): PackageInvariantOwner[] {
  return globSync('packages/*/*/package.json', { cwd: root })
    .map(path => path.split(sep).join('/'))
    .sort()
    .map((manifestPath) => {
      const manifest = readManifest(resolve(root, manifestPath))
      if (manifest.name === undefined || manifest.name === '') {
        throw new Error(`${manifestPath}: package invariant owner must declare a package name`)
      }
      const dir = dirname(manifestPath)
      return {
        dir,
        manifestPath,
        sourcePath: `${dir}/src/invariant.ts`,
        packageName: manifest.name,
      }
    })
}

/** Return all violations of the package-invariant companion rules. */
export function collectPackageInvariantViolations(root: string): PackageInvariantViolation[] {
  const violations: PackageInvariantViolation[] = []
  for (const owner of packageInvariantPackages(root)) {
    const manifest = readManifest(resolve(root, owner.manifestPath))
    const hasCompanion = existsSync(resolve(root, owner.sourcePath))
    checkManifest(owner, manifest, hasCompanion, violations)
    checkBuild(owner, root, hasCompanion, violations)
    if (hasCompanion) {
      checkSource(owner, root, violations)
    } else {
      checkOmissionReason(owner, root, violations)
    }
  }
  return violations
}

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
}

function addViolation(
  violations: PackageInvariantViolation[],
  path: string,
  message: string,
): void {
  violations.push({ path, message })
}

function checkManifest(
  owner: PackageInvariantOwner,
  manifest: PackageManifest,
  hasCompanion: boolean,
  violations: PackageInvariantViolation[],
): void {
  const invariantExport = manifest.exports?.['./invariant']
  if (!hasCompanion) {
    if (invariantExport !== undefined) {
      addViolation(
        violations,
        owner.manifestPath,
        'exports["./invariant"] must be omitted when src/invariant.ts is absent',
      )
    }
    if (manifest.files?.includes('lib/invariant.js')) {
      addViolation(
        violations,
        owner.manifestPath,
        'files must omit lib/invariant.js when src/invariant.ts is absent',
      )
    }
    return
  }
  if (typeof invariantExport !== 'object'
    || invariantExport === null
    || invariantExport.types !== './lib/types/invariant.d.ts'
    || invariantExport.default !== './lib/invariant.js') {
    addViolation(
      violations,
      owner.manifestPath,
      'exports["./invariant"] must target ./lib/types/invariant.d.ts and ./lib/invariant.js',
    )
  }
  if (!manifest.files?.includes('lib/invariant.js')) {
    addViolation(violations, owner.manifestPath, 'files must publish lib/invariant.js')
  }
  if (owner.packageName === '@deepseek-ai/dsh-invariants') return
  const developmentOnlyInvariant = usesFlattenedPackageDependencies(
    owner.manifestPath,
    owner.packageName,
    manifest.dsh,
  )
  const expectedRange = 'workspace:^'
  const peerRange = manifest.peerDependencies?.['@deepseek-ai/dsh-invariants']
  if (developmentOnlyInvariant ? peerRange !== undefined : peerRange !== expectedRange) {
    addViolation(violations, owner.manifestPath, developmentOnlyInvariant
      ? '@deepseek-ai/dsh-invariants must not be a peerDependency under this package dependency policy'
      : '@deepseek-ai/dsh-invariants must be a workspace:^ peerDependency')
  }
  if (manifest.devDependencies?.['@deepseek-ai/dsh-invariants'] !== expectedRange) {
    addViolation(
      violations,
      owner.manifestPath,
      `@deepseek-ai/dsh-invariants must be a ${expectedRange} devDependency`,
    )
  }
}

function checkBuild(
  owner: PackageInvariantOwner,
  root: string,
  hasCompanion: boolean,
  violations: PackageInvariantViolation[],
): void {
  const tsconfigPath = `${owner.dir}/tsconfig.json`
  if (hasCompanion
    && owner.packageName !== '@deepseek-ai/dsh-invariants'
    && !projectReferencesInvariants(root, owner.dir, tsconfigPath)) {
    addViolation(
      violations,
      tsconfigPath,
      'TypeScript project references must include ../../runtime-diagnostics/invariants',
    )
  } else if (!hasCompanion && projectReferencesInvariants(root, owner.dir, tsconfigPath)) {
    addViolation(
      violations,
      tsconfigPath,
      'TypeScript project references must omit ../../runtime-diagnostics/invariants when src/invariant.ts is absent',
    )
  }

  const configPath = `${owner.dir}/tsdown.config.ts`
  if (!existsSync(resolve(root, configPath))) return
  const source = readFileSync(resolve(root, configPath), 'utf8')
  const bundlesCompanion = source.includes('lib/types/invariant.js')
  if (hasCompanion && !bundlesCompanion) {
    addViolation(violations, configPath, 'package build override must bundle lib/types/invariant.js')
  } else if (!hasCompanion && bundlesCompanion) {
    addViolation(
      violations,
      configPath,
      'package build override must omit lib/types/invariant.js when src/invariant.ts is absent',
    )
  }
}

function checkOmissionReason(
  owner: PackageInvariantOwner,
  root: string,
  violations: PackageInvariantViolation[],
): void {
  const readmePath = `${owner.dir}/README.md`
  const absolutePath = resolve(root, readmePath)
  if (!existsSync(absolutePath) || !OMITTED_COMPANION_REASON.test(readFileSync(absolutePath, 'utf8'))) {
    addViolation(
      violations,
      readmePath,
      'omitted companion requires a README "No ... companion is published" reason sentence',
    )
  }
}

function projectReferencesInvariants(root: string, ownerDir: string, entryPath: string): boolean {
  const ownerRoot = resolve(root, ownerDir)
  const target = resolve(root, 'packages/runtime-diagnostics/invariants')
  const pending = [resolve(root, entryPath)]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const configPath = pending.pop()
    if (configPath === undefined) break
    if (visited.has(configPath)) continue
    visited.add(configPath)
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      references?: Array<{ path?: string }>
    }
    for (const reference of config.references ?? []) {
      if (reference.path === undefined) continue
      const referenced = resolve(dirname(configPath), reference.path)
      if (referenced === target) return true
      if (!referenced.startsWith(`${ownerRoot}${sep}`)) continue
      const childConfig = referenced.endsWith('.json') ? referenced : resolve(referenced, 'tsconfig.json')
      if (existsSync(childConfig)) pending.push(childConfig)
    }
  }
  return false
}

function checkSource(
  owner: PackageInvariantOwner,
  root: string,
  violations: PackageInvariantViolation[],
): void {
  const absolutePath = resolve(root, owner.sourcePath)
  const sourceText = readFileSync(absolutePath, 'utf8')
  if (sourceText.includes('@generated')) {
    addViolation(
      violations,
      owner.sourcePath,
      'invariant companions must be hand-owned and may not carry @generated markers',
    )
  }

  const sourceFile = ts.createSourceFile(
    absolutePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const constants = topLevelStringConstants(sourceFile)
  const registrations: string[] = []
  const unresolved: number[] = []
  const mismatchedInstallers: number[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isInvariantRegistration(node.expression)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
      const argument = node.arguments[0]
      const packageName = argument === undefined ? undefined : stringValue(argument, constants)
      if (packageName === undefined) unresolved.push(line)
      else registrations.push(packageName)
      const installer = node.arguments[1]
      if (installer === undefined || !ts.isIdentifier(installer) || installer.text !== 'install') {
        mismatchedInstallers.push(line)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  for (const line of unresolved) {
    addViolation(
      violations,
      owner.sourcePath,
      `line ${line}: ctx.invariants.register package name must resolve to a local string constant`,
    )
  }
  for (const line of mismatchedInstallers) {
    addViolation(
      violations,
      owner.sourcePath,
      `line ${line}: ctx.invariants.register must use the checked local install function`,
    )
  }
  if (registrations.length !== 1 || registrations[0] !== owner.packageName) {
    addViolation(
      violations,
      owner.sourcePath,
      `must register exactly its own package name ${JSON.stringify(owner.packageName)}; saw ${JSON.stringify(registrations)}`,
    )
  }
  for (const exportedName of ['name', 'inject', 'apply']) {
    if (!hasNamedExport(sourceFile, exportedName)) {
      addViolation(violations, owner.sourcePath, `must named-export ${exportedName}`)
    }
  }
  if (hasDefaultExport(sourceFile)) {
    addViolation(violations, owner.sourcePath, 'must not default-export; Loader must retain the companion namespace')
  }
  checkInstaller(owner, sourceFile, violations)
}

function checkInstaller(
  owner: PackageInvariantOwner,
  sourceFile: ts.SourceFile,
  violations: PackageInvariantViolation[],
): void {
  let initializer: ts.Expression | undefined
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)
        && declaration.name.text === 'install'
        && declaration.initializer !== undefined) {
        initializer = declaration.initializer
      }
    }
  }
  const installer = initializer === undefined ? undefined : installerFunction(initializer)
  if (installer === undefined) {
    addViolation(violations, owner.sourcePath, 'must declare a local install function for package-owned checks')
    return
  }
  if (ts.isBlock(installer.body) && installer.body.statements.length === 0) {
    addViolation(
      violations,
      owner.sourcePath,
      'empty install function is unnecessary; omit the companion and its publication wiring',
    )
    return
  }
  const reporter = installer.parameters[1]?.name
  if (reporter === undefined || !ts.isIdentifier(reporter)) {
    addViolation(violations, owner.sourcePath, 'install function must accept the bound failure reporter as its second parameter')
    return
  }
  if (!usesIdentifier(installer.body, reporter.text)) {
    addViolation(violations, owner.sourcePath, 'install function must use its bound failure reporter')
  }
}

function usesIdentifier(node: ts.Node, name: string): boolean {
  return ts.isIdentifier(node) && node.text === name
    || node.getChildren().some(child => usesIdentifier(child, name))
}

function installerFunction(
  initializer: ts.Expression,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return initializer
  if (ts.isCallExpression(initializer)
    && ts.isPropertyAccessExpression(initializer.expression)
    && ts.isIdentifier(initializer.expression.expression)
    && initializer.expression.expression.text === 'Object'
    && initializer.expression.name.text === 'assign') {
    const target = initializer.arguments[0]
    if (target !== undefined && (ts.isArrowFunction(target) || ts.isFunctionExpression(target))) return target
  }
  return undefined
}

function topLevelStringConstants(sourceFile: ts.SourceFile): ReadonlyMap<string, string> {
  const constants = new Map<string, string>()
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue
      const value = stringValue(declaration.initializer, constants)
      if (value !== undefined) constants.set(declaration.name.text, value)
    }
  }
  return constants
}

function stringValue(node: ts.Expression, constants: ReadonlyMap<string, string>): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isIdentifier(node)) return constants.get(node.text)
  return undefined
}

function isInvariantRegistration(expression: ts.LeftHandSideExpression): boolean {
  return ts.isPropertyAccessExpression(expression)
    && expression.name.text === 'register'
    && ts.isPropertyAccessExpression(expression.expression)
    && expression.expression.name.text === 'invariants'
}

function hasNamedExport(sourceFile: ts.SourceFile, name: string): boolean {
  return sourceFile.statements.some((statement) => {
    if (!ts.isVariableStatement(statement)
      || !statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) return false
    return statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name)
  })
}

function hasDefaultExport(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some((statement) => {
    if (ts.isExportAssignment(statement)) return true
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined
    if (modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) return true
    if (!ts.isExportDeclaration(statement) || statement.exportClause === undefined) return false
    if (ts.isNamespaceExport(statement.exportClause)) {
      return statement.exportClause.name.text === 'default'
    }
    return statement.exportClause.elements.some(element => element.name.text === 'default')
  })
}

/** Format violations for the command-line gate. */
export function formatPackageInvariantViolation(
  root: string,
  violation: PackageInvariantViolation,
): string {
  const path = resolve(root, violation.path)
  return `${relative(root, path)}: ${violation.message}`
}
