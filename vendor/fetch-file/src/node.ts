import { fileURLToPath } from 'node:url'
import { basename } from 'node:path'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { fileTypeFromStream } from 'file-type'
import { contentType } from 'mime-types'

namespace fetchFile {
  export interface Options {
    download?: boolean
    onError?: (reason: any) => void
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError')
}

async function sniffWithSignal(
  stream: Parameters<typeof fileTypeFromStream>[0],
  raw: ReturnType<typeof createReadStream>,
  signal?: AbortSignal | null,
) {
  if (signal?.aborted) {
    raw.destroy()
    throw abortError(signal)
  }
  if (!signal) return await fileTypeFromStream(stream)
  return await new Promise<Awaited<ReturnType<typeof fileTypeFromStream>>>((resolve, reject) => {
    const onAbort = () => {
      raw.destroy()
      reject(abortError(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    fileTypeFromStream(stream).then(
      (result) => {
        signal.removeEventListener('abort', onAbort)
        resolve(result)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

async function fetchFile(url: string | URL, init: RequestInit = {}, options: fetchFile.Options = {}) {
  url = new URL(url)
  if (init.signal?.aborted) throw abortError(init.signal)
  try {
    const raw1 = createReadStream(fileURLToPath(url))
    const stream1 = Readable.toWeb(raw1) as Parameters<typeof fileTypeFromStream>[0]
    const fileType = await sniffWithSignal(stream1, raw1, init.signal)
    if (init.signal?.aborted) throw abortError(init.signal)
    const stream2 = Readable.toWeb(createReadStream(fileURLToPath(url))) as ReadableStream
    const filename = basename(url.pathname)
    return new Response(stream2, {
      status: 200,
      statusText: 'OK',
      headers: {
        'content-type': fileType?.mime || contentType(filename) || 'application/octet-stream',
        ...options.download === true
          ? { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` }
          : options.download === false
            ? { 'content-disposition': 'inline' }
            : {},
      },
    })
  } catch (error: any) {
    if (init.signal?.aborted) throw error
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'EISDIR') {
      return new Response(null, { status: 404, statusText: 'Not Found' })
    } else if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      return new Response(null, { status: 403, statusText: 'Forbidden' })
    } else if (error?.code === 'ENAMETOOLONG') {
      return new Response(null, { status: 414, statusText: 'URI Too Long' })
    }
    options.onError?.(error)
    return new Response(null, { status: 500, statusText: 'Internal Server Error' })
  }
}

export default fetchFile
