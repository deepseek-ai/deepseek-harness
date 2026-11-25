/**
 * Multipart request bodies reach the fetch implementation the HTTP service dispatches with, and request
 * configuration resolves through the Core rc.12 intercept API the vendored http 1.6.0 source uses.
 */
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

describe('cordis http request configuration', () => {
  it('applies a context intercept and lets the request config replace its headers', async () => {
    const { url, captured, close } = await loopback()
    const ctx = new Context()
    contexts.push(ctx)
    try {
      await ctx.plugin(Http, { headers: { 'x-service': 'service' } })
      const scoped = ctx.intercept('http', { headers: { 'x-intercept': 'intercept' } })
      await scoped.http.get(url)
      await scoped.http.get(url, { headers: { 'x-request': 'request' } })
      const [intercepted, requested] = captured
      expect(intercepted?.headers['x-intercept']).toBe('intercept')
      expect(intercepted?.headers['x-service']).toBeUndefined()
      expect(requested?.headers['x-request']).toBe('request')
      expect(requested?.headers['x-intercept']).toBeUndefined()
    } finally {
      await close()
    }
  })

  it('keeps service-level headers when neither the intercept nor the request sets any', async () => {
    const { url, captured, close } = await loopback()
    const ctx = new Context()
    contexts.push(ctx)
    try {
      await ctx.plugin(Http, { headers: { 'x-service': 'service' } })
      await ctx.intercept('http', { timeout: 5000 }).http.get(url)
      expect(captured[0]?.headers['x-service']).toBe('service')
    } finally {
      await close()
    }
  })
})
