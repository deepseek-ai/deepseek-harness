/** Compose Loader entry/patch structure and discovered plugin input schemas into one JSON Schema document. */

import { createConfigProjector, LOADER_EXPRESSION_SCHEMA } from './projector.ts'
import type {
  CollectedConfigEntry, ConfigJsonSchema, ConfigJsonSchemaObject, ConfigSchemaDiagnostic,
  ConfigSchemaDump, ConfigSchemaEntry, NativeConfigSchema,
} from './types.ts'

const ref = (name: string): ConfigJsonSchemaObject => ({ $ref: `#/$defs/${name}` })

function metadata(): Record<string, ConfigJsonSchema> {
  return {
    id: { type: 'string', description: 'Entry id. Loader generates an id when an entry omits it; patches use the configured id.' },
    name: { type: 'string', description: 'Plugin module specifier. Inserted relative plugin paths are anchored beside their patch file.' },
    config: {},
    group: { type: ['boolean', 'null'], description: 'Allows patch indexing and insertion into an entry-list config; does not select the plugin implementation.' },
    disabled: { anyOf: [{ type: ['boolean', 'null'] }, ref('loaderExpression')], description: 'Boolean or !!js expression. The Loader coerces other truthy values as disabled; this schema rejects them.' },
    inject: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'object' }, { type: 'null' }] },
    intercept: { type: ['object', 'null'] },
    isolate: { type: ['object', 'null'], additionalProperties: { anyOf: [{ const: true }, { type: 'string' }] } },
  }
}

function patchStructure(): ConfigJsonSchemaObject {
  return {
    type: 'object',
    allOf: [ref('entryMetadata')],
    properties: { insert: ref('entryList') },
    description: 'An insert appends entries, optionally inside the group identified by id. Other patches replace supplied fields; config is replaced wholesale, not deep-merged. A truthy name asserts the existing plugin name rather than renaming it. Unknown targets and non-insert patches without a nonempty id are warned and skipped.',
  }
}

/**
 * Build a schema for the composed entry list and a separately addressable root-tree patch list.
 * Unknown plugin names remain open; only collected schemas supply plugin-specific constraints.
 * @param profile - selected profile name.
 * @param collected - declarations discovered without mounting plugins, including include descendants.
 * @param targets - last-id-wins patch targets from the root tree's patch index, excluding include descendants.
 * @param initialDiagnostics - composition and import diagnostics already collected.
 * @returns one JSON Schema document with explicit collection and projection annotations.
 */
