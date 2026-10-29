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

async function fetchFile(url: string | URL, init: RequestInit = {}, options: fetchFile.Options = {}) {
  url = new URL(url)
  try {
    const stream1 = Readable.toWeb(createReadStream(fileURLToPath(url)))
    const fileType = await fileTypeFromStream(stream1)
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
