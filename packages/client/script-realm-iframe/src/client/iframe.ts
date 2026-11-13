/** Same-origin iframe implementation of the direct-reference ScriptRealm interface. */
import {
  ScriptRealmError,
  type ScriptRealm, type ScriptRealmCreateOptions, type ScriptRealmFactory, type ScriptRealmId, type ScriptRealmScript,
} from '@deepseek-ai/dsh-client-script-realm/client'

/** Page carrier supplying the iframe mount and script URL base. */
export interface IFrameScriptRealmOptions {
  readonly document: Document
}

const RESERVED_BINDINGS = new Set(['window', 'document', 'parent', 'top', 'self', 'globalThis', 'location'])

/** An isolated global environment sharing ordinary references with its owning page. */
export class IFrameScriptRealm implements ScriptRealm {
  readonly id: ScriptRealmId
  private closed = false
  private disposal: Promise<void> | undefined
  private readonly pending = new Set<() => void>()
  private readonly abort: () => void

  constructor(
    private readonly frame: HTMLIFrameElement,
    readonly window: Window,
    readonly document: Document,
    private readonly pageDocument: Document,
    private readonly options: ScriptRealmCreateOptions,
  ) {
    options.signal.throwIfAborted()
    this.id = options.id
    this.abort = () => { this.close() }
    options.signal.addEventListener('abort', this.abort, { once: true })
  }

  // oxlint-disable-next-line typescript/require-await -- Preserve the asynchronous API's rejection semantics for validation failures.
  async expose(bindings: Readonly<Record<string, unknown>>): Promise<void> {
    this.assertLive('expose')
    try {
      const entries = Object.entries(bindings)
      for (const [name] of entries) {
        if (RESERVED_BINDINGS.has(name) || name in this.window) {
          throw new Error(`binding ${JSON.stringify(name)} is reserved or already exists`)
        }
      }
      if (!Object.isExtensible(this.window)) throw new Error('ScriptRealm globals are not extensible')
      const descriptors = Object.fromEntries(entries.map(([name, value]) => [name, {
        value, enumerable: true, writable: false, configurable: false,
      }]))
      Object.defineProperties(this.window, descriptors)
    } catch (cause) {
      throw new ScriptRealmError({ stage: 'expose', realmId: this.id,
        message: `script-realms: could not expose bindings in ${JSON.stringify(this.id)}`, cause })
    }
  }

  async execute(script: ScriptRealmScript): Promise<void> {
    this.assertLive('execute', script.url)
    let url: string
    try {
      url = new URL(script.url, this.pageDocument.baseURI).href
    } catch (cause) {
      throw this.executionError(script.url, cause)
    }
    return new Promise<void>((resolve, reject) => {
      const element = this.document.createElement('script')
      element.async = true
      element.src = url
      let settled = false
      const finish = (error?: ScriptRealmError): void => {
        if (settled) return
        settled = true
        this.pending.delete(cancel)
        element.removeEventListener('load', onLoad)
        element.removeEventListener('error', onError)
        this.window.removeEventListener('error', onExecutionError)
        element.remove()
        if (error === undefined) resolve()
        else reject(error)
      }
      const onLoad = (): void => { finish() }
      const onError = (event: Event): void => { finish(this.executionError(url, event)) }
      const onExecutionError = (event: ErrorEvent): void => {
        if (event.filename === url) finish(this.executionError(url, event.error ?? event.message))
      }
      const cancel = (): void => {
        finish(this.executionError(url, this.options.signal.reason ?? new Error('ScriptRealm disposed')))
      }
      element.addEventListener('load', onLoad, { once: true })
      element.addEventListener('error', onError, { once: true })
      this.window.addEventListener('error', onExecutionError)
      this.pending.add(cancel)
      try {
        this.document.head.append(element)
      } catch (cause) {
        finish(this.executionError(url, cause))
      }
    })
  }

  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    try {
      this.close()
      this.disposal = Promise.resolve()
    } catch (cause) {
      this.disposal = Promise.reject(new ScriptRealmError({ stage: 'dispose', realmId: this.id,
        message: `script-realms: could not dispose ${JSON.stringify(this.id)}`, cause }))
    }
    return this.disposal
  }

  private close(): void {
    if (this.closed) return
    this.closed = true
    this.options.signal.removeEventListener('abort', this.abort)
    for (const cancel of [...this.pending]) cancel()
    this.frame.remove()
  }

  private assertLive(stage: 'expose' | 'execute', url?: string): void {
    if (!this.closed && !this.options.signal.aborted) return
    throw new ScriptRealmError({ stage, realmId: this.id,
      message: `script-realms: ${JSON.stringify(this.id)} is disposed`,
      ...(url === undefined ? {} : { url }), cause: this.options.signal.reason })
  }

  private executionError(url: string, cause: unknown): ScriptRealmError {
    return new ScriptRealmError({ stage: 'execute', realmId: this.id, url,
      message: `script-realms: could not execute ${JSON.stringify(url)} in ${JSON.stringify(this.id)}`, cause })
  }
}

/**
 * Capture the provider page without creating an iframe until requested.
 * @param options - Owning page document and script URL base.
 * @returns Factory creating a ready, named iframe environment.
 */
export function createIFrameScriptRealmFactory(options: IFrameScriptRealmOptions): ScriptRealmFactory<IFrameScriptRealm> {
  const pageDocument = options.document
  return {
    // oxlint-disable-next-line typescript/require-await -- Provider failures are promise rejections even when creation is synchronous.
    async create(createOptions) {
      let frame: HTMLIFrameElement | undefined
      try {
        createOptions.signal.throwIfAborted()
        frame = pageDocument.createElement('iframe')
        frame.hidden = true
        frame.tabIndex = -1
        frame.setAttribute('aria-hidden', 'true')
        frame.name = `realm-iframe-${createOptions.id}`
        frame.title = frame.name
        frame.dataset.realm = createOptions.id
        pageDocument.body.append(frame)
        const window = frame.contentWindow
        const document = frame.contentDocument
        if (window === null || document === null) {
          throw new Error('initial iframe document is unavailable')
        }
        document.title = frame.name
        createOptions.signal.throwIfAborted()
        return new IFrameScriptRealm(frame, window, document, pageDocument, createOptions)
      } catch (cause) {
        frame?.remove()
        throw new ScriptRealmError({ stage: 'create', realmId: createOptions.id,
          message: `script-realms: could not create iframe ${JSON.stringify(createOptions.id)}`, cause })
      }
    },
  }
}