export async function buildConfigSchemaDocument(
  profile: string,
  collected: readonly CollectedConfigEntry[],
  targets: ReadonlyMap<string, CollectedConfigEntry>,
  initialDiagnostics: readonly ConfigSchemaDiagnostic[],
): Promise<ConfigSchemaDump> {
  const project = await createConfigProjector()
  const diagnostics = [...initialDiagnostics]
  const definitions: Record<string, ConfigJsonSchema> = {
    loaderExpression: LOADER_EXPRESSION_SCHEMA,
    entryMetadata: { type: 'object', properties: metadata() },
    entryList: { type: 'array', items: ref('entry') },
    patchList: { type: 'array', items: ref('patch') },
    unknownConfig: { $comment: 'No projected Config schema is available; this is unknown configuration, not a prohibition on fields.' },
    includeConfig: {
      type: 'object', required: ['path'],
      properties: {
        path: { type: 'string', description: 'YAML/JSON filename resolved relative to the owning Loader tree. This field is literal, not a !!js expression.' },
        initial: ref('entryList'),
        patches: { type: 'array', items: ref('includePatch') },
        enableLogs: { type: 'boolean' },
      },
      description: 'Native Include configuration stays literal. initial is used only when the file is absent. Included files have their own module-resolution base and patch target index.',
    },
    includePatch: patchStructure(),
  }
  const entries: ConfigSchemaEntry[] = []
  const outputByEntry = new Map<CollectedConfigEntry, ConfigSchemaEntry>()
  const projections = new Map<NativeConfigSchema, { reference: string; required: boolean; limitations: string[] }>()
  const trees = new Set<string>(['#/$defs/entryList', '#/$defs/includeConfig'])
  const requiredConfigs = new Set(trees)
  const names = new Map<string, Set<string>>([
    ['cordis:group', new Set(['#/$defs/entryList'])],
    ['cordis:include', new Set(['#/$defs/includeConfig'])],
  ])

  for (const entry of collected) {
    const { native, ...output } = entry
    if (entry.tree) output.configRef = entry.tree === 'group' ? '#/$defs/entryList' : '#/$defs/includeConfig'
    else if (native) {
      let projection = projections.get(native)
      if (projection === undefined) {
        const name = `config${projections.size}`
        try {
          const result = project(native, name)
          definitions[name] = result.schema
          Object.assign(definitions, result.definitions)
          projection = { reference: `#/$defs/${name}`, required: result.acceptsMissing === false, limitations: result.limitations }
          projections.set(native, projection)
        } catch (error) {
          output.status = 'error'
          diagnostics.push({ level: 'error', path: entry.path, message: error instanceof Error ? error.message : String(error) })
        }
      }
      if (projection) {
        output.configRef = projection.reference
        output.status = projection.limitations.length ? 'partial' : 'schema'
        if (projection.required) requiredConfigs.add(projection.reference)
        for (const message of projection.limitations) diagnostics.push({ level: 'warning', path: entry.path, message })
      }
    }
    output.configRef ??= '#/$defs/unknownConfig'
    entries.push(output)
    outputByEntry.set(entry, output)
    if (entry.name !== undefined) {
      const choices = names.get(entry.name) ?? new Set<string>()
      choices.add(output.configRef)
      names.set(entry.name, choices)
    }
  }

  // The Loader never initializes a disabled row unless group: true forces it, so its required config may be omitted.
  const dormant: ConfigJsonSchemaObject = {
    properties: { disabled: { anyOf: [{ const: true }, ref('loaderExpression')] }, group: { not: { const: true } } },
    required: ['disabled'],
  }
  const entryRules: ConfigJsonSchema[] = []
  for (const [name, choices] of names) {
    const validated: ConfigJsonSchemaObject = { properties: { config: { anyOf: [...choices].map(reference => ({ $ref: reference })) } } }
    let then = validated
    if ([...choices].every(reference => requiredConfigs.has(reference))) {
      then = { if: dormant, else: { ...validated, required: ['config'] } }
      // A dormant carrier never creates its children, so their declarations are not validated either.
      if (![...choices].every(reference => trees.has(reference))) then.then = validated
    }
    entryRules.push({ if: { properties: { name: { const: name } }, required: ['name'] }, then })
    if (choices.size > 1) {
      diagnostics.push({ level: 'warning', message: `Plugin ${JSON.stringify(name)} has multiple collected schemas; entry validation accepts their union because module resolution depends on the owning tree.` })
    }
  }
  definitions.entry = {
    type: 'object', required: ['name'], allOf: [ref('entryMetadata'), ...entryRules],
    description: 'Loader entry. Unknown metadata and plugin names are accepted; plugin-specific validation is available only for the names collected in this profile. Distinct resolutions of one name use a union of their schemas.',
  }

  const patchRules: ConfigJsonSchema[] = []
  for (const [id, target] of targets) {
    if (target.name === undefined) continue
    const configRef = outputByEntry.get(target)?.configRef ?? '#/$defs/unknownConfig'
    patchRules.push({
      if: {
        required: ['id'], properties: { id: { const: id } },
        allOf: [
          { not: { required: ['insert'] } },
          { anyOf: [{ not: { required: ['name'] } }, { properties: { name: { enum: ['', target.name] } } }] },
        ],
      },
      then: { properties: { config: { $ref: configRef } } },
    })
  }
  definitions.patch = { ...patchStructure(), allOf: [ref('entryMetadata'), ...patchRules] }
  const positions = new Map(entries.map((entry, index) => [entry.path, index]))
  diagnostics.sort((left, right) => (positions.get(left.path ?? '') ?? -1) - (positions.get(right.path ?? '') ?? -1))
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: `Cordis configuration for profile ${profile}`,
    description: 'Describes the parsed entry-list YAML printed by --dump-config. Use $defs.patchList for a profile/home/CLI overlay. Parse !!js with the Cordis entry-list YAML dialect. Expression results, service dependencies, plugin startup checks, and sequence-dependent patch targets still require runtime validation.',
    $comment: 'Bundle, profile, home, and CLI layers apply in that order. A patch config replaces the whole config. JSON Schema defaults are annotations; Schemastery validates a fallback on null/omission unless required rejects it first. Schemastery unions select the first successful branch. Root patch id constraints describe the current index, not ids introduced or changed by earlier patches. Include-local patches have a separate index. Relative plugin insertions require their source patch directory; this document does not infer future overlay locations.',
    type: 'array', items: ref('entry'), $defs: definitions,
    'x-cordis': {
      profile,
      complete: !diagnostics.some(item => item.level === 'error')
        && !entries.some(entry => ['partial', 'unsupported', 'error'].includes(entry.status))
        && ![...names.values()].some(choices => choices.size > 1),
      entries, diagnostics, patchSchema: '#/$defs/patchList',
    },
  }
}
