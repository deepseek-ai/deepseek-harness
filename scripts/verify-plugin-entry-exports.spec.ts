/**
 * Tests for the plugin entry export gate: which entries it checks, which export forms it reports, how the
 * existing-export list is validated, and how it fails when an entry goes unchecked.
 *
 * The fixture compiles its own `tsconfig.host.json` and `tsconfig.client.json`, with a stand-in Cordis `Service` at
 * the path the repository maps `@deepseek-ai/cordis` to.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  ENTRY_GLOB,
  EXISTING_EXPORTS_FILE,
  discoverEntries,
  scanFailures,
  scanRepository,
} from './verify-plugin-entry-exports.ts'

const compilerOptions = {
  target: 'es2022',
  module: 'esnext',
  moduleResolution: 'bundler',
  noEmit: true,
  skipLibCheck: true,
  types: [],
  paths: { '@deepseek-ai/cordis': ['./vendor/cordis/src/index.ts'] },
}

const manifest = (name: string): string => JSON.stringify({ name, version: '0.0.1' })

const PLUGIN_ENTRY = [
  "import { Service } from '@deepseek-ai/cordis'",
  '',
  // The Loader fields, with Config as both an interface and a value.
  "export const name = 'plugin'",
  "export const inject = ['tools']",
  'export interface Config { limit: number }',
  'export const Config = (config: Config): Config => config',
  'export function apply(): void {}',
  // Types, in every form the compiler erases.
  'export interface Shape { a: number }',
  'export type Alias = string',
  "export type { Remote as RemoteAlias } from './types.ts'",
  "export { type Remote } from './types.ts'",
  "export { Remote as RemoteAgain } from './types.ts'",
  "export type * from './type-star.ts'",
  // Classes judged by what they construct.
  'export class DirectError extends Error {}',
  'export class IndirectError extends DirectError {}',
  'class Detailed<T> extends Error { declare readonly detail?: T }',
  'export class GenericError extends Detailed<string> {}',
  'export class DirectService extends Service {}',
  'export class GenericService extends Service<string> {}',
  'export const ExpressionError = class extends Error {}',
  'function Tagged<Base extends new (...args: any[]) => object>(base: Base) {',
  "  return class extends base { readonly tag = 'tagged' }",
  '}',
  'export class MixedError extends Tagged(Error) {}',
  // Values the rule does not allow.
  'export function helper(): void {}',
  'export const LIMIT = 3',
  'export const PATTERN = /x/u',
  'export enum Mode { A }',
  'export namespace Space { export const inner = 1 }',
  'export class Plain {}',
  'export const PlainExpression = class {}',
  'export class MixedPlain extends Tagged(class {}) {}',
  "export type Id = string & { readonly brand: 'Id' }",
  'export function Id(value: string): Id { return value as Id }',
  "export * from './values.ts'",
  "export * as namespaced from './values.ts'",
  "export { helperImpl as renamed } from './values.ts'",
  "export { missing } from './missing.ts'",
  "export * from './gone.ts'",
  '',
].join('\n')

const FIXTURE: Record<string, string> = {
  'tsconfig.host.json': JSON.stringify({
    compilerOptions,
    include: ['vendor/**/*.ts', 'packages/**/*.ts'],
    exclude: ['packages/f/client-only/**', 'packages/f/orphan/**'],
  }),
  'tsconfig.client.json': JSON.stringify({ compilerOptions, include: ['packages/f/client-only/**/*.ts'] }),
  'vendor/cordis/src/index.ts': 'export abstract class Service<T = never> { declare readonly value?: T }\n',

  'packages/f/plugin/package.json': manifest('@f/plugin'),
  'packages/f/plugin/src/index.ts': PLUGIN_ENTRY,
  'packages/f/plugin/src/types.ts': 'export interface Remote { b: string }\n',
  'packages/f/plugin/src/type-star.ts': 'export interface StarShape { c: number }\nexport const hiddenByTypeStar = 1\n',
  'packages/f/plugin/src/values.ts': [
    'export const starred = 1',
    'export interface StarredShape { d: number }',
    'export function helperImpl(): void {}',
    '',
  ].join('\n'),

  // A value `apply` makes an entry a function plugin, in each form an entry can export it.
  'packages/f/const-apply/package.json': manifest('@f/const-apply'),
  'packages/f/const-apply/src/index.ts': 'export const apply = (): void => {}\nexport const extra = 1\n',
  'packages/f/reexport-apply/package.json': manifest('@f/reexport-apply'),
  'packages/f/reexport-apply/src/index.ts': "export { apply } from './apply.ts'\nexport const extra = 1\n",
  'packages/f/reexport-apply/src/apply.ts': 'export function apply(): void {}\n',
  'packages/f/with-default/package.json': manifest('@f/with-default'),
  'packages/f/with-default/src/index.ts': 'export function apply(): void {}\nexport default apply\n',
  // A Service class as the default export beside apply: the Loader loads it instead of the namespace.
  'packages/f/default-service/package.json': manifest('@f/default-service'),
  'packages/f/default-service/src/index.ts': [
    "import { Service } from '@deepseek-ai/cordis'",
    'export function apply(): void {}',
    'export default class Mixed extends Service {}',
    '',
  ].join('\n'),

  // Run-time export paths: an erased `export type` does not hide the value `export *` brings in under its name, and a
  // name that only a nested `export type *` reaches is a type, including an `apply` that reaches the entry that way.
  'packages/f/type-shadow/package.json': manifest('@f/type-shadow'),
  'packages/f/type-shadow/src/index.ts': [
    'export function apply(): void {}',
    "export type { hidden } from './value.ts'",
    "export * from './value.ts'",
    '',
  ].join('\n'),
  'packages/f/type-shadow/src/value.ts': 'export const hidden = 1\n',
  'packages/f/type-barrel/package.json': manifest('@f/type-barrel'),
  'packages/f/type-barrel/src/index.ts': "export function apply(): void {}\nexport * from './barrel.ts'\n",
  'packages/f/type-barrel/src/barrel.ts': "export type * from './value.ts'\n",
  'packages/f/type-barrel/src/value.ts': 'export const hidden = 1\n',
  'packages/f/type-apply/package.json': manifest('@f/type-apply'),
  'packages/f/type-apply/src/index.ts': "export * from './barrel.ts'\n",
  'packages/f/type-apply/src/barrel.ts': "export type * from './impl.ts'\n",
  'packages/f/type-apply/src/impl.ts': 'export function apply(): void {}\nexport const extra = 1\n',

  // Base classes that only share a name with Error and Service are not the allowed roots.
  'packages/f/fake-base/package.json': manifest('@f/fake-base'),
  'packages/f/fake-base/src/index.ts': [
    'export function apply(): void {}',
    'class Error {}',
    'class Service {}',
    'export class FakeError extends Error {}',
    'export class FakeService extends Service {}',
    '',
  ].join('\n'),

  // A service plugin entry default-exports a class the Loader constructs. Beside it pass other names for the same class,
  // types, and Service or Error classes; `Config` and other values are reported, because the Loader reads the class.
  'packages/f/service/package.json': manifest('@f/service'),
  'packages/f/service/src/index.ts': [
    "import { Service } from '@deepseek-ai/cordis'",
    'export default class Store extends Service {}',
    'export { Store as NamedStore }',
    'export class StoreError extends Error {}',
    'export interface StoreShape { a: number }',
    'export const helper = 1',
    'export const Config = { limit: 1 }',
    '',
  ].join('\n'),
  'packages/f/plain-class/package.json': manifest('@f/plain-class'),
  'packages/f/plain-class/src/index.ts': [
    'export default class Plain {}',
    'export { Plain }',
    'export function plainHelper(): void {}',
    '',
  ].join('\n'),

  // Entries the Loader cannot load as a plugin are not checked: a library, an abstract default class that defines a
  // capability seam, and a default export that is not a class.
  'packages/f/library/package.json': manifest('@f/library'),
  'packages/f/library/src/index.ts': 'export const util = 1\n',
  'packages/f/seam/package.json': manifest('@f/seam'),
  'packages/f/seam/src/index.ts': [
    "import { Service } from '@deepseek-ai/cordis'",
    'export default abstract class Definition extends Service {}',
    'export const seamHelper = 1',
    '',
  ].join('\n'),
  'packages/f/default-function/package.json': manifest('@f/default-function'),
  'packages/f/default-function/src/index.ts': 'export default function plugin(): void {}\nexport const fnHelper = 1\n',

  // Only the Client face compiles this entry; no face compiles the orphan.
  'packages/f/client-only/package.json': manifest('@f/client-only'),
  'packages/f/client-only/src/index.ts': 'export function apply(): void {}\nexport const clientValue = 1\n',
  'packages/f/orphan/package.json': manifest('@f/orphan'),
  'packages/f/orphan/src/index.ts': 'export function apply(): void {}\n',

  'packages/f/listed/package.json': manifest('@f/listed'),
  'packages/f/listed/src/index.ts': [
    'export function apply(): void {}',
    'export const kept = 1',
    'export const alsoKept = 2',
    'export interface Typed { a: number }',
    'export class ListedError extends Error {}',
    '',
  ].join('\n'),
}

