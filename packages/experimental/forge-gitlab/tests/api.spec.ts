import { describe, expect, it } from 'vitest'
import { failureOf, GitLabApi } from '../src/api.ts'
import { GlabOutputLimitError, GlabTimeoutError, GlabUnavailableError } from '../src/glab.ts'
import type { GlabOutput } from '../src/glab.ts'
import { fakeGlab, HOST, json, output, sent } from './fixtures.ts'

const signal = new AbortController().signal

describe('GitLab REST reads', () => {
  it('names the host and parses JSON', async () => {
    const glab = fakeGlab(() => json({ id: 1 }))
    await expect(new GitLabApi(glab.run).rest(HOST, 'user', signal)).resolves.toEqual({ ok: true, body: { id: 1 } })
    expect(glab.calls[0]?.args).toEqual(['api', '--hostname', HOST, 'user'])
  })

  it('reports output that is not JSON', async () => {
    await expect(new GitLabApi(fakeGlab(() => output('<html>')).run).rest(HOST, 'user', signal))
      .resolves.toEqual({ ok: false, failure: { code: 'unavailable', message: 'GitLab returned output that is not JSON' } })
  })

  it.each([
    [output('{"message":"404 Project Not Found"}', 1, 'glab: 404 Project Not Found (HTTP 404)'), { code: 'not-found', message: '404 Project Not Found (HTTP 404)' }],
    [output('', 1, '          \n   ERROR  \n          \n Unauthenticated. '), { code: 'unauthenticated', message: 'Unauthenticated.' }],
    [output('', 1, 'glab: 401 Unauthorized (HTTP 401)'), { code: 'unauthenticated', message: '401 Unauthorized (HTTP 401)' }],
    [output('', 1, 'glab: Not Acceptable (HTTP 406)'), { code: 'too-large', message: 'Not Acceptable (HTTP 406)' }],
    [output('', 1, 'glab: Payload Too Large (HTTP 413)'), { code: 'too-large', message: 'Payload Too Large (HTTP 413)' }],
    [output('', 1, 'glab: 500 Internal Server Error (HTTP 500)'), { code: 'unavailable', message: '500 Internal Server Error (HTTP 500)' }],
    [output('{"message":"busy"}', 2), { code: 'unavailable', message: '{"message":"busy"}' }],
    [output('', 2), { code: 'unavailable', message: 'glab exited with status 2' }],
  ])('maps a failed run to a forge failure', async (run, failure) => {
    expect(failureOf(run)).toEqual(failure)
    await expect(new GitLabApi(fakeGlab(() => run).run).rest(HOST, 'user', signal)).resolves.toEqual({ ok: false, failure })
  })

  it.each([
    [new GlabOutputLimitError('glab api output exceeds maxOutputBytes'), 'too-large'],
    [new GlabUnavailableError('glab could not start: spawn glab ENOENT'), 'unavailable'],
    [new GlabTimeoutError('glab api timed out after 10ms'), 'unavailable'],
  ] as const)('maps a runner that cannot finish to %s', async (error, code) => {
    await expect(new GitLabApi(fakeGlab(() => { throw error }).run).rest(HOST, 'user', signal))
      .resolves.toEqual({ ok: false, failure: { code, message: error.message } })
  })

  it('rethrows other runner errors, and the abort reason once cancelled', async () => {
    await expect(new GitLabApi(fakeGlab(() => { throw new TypeError('bug') }).run).rest(HOST, 'user', signal)).rejects.toThrow('bug')
    const controller = new AbortController()
    controller.abort(new Error('stopped'))
    await expect(new GitLabApi(fakeGlab(() => { throw new GlabTimeoutError('late') }).run).rest(HOST, 'user', controller.signal)).rejects.toThrow('stopped')
  })

  it('reads text and its failures', async () => {
    await expect(new GitLabApi(fakeGlab(() => output('a\nb')).run).restText(HOST, 'raw', signal)).resolves.toBe('a\nb')
    await expect(new GitLabApi(fakeGlab(() => output('', 1, 'glab: 404 File Not Found (HTTP 404)')).run).restText(HOST, 'raw', signal))
      .resolves.toEqual({ code: 'not-found', message: '404 File Not Found (HTTP 404)' })
    await expect(new GitLabApi(fakeGlab(() => { throw new GlabTimeoutError('late') }).run).restText(HOST, 'raw', signal))
      .resolves.toEqual({ code: 'unavailable', message: 'late' })
  })

  it('reads a page with GitLab\'s total count', async () => {
    const glab = fakeGlab(path => path.endsWith('total') ? output('HTTP/1.1 200 OK\nX-Page: 1\r\nX-Total: 150\r\n\r\n[1,2]')
      : path.endsWith('none') ? output('HTTP/1.1 200 OK\r\nX-Page: 1\r\n\r\n[3]') : output('[4]'))
    const api = new GitLabApi(glab.run)
    await expect(api.restPage(HOST, 'list?total', signal)).resolves.toEqual({ ok: true, body: [1, 2], total: 150 })
    await expect(api.restPage(HOST, 'list?none', signal)).resolves.toEqual({ ok: true, body: [3], total: null })
    await expect(api.restPage(HOST, 'list?bare', signal)).resolves.toEqual({ ok: true, body: [4], total: null })
    expect(glab.calls[0]?.args).toEqual(['api', '-i', '--hostname', HOST, 'list?total'])
  })

  it('reports a page that failed or is not JSON', async () => {
    await expect(new GitLabApi(fakeGlab(() => output('', 1, 'glab: (HTTP 404)')).run).restPage(HOST, 'list', signal))
      .resolves.toEqual({ ok: false, failure: { code: 'not-found', message: '(HTTP 404)' } })
    await expect(new GitLabApi(fakeGlab(() => output('HTTP/1.1 200 OK\r\n\r\nnot json')).run).restPage(HOST, 'list', signal))
      .resolves.toEqual({ ok: false, failure: { code: 'unavailable', message: 'GitLab returned output that is not JSON' } })
    await expect(new GitLabApi(fakeGlab(() => { throw new GlabUnavailableError('gone') }).run).restPage(HOST, 'list', signal))
      .resolves.toEqual({ ok: false, failure: { code: 'unavailable', message: 'gone' } })
  })
})

