/**
 * `internal/modules/esm/module_map` for the Worker, following Node v24.18.0. The Worker evaluates no ES module
 * jobs, so a {@link LoadCache} stays empty and refuses to store one.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/node/internal_modules/module-map
 */
import { notAvailableError } from '../notImplementedFail.ts'

/** Job slot Node uses when an import names no `type` attribute. */
const IMPLICIT_TYPE_ATTRIBUTE = 'javascript'

/**
 * Node's `validateString` refusal.
 * @param value - Argument to check.
 * @param name - Argument name in the message.
 */
function validateString(value: unknown, name: string): asserts value is string {
  if (typeof value === 'string') return
  throw Object.assign(new TypeError(`The "${name}" argument must be of type string. Received ${typeof value}`), {
    code: 'ERR_INVALID_ARG_TYPE',
  })
}

/** Resolutions keyed by parent URL, then by serialized module request. */
export class ResolveCache extends Map<unknown, unknown> {
  /**
   * Serialize a module request: the specifier and its import attributes sorted by key.
   * @param specifier - Requested module.
   * @param importAttributes - Import attributes of the request.
   * @returns The cache key Node uses for this request.
   */
  serializeKey(specifier: string, importAttributes: Record<string, string>): string {
    const keys = Object.keys(importAttributes)
    if (keys.length === 0) return `${specifier}::`
    return `${specifier}::${keys.sort().map(key => JSON.stringify(key) + JSON.stringify(importAttributes[key])).join(',')}`
  }

  #imports(parentURL: unknown): Record<string, unknown> {
    const existing = super.get(parentURL) as Record<string, unknown> | undefined
    if (existing !== undefined) return existing
    const created: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    super.set(parentURL, created)
    return created
  }

  /**
   * Read one cached resolution.
   * @param serializedKey - Key from {@link serializeKey}.
   * @param parentURL - URL of the importing module.
   * @returns The cached resolution, if any.
   */
  override get(serializedKey: string, parentURL?: unknown): unknown {
    return this.#imports(parentURL)[serializedKey]
  }

  /**
   * Store one resolution.
   * @param serializedKey - Key from {@link serializeKey}.
   * @param parentURL - URL of the importing module.
   * @param result - Resolution to cache.
   * @returns This cache.
   */
  override set(serializedKey: string, parentURL?: unknown, result?: unknown): this {
    this.#imports(parentURL)[serializedKey] = result
    return this
  }

  /**
   * Check for one cached resolution.
   * @param serializedKey - Key from {@link serializeKey}.
   * @param parentURL - URL of the importing module.
   * @returns Whether the request has a cached resolution.
   */
  override has(serializedKey: string, parentURL?: unknown): boolean {
    return serializedKey in this.#imports(parentURL)
  }
}

/** Module jobs keyed by URL, then by import `type` attribute; always empty in the Worker. */
export class LoadCache extends Map<string, unknown> {
  /**
   * Read the job for one URL and type.
   * @param url - Module URL.
   * @param type - Import `type` attribute.
   * @returns The cached job, if any.
   */
  override get(url: string, type: string = IMPLICIT_TYPE_ATTRIBUTE): unknown {
    validateString(url, 'url')
    validateString(type, 'type')
    return (super.get(url) as Record<string, unknown> | undefined)?.[type]
  }

  /**
   * Refuse to store a job: the Worker creates no ES module jobs.
   * @param url - Module URL.
   * @param type - Import `type` attribute.
   * @param _job - Job Node would store.
   * @returns Never; always throws.
   */
  override set(url: string, type: unknown = IMPLICIT_TYPE_ATTRIBUTE, _job?: unknown): never {
    validateString(url, 'url')
    validateString(type, 'type')
    throw notAvailableError('internal/modules/esm/module_map', 'LoadCache.set')
  }

  /**
   * Check for the job of one URL and type.
   * @param url - Module URL.
   * @param type - Import `type` attribute.
   * @returns Whether a job is cached.
   */
  override has(url: string, type: string = IMPLICIT_TYPE_ATTRIBUTE): boolean {
    validateString(url, 'url')
    validateString(type, 'type')
    return (super.get(url) as Record<string, unknown> | undefined)?.[type] !== undefined
  }
}