const EXISTING = {
  '@f/listed': ['kept', 'alsoKept', 'kept', 'gone', 'Typed', 'ListedError'],
  '@f/library': ['util'],
  '@f/unknown': ['value'],
  '@f/const-apply': [],
  '@f/orphan': ['anything'],
}

function writeFixture(files: Record<string, string>, prefix: string): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), prefix))
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(fixtureRoot, rel)), { recursive: true })
    writeFileSync(join(fixtureRoot, rel), content)
  }
  return fixtureRoot
}

function lineOf(text: string, line: string): number {
  return text.split('\n').indexOf(line) + 1
}

const root = writeFixture(FIXTURE, 'plugin-entry-exports-')
const emptyRoot = writeFixture({
  'tsconfig.host.json': JSON.stringify({ compilerOptions, include: ['packages/**/*.ts'] }),
  'packages/f/library/package.json': manifest('@f/library'),
  'packages/f/library/src/index.ts': 'export const util = 1\n',
}, 'plugin-entry-exports-empty-')
const namelessRoot = writeFixture({
  'packages/f/nameless/package.json': JSON.stringify({ version: '0.0.1' }),
  'packages/f/nameless/src/index.ts': 'export function apply(): void {}\n',
}, 'plugin-entry-exports-nameless-')
const result = scanRepository(root, EXISTING)