describe('GitLab GraphQL reads', () => {
  it('sends the document and variables on stdin and returns the data', async () => {
    const glab = fakeGlab(() => json({ data: { currentUser: { username: 'lin' } } }))
    await expect(new GitLabApi(glab.run).graphql(HOST, 'query { currentUser { username } }', { a: 1 }, signal))
      .resolves.toEqual({ ok: true, body: { currentUser: { username: 'lin' } } })
    expect(glab.calls[0]?.args).toEqual(['api', 'graphql', '--hostname', HOST, '--input', '-', '-H', 'Content-Type: application/json'])
    expect(sent(glab.calls[0])).toEqual({ query: 'query { currentUser { username } }', variables: { a: 1 } })
  })

  it.each([
    [{ errors: [{ message: 'Query has complexity of 270, which exceeds max complexity of 250' }] }, 'too-large'],
    [{ errors: [{ message: 'Query too large' }] }, 'too-large'],
    [{ errors: [{ message: 'Unauthenticated' }] }, 'unauthenticated'],
    [{ errors: [{ message: 'Field x does not exist' }, { code: 1 }] }, 'unavailable'],
  ] as const)('maps GraphQL errors %j', async (body, code) => {
    const result = await new GitLabApi(fakeGlab(() => output(JSON.stringify(body), 1, 'glab: error')).run).graphql(HOST, 'q', {}, signal)
    expect(result).toMatchObject({ ok: false, failure: { code } })
  })

  it('reports a failed run without GraphQL errors, an answer without data, and a runner that cannot finish', async () => {
    await expect(new GitLabApi(fakeGlab(() => output('', 1, 'glab: 502 Bad Gateway (HTTP 502)')).run).graphql(HOST, 'q', {}, signal))
      .resolves.toEqual({ ok: false, failure: { code: 'unavailable', message: '502 Bad Gateway (HTTP 502)' } })
    await expect(new GitLabApi(fakeGlab(() => json({ data: null })).run).graphql(HOST, 'q', {}, signal))
      .resolves.toEqual({ ok: false, failure: { code: 'unavailable', message: 'GitLab returned no GraphQL data' } })
    await expect(new GitLabApi(fakeGlab(() => output('nope')).run).graphql(HOST, 'q', {}, signal))
      .resolves.toEqual({ ok: false, failure: { code: 'unavailable', message: 'GitLab returned no GraphQL data' } })
    await expect(new GitLabApi(fakeGlab(() => { throw new GlabTimeoutError('late') }).run).graphql(HOST, 'q', {}, signal))
      .resolves.toEqual({ ok: false, failure: { code: 'unavailable', message: 'late' } })
  })
})

