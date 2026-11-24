import { Context, Service } from '@deepseek-ai/cordis'
import { type Awaitable, Binary, defineProperty, type Dict, isNullable } from '@deepseek-ai/cosmokit'
import { createRequire } from 'node:module'
import fetchFile from '@deepseek-ai/cordis-fetch-file'
import type { Dispatcher, RequestInit, WebSocketInit } from 'undici'
import z from '@deepseek-ai/schemastery'

declare module '@deepseek-ai/cordis' {
  interface Context {
    http: Http
  }

  interface Intercept {
    http: Http.Intercept
  }

  interface Events {
    'http/fetch'(this: Http, url: URL, init: RequestInit, config: Http.Config, next: () => Promise<Response>): Promise<Response>
    'http/websocket'(this: Http, url: URL, init: WebSocketInit, config: Http.Config, next: () => WebSocket): WebSocket
  }
}

const kHttpError = Symbol.for('cordis.http.error')
const kHttpConfig = Symbol.for('cordis.http.config')

function findOwnValue(source: any, predicate: (value: any, key: PropertyKey) => boolean) {
  for (const key of Reflect.ownKeys(source)) {
    const value = source[key]
    if (predicate(value, key)) return value
  }
}

function setupInternalUndici(undici: typeof import('undici')) {
  const runtime: Partial<typeof import('undici')> = undici
  if (!runtime.getGlobalDispatcher) return
  runtime.Agent ??= runtime.getGlobalDispatcher().constructor as any
  if (runtime.ProxyAgent && runtime.buildConnector) return
  if (!runtime.EnvHttpProxyAgent) return

  const envAgent = new runtime.EnvHttpProxyAgent({
    httpProxy: 'http://localhost',
    noProxy: '',
  })
  const proxyAgent = findOwnValue(envAgent, (value) => {
    return value?.constructor?.name === 'ProxyAgent'
  })
  envAgent.close().catch(() => {})
  if (!proxyAgent) return

  const ProxyAgent = runtime.ProxyAgent ??= proxyAgent.constructor
  runtime.buildConnector ??= (options = {}) => {
    const agent = new ProxyAgent({
      uri: 'http://localhost',
      requestTls: options,
    })
    const connector = findOwnValue(agent, (value, key) => {
      if (typeof value !== 'function') return false
      if (typeof key === 'symbol' && key.description === 'connect endpoint function') return true
      return value.name === 'connect' && value.length === 2
    })
    agent.close().catch(() => {})
    if (!connector) throw new Error('cannot access the internal undici connector')
    return connector
  }
}

class HttpError extends Error {
  [kHttpError] = true

  static is(error: any): error is HttpError {
    return !!error?.[kHttpError]
  }

  constructor(message?: string, public code?: Http.Error.Code, public response?: Response) {
    super(message)
  }
}

/**
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch
 */
function encodeRequest(data: any): [string | null, any] {
  if (data instanceof URLSearchParams) return [null, data]
  if (data instanceof ArrayBuffer) return [null, data]
  if (ArrayBuffer.isView(data)) return [null, data]
  if (data instanceof Blob) return [null, data]
  if (isFormData(data)) return [null, data]
  if (data instanceof ReadableStream) return [null, data]
  return ['application/json', JSON.stringify(data)]
}

/**
 * Whether data is a multipart form body. Node's global FormData and the
 * `undici` package's are distinct classes, and a request may carry either.
 * @param data - request data.
 * @returns true for a FormData of either class.
 */
function isFormData(data: unknown): boolean {
  const Native = Http.undici?.FormData as (new () => object) | undefined
  return data instanceof FormData || (Native !== undefined && data instanceof Native)
}

export namespace Http {
  export interface ResponseTypes {
    json: any
    text: string
    stream: ReadableStream
    blob: Blob
    formdata: FormData
    arraybuffer: ArrayBuffer
    headers: Headers
  }

  export interface Request1 {
    <K extends keyof ResponseTypes>(url: string | URL, config: Http.RequestConfig & { responseType: K }): Promise<ResponseTypes[K]>
    <T = any>(url: string | URL, config: Http.RequestConfig & { responseType: Decoder<T> }): Promise<T>
    <T = any>(url: string | URL, config?: Http.RequestConfig): Promise<T>
  }

