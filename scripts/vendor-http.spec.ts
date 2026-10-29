/** Multipart request bodies reach the fetch implementation the HTTP service dispatches with. */
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Http from '@deepseek-ai/cordis-plugin-http'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

interface Captured {
  headers: IncomingHttpHeaders
  body: string
}

/** Serve one JSON answer per request and record what the client actually sent. */
async function loopback(): Promise<{ url: string; captured: Captured[]; close: () => Promise<void> }> {
  const captured: Captured[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      captured.push({ headers: request.headers, body: Buffer.concat(chunks).toString('latin1') })
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ code: 0, data: { image_key: 'img_probe' } }))
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}/upload`,
    captured,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve() })
    }),
  }
}

describe('cordis http multipart bodies', () => {
  it('sends a FormData body as multipart parts instead of a stringified value', async () => {
    const { url, captured, close } = await loopback()
    const ctx = new Context()
    contexts.push(ctx)
    try {
      await ctx.plugin(Http)
      const form = new FormData()
      form.append('image_type', 'message')
      form.append('image', new File([new Uint8Array([0xff, 0xd8, 0xff])], 'pig.jpg'))
      const answer = await ctx.http.post<{ code: number }>(url, form)
      expect(answer).toMatchObject({ code: 0 })
      const [request] = captured
      expect(request?.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)
      expect(request?.body).not.toContain('[object FormData]')
      expect(request?.body).toContain('name="image_type"')
      expect(request?.body).toContain('message')
      expect(request?.body).toContain('filename="pig.jpg"')
    } finally {
      await close()
    }
  })

  it('still sends an ordinary object body as JSON', async () => {
    const { url, captured, close } = await loopback()
    const ctx = new Context()
    contexts.push(ctx)
    try {
      await ctx.plugin(Http)
      await ctx.http.post(url, { app_id: 'cli_probe', app_secret: 'secret' })
      const [request] = captured
      expect(request?.headers['content-type']).toBe('application/json')
      expect(request?.body).toBe('{"app_id":"cli_probe","app_secret":"secret"}')
    } finally {
      await close()
    }
  })
})