describe('GitLab writes', () => {
  it('sends one request and returns its answer', async () => {
    const glab = fakeGlab(() => json({ state: 'merged' }))
    await expect(new GitLabApi(glab.run).write(HOST, ['-X', 'PUT', 'merge'], signal, '{}')).resolves.toEqual({ ok: true, body: { state: 'merged' } })
    expect(glab.calls).toEqual([{ args: ['api', '--hostname', HOST, '-X', 'PUT', 'merge'], input: '{}' }])
  })

  it.each([
    [output('{"message":"SHA does not match"}', 1, 'glab: 409 SHA does not match HEAD of source branch (HTTP 409)'), 409, 'failed'],
    [output('', 1, 'glab: 401 Unauthorized (HTTP 401)'), 401, 'unauthenticated'],
    [output('', 1, 'glab: 405 Method Not Allowed (HTTP 405)'), 405, 'failed'],
    [output('', 1, 'glab: 502 Bad Gateway (HTTP 502)'), 502, 'unknown'],
    [output('', 1, 'glab: Unauthenticated'), null, 'unauthenticated'],
    [output('', 1, 'glab: connection reset by peer'), null, 'unknown'],
  ] as const)('maps an answer with status %#', async (run, status, code) => {
    const result = await new GitLabApi(fakeGlab(() => run).run).write(HOST, ['merge'], signal)
    expect(result).toMatchObject({ ok: false, status, failure: { code } })
  })

  it('keeps the body GitLab answered a refusal with', async () => {
    await expect(new GitLabApi(fakeGlab(() => output('{"message":"no"}', 1, 'glab: (HTTP 400)')).run).write(HOST, ['x'], signal))
      .resolves.toEqual({ ok: false, status: 400, body: { message: 'no' }, failure: { code: 'failed', message: '(HTTP 400)' } })
  })

  it.each([
    [new GlabTimeoutError('late'), 'unknown'],
    [new GlabOutputLimitError('big'), 'unknown'],
    [new GlabUnavailableError('gone'), 'failed'],
  ] as const)('maps a runner that cannot finish a write to %s', async (error, code) => {
    await expect(new GitLabApi(fakeGlab(() => { throw error }).run).write(HOST, ['merge'], signal))
      .resolves.toEqual({ ok: false, status: null, body: undefined, failure: { code, message: error.message } })
  })

  it('rethrows other runner errors, and the abort reason once cancelled', async () => {
    await expect(new GitLabApi(fakeGlab(() => { throw new TypeError('bug') }).run).write(HOST, ['merge'], signal)).rejects.toThrow('bug')
    const controller = new AbortController()
    controller.abort(new Error('stopped'))
    await expect(new GitLabApi(fakeGlab(() => { throw new GlabTimeoutError('late') }).run).write(HOST, ['merge'], controller.signal)).rejects.toThrow('stopped')
  })
})

describe('GitLab mutations', () => {
  const mutate = async (run: GlabOutput | (() => GlabOutput)) => {
    const glab = fakeGlab(typeof run === 'function' ? run : () => run)
    const result = await new GitLabApi(glab.run).mutate(HOST, 'mutation { m }', { a: 1 }, 'm', signal)
    return { result, glab }
  }

  it('sends the document on stdin and returns the payload of the field', async () => {
    const { result, glab } = await mutate(json({ data: { m: { errors: [], id: 1 } } }))
    expect(result).toEqual({ ok: true, payload: { errors: [], id: 1 } })
    expect(glab.calls[0]?.args).toEqual(['api', '--hostname', HOST, 'graphql', '--input', '-', '-H', 'Content-Type: application/json'])
    expect(sent(glab.calls[0])).toEqual({ query: 'mutation { m }', variables: { a: 1 } })
  })

  it.each([
    ['payload errors', json({ data: { m: { errors: ['Reviewer is invalid'] } } }), { code: 'failed', message: 'Reviewer is invalid' }],
    ['GraphQL errors', output(JSON.stringify({ errors: [{ message: 'does not exist' }, { message: 'or no permission' }], data: { m: null } }), 1, 'glab: does not exist'),
      { code: 'failed', message: 'does not exist; or no permission' }],
    ['credentials', output(JSON.stringify({ errors: [{ message: 'Unauthenticated' }] }), 1), { code: 'unauthenticated', message: 'Unauthenticated' }],
    ['a payload beside a failed run', output(JSON.stringify({ data: { m: { errors: [] } } }), 1, 'glab: (HTTP 502)'), { code: 'unknown', message: '(HTTP 502)' }],
    ['a run without an answer', output('', 1, 'glab: (HTTP 502)'), { code: 'unknown', message: '(HTTP 502)' }],
    ['an answer without the field', json({ data: {} }), { code: 'unknown', message: 'unexpected GitLab response to m' }],
  ] as const)('maps %s', async (_label, run, failure) => {
    expect((await mutate(run)).result).toEqual(failure)
  })
})
