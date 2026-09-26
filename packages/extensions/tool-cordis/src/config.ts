/** Live plugin Config discovery projected from the running Loader tree. */

import type { Context } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
// Declares `Context.pluginPackages`, the profile package lookup that resolves an entry's package directory.
import { createConfigProjector, isNativeConfigSchema, LOADER_EXPRESSION_SCHEMA, type NativeConfigSchema } from '@deepseek-ai/dsh-app-boot'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/**
 * `schema`: the running plugin declares a native Schemastery Config. `absent`: it runs without one.
 * `unsupported`: its Config is not a native Schemastery graph. `tree`: a Loader carrier (`cordis:group`,
 * `cordis:include`) whose `config` is a child entry list, not a plugin Config. `inactive`: the entry is
 * disabled, was never imported, or its fiber has been disposed, so no Config is read. A plugin whose
 * `apply` failed keeps its fiber and still reports its Config.
 */
type ConfigStatus = 'schema' | 'absent' | 'unsupported' | 'tree' | 'inactive'

interface LiveConfig {
  /** Loader entry id, unique across nested include trees (`parent:child`). */
  id: string
  /** Tree-local id that profile patches address. */
  patchId: string
  name: string
  status: ConfigStatus
  native?: NativeConfigSchema
}

function liveConfig(entry: Entry): LiveConfig {
  const { id, name } = entry.options
  const listed = { id: entry.id, patchId: id, name }
  if (entry.subgroup !== undefined || entry.subtree !== undefined) return { ...listed, status: 'tree' }
  const fiber = entry.fiber
  if (fiber === undefined || fiber.uid === null || entry.disabled) return { ...listed, status: 'inactive' }
  const config: unknown = fiber.runtime?.Config
  if (config === undefined || config === null) return { ...listed, status: 'absent' }
  if (!isNativeConfigSchema(config)) return { ...listed, status: 'unsupported' }
  return { ...listed, status: 'schema', native: config }
}

function listing({ id, patchId, name, status }: LiveConfig): { [key: string]: JsonValue } {
  return { id, patchId, name, status }
}

/** Model-supplied query fields, validated at the tool JSON boundary. */
interface ConfigQuery {
  entry: string | undefined
  name: string | undefined
  offset: number
  limit: number
}

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100

function parseQuery(input: JsonValue | undefined): ConfigQuery {
  const fields = input !== undefined && input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const text = (key: string): string | undefined => {
    const value = fields[key]
    if (value === undefined) return undefined
    if (typeof value !== 'string' || value === '') throw new Error(`${key} must be a non-empty string`)
    return value
  }
  const offset = fields.offset ?? 0
  const limit = fields.limit ?? DEFAULT_LIMIT
  if (!Number.isInteger(offset) || typeof offset !== 'number' || offset < 0) throw new Error('offset must be a non-negative integer')
  if (!Number.isInteger(limit) || typeof limit !== 'number' || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`limit must be an integer from 1 to ${MAX_LIMIT}`)
  }
  return { entry: text('entry'), name: text('name'), offset, limit }
}

/** Resolve the package directory behind an entry's plugin name through the profile package lookup. */
function packageDir(ctx: Context, entry: Entry): { packageDir?: string } {
  const baseUrl = entry.parent.tree.ctx.baseUrl
  const dir = baseUrl === undefined ? undefined : ctx.get('pluginPackages')?.packageOf(entry.options.name, baseUrl)?.dir
  return dir === undefined ? {} : { packageDir: dir }
}

/** Projection output is JSON by construction; the CLI schema dump serializes the same values. */
function toJson(value: object): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

/**
 * Answer the `Config.listConfigs` inspect query from the live Loader tree.
 * Without `entry`, return one page of the directory: each entry's Loader id, patch id, plugin name, and Config
 * status, optionally filtered to one exact plugin `name`, with `total` and `nextOffset` (null on the last page).
 * With `entry`, return that entry with its resolved `packageDir` (the directory holding the package README and
 * built `lib/`, when the profile package lookup resolves it) and project its native Config into one self-contained
 * JSON Schema 2020-12 document whose `$defs` carry the shared and `loaderExpression` definitions, plus omission
 * acceptance and projection limitations.
 * Validators and transform callbacks are not executed; runtime-created Agent preset trees are outside the Loader.
 * @param ctx - Host context; its `loader`, when the profile was mounted by one, owns the entry tree.
 * @param input - model-supplied query: `entry` (Loader entry id), or `name`, `offset` (default 0), and `limit` (1 to 100, default 25).
 * @returns one directory page, or one entry's status and projected schema.
 * @throws when no Loader mounted this Host, when a query field is malformed, or when the entry id matches no live entry.
 */
export async function queryLiveConfig(ctx: Context, input: JsonValue | undefined): Promise<JsonValue> {
  const loader = ctx.get('loader')
  if (loader === undefined) throw new Error('Config inspection requires the Loader that mounted this profile; this Host was composed without one')
  const query = parseQuery(input)
  const entries = [...loader.entries()].map(liveConfig)
  if (query.entry === undefined) {
    const matching = query.name === undefined ? entries : entries.filter(candidate => candidate.name === query.name)
    const page = matching.slice(query.offset, query.offset + query.limit).map(listing)
    const end = query.offset + page.length
    return { entries: page, total: matching.length, nextOffset: end < matching.length ? end : null }
  }
  const entry = entries.find(candidate => candidate.id === query.entry)
  if (entry === undefined) throw new Error(`unknown entry id ${JSON.stringify(query.entry)}`)
  const listed = { ...listing(entry), ...packageDir(ctx, loader.resolve(query.entry)) }
  if (entry.native === undefined) return listed
  const project = await createConfigProjector()
  const { schema, definitions, acceptsMissing, limitations } = project(entry.native, 'config')
  return toJson({ ...listed, acceptsMissing, limitations, schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: { ...definitions, loaderExpression: LOADER_EXPRESSION_SCHEMA },
    ...schema,
  } })
}