  export interface Request2 {
    <K extends keyof ResponseTypes>(url: string | URL, data: any, config: Http.RequestConfig & { responseType: K }): Promise<ResponseTypes[K]>
    <T = any>(url: string | URL, data: any, config: Http.RequestConfig & { responseType: Decoder<T> }): Promise<T>
    <T = any>(url: string | URL, data?: any, config?: Http.RequestConfig): Promise<T>
  }

  export interface Intercept {
    baseUrl?: string
    headers?: Dict
    timeout?: number
    proxyAgent?: string
  }

  export interface Config extends Intercept {}

  export interface RequestConfig extends Config {
    method?: string
    params?: Dict
    data?: any
    keepAlive?: boolean
    redirect?: RequestRedirect
    signal?: AbortSignal
    responseType?: keyof ResponseTypes | Decoder
    validateStatus?: (status: number) => boolean
  }

  export interface Response<T = any> {
    url: string
    data: T
    status: number
    statusText: string
    headers: Headers
  }

  export interface AfterFetch {
    url: URL
    init: RequestInit
    config: RequestConfig
    response?: globalThis.Response
    error?: any
  }

  export type Decoder<T = any> = (raw: globalThis.Response) => Awaitable<T>

  export type Error = HttpError

  export namespace Error {
    export type Code = 'TIMEOUT' | 'STATUS_ERROR'
  }
}

export interface FileOptions {
  timeout?: number | string
}

export interface Http {
  (url: string | URL, config?: Http.RequestConfig): Promise<Response>
  config: Http.Config
  get: Http.Request1
  delete: Http.Request1
  patch: Http.Request2
  post: Http.Request2
  put: Http.Request2
}

// we don't use `raw.ok` because it may be a 3xx redirect
const validateStatus = (status: number) => status < 400

export class Http extends Service<Http.Intercept> {
  static Error = HttpError

  static undici: typeof import('undici')

  static {
    const require = createRequire(import.meta.url)
    try {
      if (process.execArgv.includes('--expose-internals')) {
        this.undici = require('internal/deps/undici/undici')
        setupInternalUndici(this.undici)
      } else {
        this.undici = require('undici')
      }
    } catch {}

    for (const method of ['get', 'delete'] as const) {
      defineProperty(Http.prototype, method, async function (this: Http, url: string | URL, config?: Http.Config) {
        const response = await this(url, { method, validateStatus, ...config })
        return this._decode(response)
      })
    }

    for (const method of ['patch', 'post', 'put'] as const) {
      defineProperty(Http.prototype, method, async function (this: Http, url: string | URL, data?: any, config?: Http.Config) {
        const response = await this(url, { method, data, validateStatus, ...config })
        return this._decode(response)
      })
    }
  }

  static Config: z<Http.Config> = z.object({
    timeout: z.natural().role('ms').description('等待请求的最长时间。'),
    keepAlive: z.boolean().description('是否保持连接。'),
    proxyAgent: z.string().description('代理服务器地址。'),
  })

  Config: z<Http.Config> = z.object({
    baseUrl: z.string().description('基础 URL。'),
    timeout: z.natural().role('ms').description('等待请求的最长时间。'),
    keepAlive: z.boolean().description('是否保持连接。'),
    proxyAgent: z.string().description('代理服务器地址。'),
  })

  public isError = HttpError.is

  private _decoders: Dict = Object.create(null)
  private _proxies: Dict<(url: URL) => Dispatcher> = Object.create(null)

