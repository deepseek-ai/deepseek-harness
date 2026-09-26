/** Browser-side catalog for the Inspector Client bundle and its source map. */

import { bytesToBase64 } from '@deepseek-ai/dsh-util-crypto'
import type {
  ClientScriptDescriptor,
  ClientSourceCommand,
  ClientSourceError,
  ClientSourceResult,
  ClientSourcesCapability,
} from '../../shared/bridge/messages/sources/index.ts'
import { inspectorId } from '../../shared/identity.ts'
import type { RuntimeScriptKey } from '../../shared/cdp/ids.ts'

const PACKAGE_ID = '@deepseek-ai/dsh-experimental-inspector'
const CLIENT_SCRIPT_KEY = inspectorId<'RuntimeScriptKey'>('client-bundle', 'scriptKey')

/**
 * Describe browser-side source access.
 * @param available - Whether the Client bundle was discovered.
 * @returns The Sources capability when this Client discovered its bundle.
 */
export function sourcesBridgeCapability(available: boolean): ClientSourcesCapability | undefined {
  return available ? { type: 'client-sources' } : undefined
}

/** One lazily loaded browser script exposed by a Client source catalog. */
export interface ClientSourceAsset {
  readonly scriptKey: RuntimeScriptKey
  readonly url: string
  readonly hash: string
  readonly sourceMapUrl?: string
  readonly isModule?: boolean
  loadSource(): Promise<string>
  loadSourceMap?(): Promise<string | undefined>
}

interface LoadedAsset {
  readonly asset: ClientSourceAsset
  source?: Promise<string>
  sourceBytes?: Promise<Uint8Array>
  sourceMapBytes?: Promise<Uint8Array | undefined>
}

/** Deliberate error serialized by the Client source transport. */
export class ClientSourceCatalogError extends Error {
  constructor(readonly code: ClientSourceError['code'], message: string) {
    super(message)
  }
}

/** Executes bounded, read-only operations over Client script assets. */
export class ClientSourceCatalog {
  private readonly assets = new Map<RuntimeScriptKey, LoadedAsset>()

  constructor(assets: readonly ClientSourceAsset[]) {
    for (const asset of assets) {
      if (this.assets.has(asset.scriptKey)) {
        throw new Error(`inspector: duplicate Client script key ${asset.scriptKey}`)
      }
      this.assets.set(asset.scriptKey, { asset })
    }
  }

  /**
   * Resolve a stack-frame URL to this catalog's local script key.
   * @param url - Absolute or page-relative stack-frame URL.
   * @returns The matching script key when the URL belongs to this catalog.
   */
  scriptKeyForUrl(url: string): RuntimeScriptKey | undefined {
    const normalized = normalizedUrl(url)
    for (const entry of this.assets.values()) {
      if (normalizedUrl(entry.asset.url) === normalized) return entry.asset.scriptKey
    }
    return undefined
  }

  /**
   * Execute one validated source operation.
   * @param command - Read-only catalog command.
   * @param maxContentBytes - Maximum encoded bytes admitted for one asset.
   * @returns Script metadata or one bounded content chunk.
   */
  async execute(command: ClientSourceCommand, maxContentBytes: number): Promise<ClientSourceResult> {
    if (command.op === 'list-scripts') {
      return {
        op: command.op,
        scripts: await Promise.all([...this.assets.values()].map(async entry => this.describe(entry, maxContentBytes))),
      }
    }
    const entry = this.assets.get(command.scriptKey)
    if (entry === undefined) throw new ClientSourceCatalogError('script-not-found', 'Client script is not available')
    const bytes = command.content === 'source'
      ? await this.sourceBytes(entry, maxContentBytes)
      : await this.sourceMapBytes(entry, maxContentBytes)
    if (bytes === undefined) {
      return {
        op: command.op,
        scriptKey: command.scriptKey,
        content: command.content,
        available: false,
      }
    }
    if (command.offset > bytes.byteLength) {
      throw new ClientSourceCatalogError('invalid-request', 'Client source chunk offset exceeds content length')
    }
    const nextOffset = Math.min(bytes.byteLength, command.offset + command.maxBytes)
    return {
      op: command.op,
      scriptKey: command.scriptKey,
      content: command.content,
      available: true,
      offset: command.offset,
      nextOffset,
      data: bytesToBase64(bytes.subarray(command.offset, nextOffset)),
      eof: nextOffset === bytes.byteLength,
    }
  }

