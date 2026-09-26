/** Keyless schema inspection through the published CLI, with native Schemastery fixtures. */

import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { Ajv2020 } from 'ajv/dist/2020.js'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { ConfigSchemaDump } from '@deepseek-ai/dsh-app-boot'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it, onTestFinished } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const builtBin = join(repoRoot, 'apps/cli/lib/bin.js')
const builtArtifactsExist = existsSync(builtBin)
if (process.env.DSH_EXAMPLE_MODE === 'lib' && !builtArtifactsExist) {
  throw new Error('dsh config-schema acceptance requires built CLI artifacts in lib mode; run pnpm run build first')
}
const packageName = 'dsh-schema-acceptance-fixture'
const profileName = 'schema-acceptance'
const processTimeoutMs = 90_000
const schemaImport = "import Schema from '@deepseek-ai/schemastery'"
const forbiddenApply = `
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
export function apply() {
  writeFileSync(join(process.env.DSH_HOME, 'apply-ran'), 'unexpected')
  throw new Error('PLUGIN_APPLY_EXECUTED')
}
`

interface Fixture {
  root: string
  home: string
  profile: string
}

async function createFixture(modules: Record<string, string>, patches: string): Promise<Fixture> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-schema-acceptance-')))
  onTestFinished(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const home = join(root, 'home')
  const profile = join(home, 'profiles', profileName)
  const moduleDir = join(profile, 'node_modules', packageName)
  await mkdir(moduleDir, { recursive: true })
  await writeFile(join(moduleDir, 'package.json'), JSON.stringify({
    name: packageName,
    version: '1.0.0',
    type: 'module',
    exports: Object.fromEntries(Object.keys(modules).map(name => [`./${name}`, `./${name}.mjs`])),
    peerDependencies: { '@deepseek-ai/schemastery': '*' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  for (const [name, source] of Object.entries(modules)) {
    await writeFile(join(moduleDir, `${name}.mjs`), `${source}\n`)
  }
  await writeFile(join(moduleDir, 'cordis.patch.yml'), patches)
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-schema-acceptance',
    private: true,
    dependencies: { [packageName]: '1.0.0' },
    dsh: { profile: { bundles: [packageName] } },
  }))
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
  return { root, home, profile }
}

async function installNativeInclude(fixture: Fixture): Promise<void> {
  const name = '@deepseek-ai/cordis-plugin-include'
  const directory = join(fixture.profile, 'node_modules', name)
  await mkdir(directory, { recursive: true })
  await copyFile(join(repoRoot, 'vendor/include/lib/index.js'), join(directory, 'index.js'))
  await writeFile(join(directory, 'package.json'), JSON.stringify({
    name, version: '1.0.3', type: 'module', exports: './index.js',
    peerDependencies: { '@deepseek-ai/cordis': '*', '@deepseek-ai/cordis-plugin-loader': '*' },
    dependencies: { 'js-yaml': '*' },
  }))
  const path = join(fixture.profile, 'package.json')
  const manifest = JSON.parse(await readFile(path, 'utf8')) as { dependencies: Record<string, string> }
  manifest.dependencies[name] = '1.0.3'
  await writeFile(path, JSON.stringify(manifest))
}

async function dump(
  fixture: Fixture,
  args: readonly string[] = [],
  format: '--dump-config-schema' | '--dump-config' = '--dump-config-schema',
) {
  const env = Object.fromEntries(Object.entries(process.env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined
      && !/KEY|SECRET|TOKEN|PASSWORD/i.test(entry[0])
      && !/^(DSH_|NODE_OPTIONS$|NODE_PATH$)/i.test(entry[0]),
  ))
  const result = await execa(process.execPath, [
    builtBin, '--profile', profileName, format, ...args,
  ], {
    cwd: fixture.root,
    env: { ...env, DSH_HOME: fixture.home, DSH_TELEMETRY_DISABLED: '1' },
    extendEnv: false,
    input: '',
    timeout: processTimeoutMs,
    killSignal: 'SIGKILL',
    reject: false,
  })
  expect(result.timedOut, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(false)
  expect(result.signal, result.stderr).toBeUndefined()
  expect(existsSync(join(fixture.home, 'apply-ran'))).toBe(false)
  return result
}

function parseSchema(output: string): ConfigSchemaDump {
  const document = JSON.parse(output) as ConfigSchemaDump
  expect(document.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
  const validator = new Ajv2020({ strict: false, validateFormats: false })
  expect(validator.validateSchema(document), JSON.stringify(validator.errors)).toBe(true)
  return document
}

const namespaceModule = `${schemaImport}
console.log('schema fixture imported')
const label = Schema.string().description('Display label').default('schema-default')
export const Config = Schema.object({
  label,
  alias: label,
  attempts: Schema.number().min(1).max(7).default(3),
}).description('Namespace settings')
${forbiddenApply}`

const classModule = `${schemaImport}
export default class ClassPlugin {
  static Config = Schema.object({ enabled: Schema.boolean().default(true) })
  constructor() { throw new Error('PLUGIN_CONSTRUCTOR_EXECUTED') }
}`

describe.skipIf(!builtArtifactsExist)('dsh --dump-config-schema assembled output', () => {
  it('prints native namespace and class schemas without applying plugins or evaluating !!js', async () => {
    const fixture = await createFixture({
      namespace: namespaceModule,
      class: classModule,
      absent: forbiddenApply,
    }, `- insert:
    - id: schema-namespace
      name: ${packageName}/namespace
      config:
        label: PRIVATE_ACTUAL_CONFIG_VALUE
        attempts: 6
        expression: !!js (() => { throw new Error('CONFIG_EXPRESSION_EXECUTED') })()
    - id: schema-class
      name: ${packageName}/class
      disabled: !!js (() => { throw new Error('DISABLED_EXPRESSION_EXECUTED') })()
    - id: schema-absent
      name: ${packageName}/absent
`)
    const result = await dump(fixture)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stderr).toBe('schema fixture imported')
    expect(result.stdout).not.toContain('PRIVATE_ACTUAL_CONFIG_VALUE')
    expect(result.stdout).not.toContain('EXPRESSION_EXECUTED')
    const document = parseSchema(result.stdout)
    await expect(`${result.stdout}\n`).toMatchFileSnapshot('./expected/dump-config-schema.json')
    const composed = await dump(fixture, [], '--dump-config')
    const validator = new Ajv2020({ strict: false, validateFormats: false })
    const validate = validator.compile(document)
    expect(validate(yaml.load(composed.stdout, { schema: entryListSchema })), JSON.stringify(validate.errors)).toBe(true)
    expect(validate([{ name: `${packageName}/namespace`, config: { attempts: 'wrong' } }])).toBe(false)
    const patch = validator.compile({ $schema: document.$schema, $defs: document.$defs, $ref: '#/$defs/patchList' })
    expect(patch([{ id: 'schema-class', config: { enabled: 'wrong' } }])).toBe(false)
    expect(patch([{ id: 'schema-class', config: { enabled: false } }])).toBe(true)
    expect(result.stdout).not.toContain('"uid"')
  })

  it.each([false, true])('expands canonical Include and re-export aliases with profile-local copy: %s', async (localCopy) => {
    const fixture = await createFixture({
      alias: "export { default } from '@deepseek-ai/cordis-plugin-include'",
    }, `- insert:
    - id: canonical
      name: '@deepseek-ai/cordis-plugin-include'
      config:
        path: ./nested/plugins.yml
        patches:
          - insert:
              - id: added
                name: ./child.mjs
    - id: alias
      name: ${packageName}/alias
      config:
        path: ./never-created.yml
        initial:
          - id: initial
            name: ${packageName}/alias
            config:
              path: ./nested/plugins.yml
`)
    if (localCopy) await installNativeInclude(fixture)
    const directory = join(fixture.profile, 'nested')
    await mkdir(directory)
    await writeFile(join(directory, 'child.mjs'), `${schemaImport}\nexport const Config = Schema.object({ enabled: Schema.boolean() })\n${forbiddenApply}`)
    await writeFile(join(directory, 'plugins.yml'), '- id: child\n  name: ./child.mjs\n')
    const result = await dump(fixture)
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stderr).toBe('')
    const document = parseSchema(result.stdout)
    expect(document['x-cordis'].complete).toBe(true)
    expect(document['x-cordis'].entries.filter(entry => entry.tree === 'include')).toHaveLength(3)
    expect(document['x-cordis'].entries.filter(entry => entry.status === 'schema').map(entry => entry.path))
      .toEqual(['/0/include/0', '/0/include/1', '/1/include/0/include/0'])
    expect(existsSync(join(fixture.profile, 'never-created.yml'))).toBe(false)
  })

  it('does not treat a custom marker with Include-like config as a native carrier', async () => {
    const fixture = await createFixture({
      carrier: `export default class CustomCarrier {
        static [Symbol.for('cordis.group')] = true
        constructor() { throw new Error('CUSTOM_CARRIER_EXECUTED') }
      }`,
    }, `- insert:
    - id: custom
      name: ${packageName}/carrier
      config:
        path: ./not-an-include.yml
        initial:
          - name: missing-child
`)
    const result = await dump(fixture)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('unrecognized Loader tree carrier')
    const document = parseSchema(result.stdout)
    expect(document['x-cordis'].entries).toHaveLength(1)
    expect(document['x-cordis'].complete).toBe(false)
    expect(existsSync(join(fixture.profile, 'not-an-include.yml'))).toBe(false)
  })

  it('returns positioned malformed-row diagnostics without losing healthy schema entries', async () => {
    const fixture = await createFixture({ class: classModule }, `- insert:
    - id: before
      name: ${packageName}/class
    - {}
    - name: 17
    - id: after
      name: ${packageName}/class
`)
    const result = await dump(fixture)
    expect(result.exitCode).toBe(1)
    const document = parseSchema(result.stdout)
    expect(document['x-cordis'].entries.map(entry => [entry.path, entry.status]))
      .toEqual([['/0', 'schema'], ['/1', 'error'], ['/2', 'error'], ['/3', 'schema']])
    expect(document['x-cordis'].entries[1]).not.toHaveProperty('name')
    expect(document['x-cordis'].entries[2]).not.toHaveProperty('name')
    expect(document['x-cordis'].entries[0]!.configRef).toBe(document['x-cordis'].entries[3]!.configRef)
  })

  it('emits partial structural schemas when native annotations are not JSON-compatible', async () => {
    const fixture = await createFixture({
      partial: `${schemaImport}\nexport const Config = Schema.object({ label: Schema.string().extra('default', () => 'dynamic') })\n${forbiddenApply}`,
    }, `- insert:
    - id: partial
      name: ${packageName}/partial
`)
    const result = await dump(fixture)
    expect(result.exitCode).toBe(1)
    const document = parseSchema(result.stdout)
    expect(document['x-cordis'].entries[0]!.status).toBe('partial')
    expect(document['x-cordis'].complete).toBe(false)
    expect(result.stderr).toContain('annotation omitted')
    const validate = new Ajv2020({ strict: false }).compile(document)
    expect(validate([{ name: `${packageName}/partial`, config: { label: 'literal' } }])).toBe(true)
    expect(validate([{ name: `${packageName}/partial`, config: { label: 3 } }])).toBe(false)
  })

  it('returns partial schemas and exit 1 for unsupported Config and throwing schema builders or imports', async () => {
    const fixture = await createFixture({
      unsupported: `export const Config = { type: 'object' }\n${forbiddenApply}`,
      lazy: `${schemaImport}\nexport const Config = Schema.lazy(() => { throw new Error('fixture lazy schema failed') })\n${forbiddenApply}`,
      broken: "throw new Error('fixture module import failed')",
      recovered: classModule,
    }, `- insert:
    - id: schema-unsupported
      name: ${packageName}/unsupported
    - id: schema-lazy-error
      name: ${packageName}/lazy
    - id: schema-import-error
      name: ${packageName}/broken
    - id: schema-recovered
      name: ${packageName}/recovered
`)
    const result = await dump(fixture)
    expect(result.exitCode, result.stderr).toBe(1)
    const document = parseSchema(result.stdout)
    const catalog = document['x-cordis']
    expect(catalog.complete).toBe(false)
    expect(catalog.entries.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'schema-unsupported', status: 'unsupported' },
      { id: 'schema-lazy-error', status: 'error' },
      { id: 'schema-import-error', status: 'error' },
      { id: 'schema-recovered', status: 'schema' },
    ])
    expect(catalog.entries[3]?.configRef).toBe('#/$defs/config0')
    const validator = new Ajv2020({ strict: false, validateFormats: false })
    const validate = validator.compile({ $schema: document.$schema, $defs: document.$defs, $ref: '#/$defs/config0' })
    expect(validate({ enabled: true })).toBe(true)
    expect(validate({ enabled: 'wrong' })).toBe(false)
    expect(catalog.diagnostics).toEqual([
      { level: 'error', path: '/0', message: 'Config is not a native Schemastery schema' },
      { level: 'error', path: '/1', message: 'fixture lazy schema failed' },
      { level: 'error', path: '/2', message: 'fixture module import failed' },
    ])
    expect(result.stderr.split('\n')).toEqual([
      'dsh: error: [/0] Config is not a native Schemastery schema',
      'dsh: error: [/1] fixture lazy schema failed',
      'dsh: error: [/2] fixture module import failed',
    ])
  })

  it('marks a skipped selected bundle incomplete and exits 1', async () => {
    const fixture = await createFixture({ absent: forbiddenApply }, `- insert:
    - id: schema-retained
      name: ${packageName}/absent
`)
    const missingBundle = 'dsh-schema-acceptance-missing-bundle'
    await writeFile(join(fixture.profile, 'package.json'), JSON.stringify({
      private: true,
      dependencies: { [packageName]: '1.0.0' },
      dsh: { profile: { bundles: [packageName, missingBundle] } },
    }))
    const result = await dump(fixture)
    expect(result.exitCode, result.stderr).toBe(1)
    const catalog = parseSchema(result.stdout)['x-cordis']
    expect(catalog.complete).toBe(false)
    expect(catalog.entries).toEqual([
      { path: '/0', id: 'schema-retained', name: `${packageName}/absent`, status: 'absent', configRef: '#/$defs/unknownConfig' },
    ])
    expect(catalog.diagnostics).toEqual([{
      level: 'error',
      message: `Selected profile bundle "${missingBundle}" could not be loaded; repair or remove its bundle selection.`,
    }])
    expect(result.stderr).toContain(missingBundle)
    for (const diagnostic of catalog.diagnostics) expect(result.stderr).toContain(diagnostic.message)
  })

  it('keeps schema warnings plain and provides source-labelled warnings through the YAML dump', async () => {
    const fixture = await createFixture({ absent: forbiddenApply }, `- insert:\n    - id: existing\n      name: ${packageName}/absent\n`)
    const overlay = join(fixture.root, 'unmatched.yml')
    await writeFile(overlay, '- id: missing\n  disabled: true\n')
    const schema = await dump(fixture, ['--patch', overlay])
    expect(schema.exitCode).toBe(0)
    expect(schema.stderr).toBe('dsh: warning: patch: entry "missing" not found')
    expect(parseSchema(schema.stdout)['x-cordis'].diagnostics).toEqual([{ level: 'warning', message: 'patch: entry "missing" not found' }])
    const config = await dump(fixture, ['--patch', overlay], '--dump-config')
    expect(config.exitCode).toBe(0)
    expect(config.stderr).toContain(`[${overlay}]`)
    expect(config.stderr).toContain('patch: entry "missing" not found')
  })

  it('keeps --dump-config as boot-free YAML containing literal configured values', async () => {
    const fixture = await createFixture({ absent: forbiddenApply }, `- insert:
    - id: yaml-entry
      name: ${packageName}/absent
      config:
        value: ACTUAL_YAML_VALUE
        expression: !!js (() => { throw new Error('YAML_EXPRESSION_EXECUTED') })()
`)
    const result = await dump(fixture, [], '--dump-config')
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain(`name: ${packageName}/absent`)
    expect(result.stdout).toContain('value: ACTUAL_YAML_VALUE')
    expect(result.stdout).toContain('!!js')
    expect(result.stdout).toContain('YAML_EXPRESSION_EXECUTED')
    expect(result.stdout).not.toContain('"$schema"')
  })

  it('composes --patch layers in order and resolves modules beside their profile or overlay', async () => {
    const fixture = await createFixture({ absent: forbiddenApply }, `- insert:
    - id: schema-bundle
      name: ${packageName}/absent
`)
    await writeFile(join(fixture.profile, 'local-schema.mjs'), classModule)
    await writeFile(join(fixture.root, 'local-schema.mjs'), "throw new Error('WRONG_MODULE_ROOT')\n")
    await writeFile(join(fixture.profile, 'cordis.patch.yml'), `- insert:
    - id: schema-profile
      name: ./local-schema.mjs
`)
    await mkdir(join(fixture.root, 'overlays'))
    await writeFile(join(fixture.root, 'overlays', 'local-schema.mjs'), forbiddenApply)
    await writeFile(join(fixture.root, 'overlays', 'first.yml'), `- insert:
    - id: schema-overlay
      name: ./local-schema.mjs
`)
    await writeFile(join(fixture.root, 'overlays', 'second.yml'), `- id: schema-overlay
  config:
    enabled: PRIVATE_OVERLAY_VALUE
- insert:
    - id: schema-second-overlay
      name: ./local-schema.mjs
`)
    const result = await dump(fixture, ['--patch', 'overlays/first.yml', '--patch', 'overlays/second.yml'])
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).not.toContain('PRIVATE_OVERLAY_VALUE')
    const catalog = parseSchema(result.stdout)['x-cordis']
    expect(catalog.complete).toBe(true)
    expect(catalog.diagnostics).toEqual([])
    expect(catalog.entries.map(({ path, id, name, status }) => ({ path, id, name, status }))).toEqual([
      { path: '/0', id: 'schema-bundle', name: `${packageName}/absent`, status: 'absent' },
      {
        path: '/1', id: 'schema-profile',
        name: pathToFileURL(join(fixture.profile, 'local-schema.mjs')).href, status: 'schema',
      },
      {
        path: '/2', id: 'schema-overlay',
        name: pathToFileURL(join(fixture.root, 'overlays', 'local-schema.mjs')).href, status: 'absent',
      },
      {
        path: '/3', id: 'schema-second-overlay',
        name: pathToFileURL(join(fixture.root, 'overlays', 'local-schema.mjs')).href, status: 'absent',
      },
    ])
  })
})