afterAll(() => {
  for (const fixtureRoot of [root, emptyRoot, namelessRoot]) rmSync(fixtureRoot, { recursive: true, force: true })
})

describe('function plugin entry exports', () => {
  it('reports every value beyond the Loader fields, types, and Service or Error classes', () => {
    expect(result.violations.map(value => `${value.packageName} ${value.exportName}`)).toEqual([
      '@f/client-only clientValue',
      '@f/const-apply extra',
      '@f/default-service default',
      '@f/fake-base FakeError',
      '@f/fake-base FakeService',
      '@f/plain-class plainHelper',
      '@f/plugin helper',
      '@f/plugin LIMIT',
      '@f/plugin PATTERN',
      '@f/plugin Mode',
      '@f/plugin Space',
      '@f/plugin Plain',
      '@f/plugin PlainExpression',
      '@f/plugin MixedPlain',
      '@f/plugin Id',
      '@f/plugin helperImpl',
      '@f/plugin starred',
      '@f/plugin namespaced',
      '@f/plugin renamed',
      '@f/plugin missing',
      '@f/plugin *',
      '@f/reexport-apply extra',
      '@f/service helper',
      '@f/service Config',
      '@f/type-shadow hidden',
      '@f/with-default default',
    ])
  })

  it('follows run-time export paths through type-only exports', () => {
    const shadow = result.violations.find(value => value.packageName === '@f/type-shadow')
    expect(shadow).toMatchObject({ exportName: 'hidden', line: 3, unresolved: false })
    expect(result.violations.some(value => value.packageName === '@f/type-barrel' || value.packageName === '@f/type-apply'))
      .toBe(false)
  })

  it('reports a default export beside apply even when it is a Service class', () => {
    expect(result.violations.filter(value => value.exportName === 'default').map(value => value.packageName))
      .toEqual(['@f/default-service', '@f/with-default'])
  })

  it('checks entries that export a value apply or default-export a class the Loader constructs', () => {
    expect(result.checkedEntries).toEqual({ function: 10, service: 2 })
    const unchecked = new Set(['@f/library', '@f/seam', '@f/default-function', '@f/type-apply'])
    expect(result.violations.some(value => unchecked.has(value.packageName))).toBe(false)
  })

  it('locates a star re-export at its statement and a renamed re-export at its specifier', () => {
    const lines = Object.fromEntries(result.violations
      .filter(value => value.packageName === '@f/plugin')
      .map(value => [value.exportName, value.line]))
    expect(lines.starred).toBe(lineOf(PLUGIN_ENTRY, "export * from './values.ts'"))
    expect(lines.helperImpl).toBe(lineOf(PLUGIN_ENTRY, "export * from './values.ts'"))
    expect(lines.renamed).toBe(lineOf(PLUGIN_ENTRY, "export { helperImpl as renamed } from './values.ts'"))
    expect(lines.Id).toBe(lineOf(PLUGIN_ENTRY, 'export function Id(value: string): Id { return value as Id }'))
  })

  it('names the file, line, package, and export, and marks an export whose target does not resolve', () => {
    const failures = scanFailures(result)
    expect(failures).toContain('packages/f/const-apply/src/index.ts:2 @f/const-apply exports extra')
    expect(failures).toContain(`packages/f/plugin/src/index.ts:${String(lineOf(PLUGIN_ENTRY, "export { missing } from './missing.ts'"))}`
      + ' @f/plugin exports missing, whose target does not resolve')
    expect(failures).toContain(`packages/f/plugin/src/index.ts:${String(lineOf(PLUGIN_ENTRY, "export * from './gone.ts'"))}`
      + ' @f/plugin exports *, whose target does not resolve')
  })

  it('reads the Client face and fails an entry that no face compiles', () => {
    expect(result.unloadedEntries).toEqual(['packages/f/orphan/src/index.ts'])
    expect(scanFailures(result)).toContain('packages/f/orphan/src/index.ts is compiled by neither'
      + ' tsconfig.host.json nor tsconfig.client.json, so its exports go unchecked')
  })
})