  constructor(ctx: Context, public config: Http.Config = {}) {
    super(ctx, 'http')

    this.decoder('json', (raw) => raw.json())
    this.decoder('text', (raw) => raw.text())
    this.decoder('blob', (raw) => raw.blob())
    this.decoder('arraybuffer', (raw) => raw.arrayBuffer())
    this.decoder('formdata', (raw) => raw.formData())
    this.decoder('stream', (raw) => raw.body!)
    this.decoder('headers', (raw) => raw.headers)

    this.proxy(['http', 'https'], (url) => {
      return new this.undici.ProxyAgent(url.href)
    })

    // file: URL
    this.ctx.on('http/fetch', async (url, init, config, next) => {
      if (url.protocol !== 'file:') return next()
      if (init.method !== 'GET') {
        return new Response(null, { status: 405, statusText: 'Method Not Allowed' })
      }
      return fetchFile(url, init as globalThis.RequestInit, {
        download: true,
        onError: ctx.logger.error,
      })
    }, { prepend: true })

    // data: URL
    // https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Schemes/data
    this.ctx.on('http/fetch', async (url, init, config, next) => {
      // data:[<media-type>][;base64],<data>
      const capture = /^data:([^,]*),(.*)$/.exec(url.href)
      if (!capture) return next()
      if (init.method !== 'GET') {
        return new Response(null, { status: 405, statusText: 'Method Not Allowed' })
      }
      let [, type, data] = capture
      let bodyInit: BodyInit = data
      if (type.endsWith(';base64')) {
        type = type.slice(0, -7)
        bodyInit = Binary.fromBase64(data)
      } else {
        bodyInit = decodeURIComponent(data)
      }
      return new Response(bodyInit, {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': type },
      })
    }, { prepend: true })
  }

  get undici() {
    if (Http.undici) return Http.undici
    throw new Error('please install `undici`')
  }

  static mergeConfig = (target: Http.Config, source?: Http.Config) => ({
    ...target,
    ...source,
    headers: {
      ...target?.headers,
      ...source?.headers,
    },
  })

  decoder<K extends keyof Http.ResponseTypes>(type: K, decoder: Http.Decoder<Http.ResponseTypes[K]>) {
    return this.ctx.effect(() => {
      this._decoders[type] = decoder
      return () => delete this._decoders[type]
    }, 'ctx.http.decoder()')
  }

  proxy(name: string[], factory: (url: URL) => Dispatcher) {
    return this.ctx.effect(() => {
      for (const key of name) {
        this._proxies[key] = factory
      }
      return () => {
        for (const key of name) {
          delete this._proxies[key]
        }
      }
    }, 'ctx.http.proxy()')
  }

  extend(config: Http.Config = {}) {
    return this[Service.extend]({
      config: Http.mergeConfig(this.config, config),
    })
  }

  resolveConfig(init?: Http.RequestConfig): Http.RequestConfig {
    return { ...this.config, ...this[Service.resolveIntercept](), ...init }
  }

  resolveURL(url: string | URL, config: Http.RequestConfig, isWebSocket = false) {
    try {
      url = new URL(url, config.baseUrl)
    } catch (error) {
      // prettify the error message
      throw new TypeError(`Invalid URL: ${url}`)
    }
    if (isWebSocket) url.protocol = url.protocol.replace(/^http/, 'ws')
    for (const [key, value] of Object.entries(config.params ?? {})) {
      if (isNullable(value)) continue
      url.searchParams.append(key, value)
    }
    return url
  }

  defaultDecoder(response: Response) {
    const type = response.headers.get('content-type')
    if (type?.startsWith('application/json')) {
      return response.json()
    } else if (type?.startsWith('text/')) {
      return response.text()
    } else {
      return response.arrayBuffer()
    }
  }

  /**
   * Rebuild a multipart body in the FormData class the `undici` package
   * recognizes. Node's global FormData belongs to the builtin fetch, which is a
   * distinct class from the package's: undici coerces a foreign one to a string,
   * so the request would carry `[object FormData]` instead of the parts.
   * @param data - request data already recognized as a FormData.
   * @returns the same body, or an equivalent one built by undici's class.
   */
  private adoptFormData(data: FormData): FormData {
    const Native = Http.undici?.FormData as (new () => FormData) | undefined
    if (Native === undefined || data.constructor === Native) return data
    const form = new Native()
    data.forEach((value, name) => {
      if (typeof value === 'string') form.append(name, value)
      else form.append(name, value, value.name)
    })
    return form
  }