  private async describe(entry: LoadedAsset, maxContentBytes: number): Promise<ClientScriptDescriptor> {
    const source = await this.source(entry, maxContentBytes)
    const newline = source.lastIndexOf('\n')
    return {
      scriptKey: entry.asset.scriptKey,
      url: entry.asset.url,
      hash: entry.asset.hash,
      buildId: '',
      ...(entry.asset.sourceMapUrl === undefined ? {} : { sourceMapUrl: entry.asset.sourceMapUrl }),
      startLine: 0,
      startColumn: 0,
      endLine: countNewlines(source),
      endColumn: newline === -1 ? source.length : source.length - newline - 1,
      ...(entry.asset.isModule === undefined ? {} : { isModule: entry.asset.isModule }),
      length: source.length,
    }
  }

  private source(entry: LoadedAsset, maxContentBytes: number): Promise<string> {
    entry.source ??= entry.asset.loadSource().catch((error: unknown) => {
      throw new ClientSourceCatalogError('load-failed', `Cannot load Client script: ${renderError(error)}`)
    })
    return entry.source.then((source) => {
      if (new TextEncoder().encode(source).byteLength > maxContentBytes) {
        throw new ClientSourceCatalogError('result-too-large', 'Client script exceeds the configured content limit')
      }
      return source
    })
  }

  private sourceBytes(entry: LoadedAsset, maxContentBytes: number): Promise<Uint8Array> {
    entry.sourceBytes ??= this.source(entry, maxContentBytes).then(source => new TextEncoder().encode(source))
    return entry.sourceBytes
  }

  private sourceMapBytes(entry: LoadedAsset, maxContentBytes: number): Promise<Uint8Array | undefined> {
    if (entry.asset.loadSourceMap === undefined) return Promise.resolve(undefined)
    entry.sourceMapBytes ??= entry.asset.loadSourceMap().then(value =>
      value === undefined ? undefined : new TextEncoder().encode(value),
    ).catch((error: unknown) => {
      throw new ClientSourceCatalogError('load-failed', `Cannot load Client source map: ${renderError(error)}`)
    })
    return entry.sourceMapBytes.then((bytes) => {
      if (bytes !== undefined && bytes.byteLength > maxContentBytes) {
        throw new ClientSourceCatalogError('result-too-large', 'Client source map exceeds the configured content limit')
      }
      return bytes
    })
  }
}

/**
 * Discover this package's bundle URL from the Host-injected web boot graph.
 * @returns A lazy catalog, or `undefined` outside the assembled web application.
 */
export function discoverInspectorClientSourceCatalog(): ClientSourceCatalog | undefined {
  const graph: unknown = Reflect.get(globalThis, '__DSH_BOOT__')
  if (typeof graph !== 'object' || graph === null) return undefined
  const entries: unknown = Reflect.get(graph, 'entries')
  if (!Array.isArray(entries)) return undefined
  const row = entries.find((value) => {
    if (typeof value !== 'object' || value === null) return false
    return Reflect.get(value, 'id') === PACKAGE_ID
  }) as Record<string, unknown> | undefined
  if (row === undefined || typeof row.url !== 'string' || typeof row.rev !== 'string') return undefined
  const base = documentBase()
  if (base === undefined) return undefined
  const sourceUrl = new URL(row.url, base)
  const sourceMapUrl = new URL(sourceUrl.href)
  sourceMapUrl.pathname = `${sourceMapUrl.pathname}.map`
  return new ClientSourceCatalog([{
    scriptKey: CLIENT_SCRIPT_KEY,
    url: sourceUrl.href,
    hash: row.rev,
    sourceMapUrl: sourceMapUrl.href,
    isModule: false,
    loadSource: async () => fetchText(sourceUrl.href),
    loadSourceMap: async () => fetchText(sourceMapUrl.href),
  }])
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${String(response.status)} ${response.statusText}`)
  return response.text()
}

/**
 * Base every app-owned route reference resolves against: the document's
 * `baseURI`, else the location URL, else undefined outside a browser.
 */
function documentBase(): string | undefined {
  const document: unknown = Reflect.get(globalThis, 'document')
  if (typeof document === 'object' && document !== null) {
    const baseURI: unknown = Reflect.get(document, 'baseURI')
    if (typeof baseURI === 'string' && baseURI !== '') return baseURI
  }
  const location: unknown = Reflect.get(globalThis, 'location')
  if (typeof location !== 'object' || location === null) return undefined
  const href: unknown = Reflect.get(location, 'href')
  return typeof href === 'string' ? href : undefined
}

function countNewlines(value: string): number {
  let count = 0
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) === 10) count++
  }
  return count
}

function renderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizedUrl(value: string): string {
  try {
    const url = new URL(value, documentBase())
    url.hash = ''
    return url.href
  } catch {
    return value
  }
}