describe('existing-export list', () => {
  it('passes a listed export', () => {
    expect(result.violations.some(value => value.packageName === '@f/listed')).toBe(false)
    expect(result.listedExports).toBe(2)
  })

  it('fails unknown packages, entries that are not plugins, empty lists, repeats, and exports no longer reported', () => {
    const entry = 'packages/f/listed/src/index.ts'
    expect(result.listProblems).toEqual([
      '@f/listed lists kept more than once; keep one',
      `@f/listed lists gone, which ${entry} no longer exports beyond the rule; remove it`,
      `@f/listed lists Typed, which ${entry} no longer exports beyond the rule; remove it`,
      `@f/listed lists ListedError, which ${entry} no longer exports beyond the rule; remove it`,
      '@f/library: packages/f/library/src/index.ts is not a plugin entry; remove its line',
      `@f/unknown has no ${ENTRY_GLOB} entry; remove its line`,
      '@f/const-apply lists no exports; remove its line',
    ])
    expect(scanFailures(result)).toContain(`${EXISTING_EXPORTS_FILE}: @f/const-apply lists no exports; remove its line`)
  })
})

describe('entry corpus', () => {
  it('fails when no function plugin entry or no service plugin entry is found', () => {
    const empty = scanRepository(emptyRoot, {}, ['host'])
    expect(empty.checkedEntries).toEqual({ function: 0, service: 0 })
    expect(scanFailures(empty)).toEqual([
      `no function plugin entry matches ${ENTRY_GLOB}; entry discovery or classification is broken`,
      `no service plugin entry matches ${ENTRY_GLOB}; entry discovery or classification is broken`,
    ])
  })

  it('rejects an entry whose package manifest has no name', () => {
    expect(() => discoverEntries(namelessRoot)).toThrow('packages/f/nameless/package.json has no string name')
  })
})