  async [Service.invoke](...args: any[]) {
    let method: string | undefined
    if (typeof args[1] === 'string' || args[1] instanceof URL) {
      method = args.shift()
    }
    const config = this.resolveConfig(args[1])
    const url = this.resolveURL(args[0], config)
    method ??= config.method ?? 'GET'

    if (config.signal?.aborted) {
      throw config.signal.reason
    }
    const controller = new AbortController()
    // Combine without attaching a strong listener to `config.signal` so repeated requests sharing a long-lived
    // signal cannot accumulate closures while still cancelling both headers and response-body reads.
    const requestSignal = config.signal ? AbortSignal.any([config.signal, controller.signal]) : controller.signal

    const dispose = this.ctx.effect(() => {
      const timer = config.timeout && setTimeout(() => {
        controller.abort(new HttpError('request timeout', 'TIMEOUT'))
      }, config.timeout)
      return () => {
        clearTimeout(timer)
      }
    })
    controller.signal.addEventListener('abort', () => dispose())

    try {
      const headers = new Headers(config.headers)
      const init: RequestInit = {
        method,
        headers: headers as any,
        body: config.data,
        keepalive: config.keepAlive,
        redirect: config.redirect,
        signal: requestSignal,
      }

      if (config.data && typeof config.data === 'object') {
        const [type, body] = encodeRequest(isFormData(config.data) ? this.adoptFormData(config.data) : config.data)
        init.body = body
        if (type && !headers.has('content-type')) {
          headers.append('content-type', type)
        }
      }

      if (init.body) {
        (init as any).duplex = 'half'
      }

      if (config.proxyAgent) {
        const proxyURL = new URL(config.proxyAgent)
        const factory = this._proxies[proxyURL.protocol.slice(0, -1)]
        if (!factory) throw new Error(`Cannot resolve proxy agent ${proxyURL}`)
        init.dispatcher = factory(proxyURL)
      }

      const response = await this.ctx.waterfall(this, 'http/fetch', url, init, config, () => {
        this.ctx.logger('http:request').debug('%C %s', method, url.href)
        return this.undici.fetch(url, init) as any
      }).catch((cause) => {
        this.ctx.logger('http:request').debug('%C %s failed: %o', method, url.href, cause)
        if (Http.Error.is(cause)) throw cause
        const error = new Http.Error(`fetch ${url} failed`)
        error.cause = cause
        throw error
      })

      this.ctx.logger('http:response').debug('%C %s %s %s', method, url.href, response.status, response.statusText)
      response[kHttpConfig] = config
      return response
    } finally {
      dispose()
    }
  }

  private async _decode(response: Response) {
    const config: Http.RequestConfig = response[kHttpConfig]
    const validateStatus = config.validateStatus ?? (() => true)
    if (!validateStatus(response.status)) {
      throw new Http.Error(response.statusText, 'STATUS_ERROR', response)
    }

    if (!config.responseType) {
      return this.defaultDecoder(response)
    }

    let decoder: Http.Decoder
    if (typeof config.responseType === 'function') {
      decoder = config.responseType
    } else {
      decoder = this._decoders[config.responseType]
      if (!decoder) {
        throw new TypeError(`Unknown responseType: ${config.responseType}`)
      }
    }
    return decoder(response)
  }

  async head(url: string | URL, config?: Http.RequestConfig) {
    const response = await this(url, { method: 'HEAD', responseType: 'headers', ...config })
    return this._decode(response)
  }

  ws(url: string | URL, _config?: Http.Config) {
    const config = this.resolveConfig(_config)
    url = this.resolveURL(url, config, true)
    const headers = Object.fromEntries(new Headers(config.headers))
    const init: WebSocketInit = {
      headers,
    }

    if (config.proxyAgent) {
      const proxyURL = new URL(config.proxyAgent)
      const factory = this._proxies[proxyURL.protocol.slice(0, -1)]
      if (!factory) throw new Error(`Cannot resolve proxy agent ${proxyURL}`)
      init.dispatcher = factory(proxyURL)
    }

    const socket = this.ctx.waterfall(this, 'http/websocket', url, init, config, () => {
      this.ctx.logger('http:ws').debug('connect %s', url.href)
      return new this.undici.WebSocket(url, init) as any
    })
    const dispose = this.ctx.effect(() => {
      return () => socket.close(1000, 'context disposed')
    }, 'new WebSocket()')
    socket.addEventListener('close', () => {
      dispose()
    })
    return socket
  }
}

export default Http
