/** JSON Schema output and native graph inputs for boot-free configuration inspection. */

/** JSON Schema 2020-12, including annotations that standard validators may ignore. */
export type ConfigJsonSchema = boolean | ConfigJsonSchemaObject

/** Object-form JSON Schema; vocabulary extensions are annotations, not executable validators. */
export interface ConfigJsonSchemaObject {
  [keyword: string]: unknown
  $schema?: string
  $ref?: string
  $defs?: Record<string, ConfigJsonSchema>
  type?: string | string[]
  properties?: Record<string, ConfigJsonSchema>
  required?: string[]
  items?: ConfigJsonSchema
  prefixItems?: ConfigJsonSchema[]
  additionalProperties?: ConfigJsonSchema
  propertyNames?: ConfigJsonSchema
  anyOf?: ConfigJsonSchema[]
  allOf?: ConfigJsonSchema[]
  not?: ConfigJsonSchema
  if?: ConfigJsonSchema
  then?: ConfigJsonSchema
  default?: unknown
  description?: string
}

/** A collection or projection diagnostic, without independently collected config values. */
export interface ConfigSchemaDiagnostic {
  level: 'warning' | 'error'
  /** Structural position in the discovered entry tree, when applicable. */
  path?: string
  message: string
}

/** One declared entry and its generated Config reference; include paths describe discovery, not root JSON pointers. */
export interface ConfigSchemaEntry {
  path: string
  id?: string
  /** Omitted when a malformed row has no literal plugin name. */
  name?: string
  status: 'schema' | 'partial' | 'absent' | 'unsupported' | 'error'
  configRef?: string
  /** Native Loader carrier, whose config is not interpolated as an ordinary plugin config. */
  tree?: 'group' | 'include'
}

/** JSON Schema for a composed entry list; `$defs.patchList` describes profile overlays. */
export interface ConfigSchemaDump extends ConfigJsonSchemaObject {
  $schema: 'https://json-schema.org/draft/2020-12/schema'
  $defs: Record<string, ConfigJsonSchema>
  'x-cordis': {
    profile: string
    /** False for error diagnostics, partial/unsupported/error entries, or ambiguous plugin-name schemas; includes disabled declarations. */
    complete: boolean
    entries: ConfigSchemaEntry[]
    diagnostics: ConfigSchemaDiagnostic[]
    patchSchema: '#/$defs/patchList'
  }
}

/** Native Schemastery graph protocol after its identity marker has been checked. */
export interface NativeConfigSchema {
  type: string
  meta: {
    role?: string
    extra?: unknown
    hidden?: boolean
    disabled?: boolean
    collapse?: boolean
    link?: string
    comment?: string
    badges?: { text: string; type: string }[]
    required?: boolean
    volatile?: boolean
    default?: unknown
    min?: number
    max?: number
    step?: number
    pattern?: { source: string; flags?: string }
    description?: string | Record<string, string>
    loose?: boolean
  }
  dict?: Record<string, NativeConfigSchema>
  inner?: NativeConfigSchema
  sKey?: NativeConfigSchema
  list?: NativeConfigSchema[]
  value?: unknown
  builder?: unknown
}

/** Collected declaration used only while constructing the JSON Schema document. */
export interface CollectedConfigEntry extends ConfigSchemaEntry {
  native?: NativeConfigSchema
}
