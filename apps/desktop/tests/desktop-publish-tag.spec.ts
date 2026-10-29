import { expect, it } from 'vitest'
import { publishDesktopTag } from '../scripts/desktop-publish-tag.ts'

const commit = 'a'.repeat(40)
const tag = (sha = commit) => ({ object: { type: 'commit', sha } })
function transport(replies: Array<{ status: number; body?: object; rawBody?: string; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const request: typeof fetch = async (url, init) => {
    calls.push({ url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url, init })
    const reply = replies.shift()
    if (!reply) throw new Error('unexpected HTTP request')
    return new Response(reply.rawBody ?? JSON.stringify(reply.body ?? {}), { status: reply.status, headers: reply.headers ?? {} })
  }
  return { calls, request }
}

it('tags the packaged commit using explicit App authentication', async () => {
  const http = transport([{ status: 404 }, { status: 201, body: tag() }])
  await expect(publishDesktopTag('owner/repo', '1.2.3', commit, 'fixture-token', http.request)).resolves.toBe('created')
  expect(http.calls[1]?.init?.body).toBe(JSON.stringify({ ref: 'refs/tags/desktop-v1.2.3', sha: commit }))
  expect(http.calls[1]?.init?.headers).toMatchObject({ Authorization: 'Bearer fixture-token' })
})

it('does not write when the same release tag already exists', async () => {
  const http = transport([{ status: 200, body: tag() }])
  await expect(publishDesktopTag('owner/repo', '1.2.3', commit, 'fixture-token', http.request)).resolves.toBe('present')
  expect(http.calls).toHaveLength(1)
})

it('rejects a conflicting tag without updating or deleting it', async () => {
  const http = transport([{ status: 200, body: tag('b'.repeat(40)) }])
  await expect(publishDesktopTag('owner/repo', '1.2.3', commit, 'fixture-token', http.request)).rejects.toThrow(/refusing to move/u)
  expect(http.calls).toHaveLength(1)
})

it('reconciles a create race between two platform releases', async () => {
  const http = transport([{ status: 404 }, { status: 422 }, { status: 200, body: tag() }])
  await expect(publishDesktopTag('owner/repo', '1.2.3', commit, 'fixture-token', http.request)).resolves.toBe('present')
  expect(http.calls.map(call => call.init?.method ?? 'GET')).toEqual(['GET', 'POST', 'GET'])
})

it('does not reinterpret authorization failure as a missing tag', async () => {
  const http = transport([{ status: 403 }])
  await expect(publishDesktopTag('owner/repo', '1.2.3', commit, 'fixture-token', http.request)).rejects.toThrow(/HTTP 403/u)
  expect(http.calls).toHaveLength(1)
})

it('rejects missing credentials and malformed inputs before any request', async () => {
  const http = transport([])
  await expect(publishDesktopTag('owner/repo', '1.2.3', commit, '', http.request)).rejects.toThrow(/required/u)
  await expect(publishDesktopTag('owner/repo/other', '1.2.3', commit, 'fixture', http.request)).rejects.toThrow(/invalid/u)
  expect(http.calls).toHaveLength(0)
})

it('explains an existing annotated tag without replacing it', async () => {
  const http = transport([{ status: 200, body: { object: { type: 'tag', sha: commit } } }])
  await expect(publishDesktopTag('owner/repo', '1.2.3', commit, 'fixture-token', http.request)).rejects.toThrow(/not a lightweight commit tag/u)
  expect(http.calls).toHaveLength(1)
})

it('keeps the creation status and safe rule diagnostic when no competing tag exists', async () => {
  const http = transport([{ status: 404 }, { status: 422,
    headers: { 'x-github-request-id': 'ABCD:1234' },
    body: { message: 'Repository rule violations found for refs/tags/desktop-v1.2.3', errors: ['secret-value'] } }, { status: 404 }])
  const failure = publishDesktopTag('owner/repo', '1.2.3', commit, 'fixture-token', http.request)
  await expect(failure).rejects.toThrow('creation failed (HTTP 422; GitHub request ABCD:1234); follow-up tag lookup returned HTTP 404; repository rules rejected')
  await expect(failure).rejects.not.toThrow('secret-value')
  expect(http.calls.map(call => call.init?.method ?? 'GET')).toEqual(['GET', 'POST', 'GET'])
})

it('does not echo arbitrary GitHub response text or unrecognized request IDs', async () => {
  const http = transport([{ status: 404 }, { status: 422,
    headers: { 'x-github-request-id': 'fixture-token' }, body: { message: 'fixture-token' } }, { status: 403 }])
  const failure = publishDesktopTag('owner/repo', '1.2.3', commit, 'fixture-token', http.request)
  await expect(failure).rejects.toThrow('creation failed (HTTP 422); follow-up tag lookup returned HTTP 403')
  await expect(failure).rejects.not.toThrow('fixture-token')
})

it('still rejects a competing tag on a different commit', async () => {
  const http = transport([{ status: 404 }, { status: 422 }, { status: 200, body: tag('b'.repeat(40)) }])
  await expect(publishDesktopTag('owner/repo', '1.2.3', commit, 'fixture-token', http.request)).rejects.toThrow('creation failed (HTTP 422)')
})

it('retains creation context for a non-JSON rejection', async () => {
  const http = transport([{ status: 404 }, { status: 422, rawBody: 'not JSON', headers: { 'x-github-request-id': 'ABCD:1234' } }, { status: 404 }])
  await expect(publishDesktopTag('owner/repo', '1.2.3', commit, 'fixture-token', http.request)).rejects.toThrow('creation failed (HTTP 422; GitHub request ABCD:1234)')
})

it('retains creation context when the follow-up request fails', async () => {
  const http = transport([{ status: 404 }, { status: 422, headers: { 'x-github-request-id': 'ABCD:1234' } }])
  await expect(publishDesktopTag('owner/repo', '1.2.3', commit, 'fixture-token', http.request)).rejects.toThrow('creation failed (HTTP 422; GitHub request ABCD:1234); follow-up tag lookup failed')
})
