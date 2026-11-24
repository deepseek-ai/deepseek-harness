import { describe, expect, it } from 'vitest'
import { GitLabApi } from '../src/api.ts'
import { DESCRIPTION_QUERY, readDescription } from '../src/description.ts'
import type { GlabOutput } from '../src/glab.ts'
import { app, fakeGlab, HOST, json, merge, output, sent } from './fixtures.ts'

const signal = new AbortController().signal

/** The secret GitLab names one upload by. */
const SECRET = '0123456789abcdef0123456789abcdef'

function api(answer: GlabOutput) {
  const glab = fakeGlab(() => answer)
  return { subject: new GitLabApi(glab.run), calls: glab.calls }
}

/** An answer with one merge request of project 278, or with none. */
function answer(mergeRequest: unknown, id = 'gid://gitlab/Project/278'): GlabOutput {
  return json({ data: { project: { id, mergeRequest } } })
}

describe('GitLab descriptions', () => {
  it('reads the description and labels through one request and names uploads where GitLab serves them', async () => {
    const description = [
      'Motivation', '',
      `![shot](/uploads/${SECRET}/shot.png)`,
      `[log](/uploads/${SECRET}/build.log) and <img width="400" src="/uploads/${SECRET}/wide.png" />`,
      '![badge](https://img.shields.io/badge/x-y-blue)',
      '[guide](/help/user/index) and ![short](/uploads/0123/short.png)',
      `plain /uploads/${SECRET}/plain.png`,
    ].join('\n')
    const labels = [{ title: 'kind::feature', color: '#A2EEEF' }, { title: 'area/web', color: 'red' }, { title: 'short', color: '#fff' }]
    const { subject, calls } = api(answer({ description, createdAt: '2026-11-08T12:00:00Z', labels: { count: 4, nodes: labels } }))

    const result = await readDescription(subject, merge(6), signal)

    expect(calls.map(call => call.args))
      .toEqual([['api', 'graphql', '--hostname', HOST, '--input', '-', '-H', 'Content-Type: application/json']])
    expect(sent(calls[0])).toEqual({ query: DESCRIPTION_QUERY, variables: { path: 'group/sub/app', iid: '6' } })
    const uploads = `https://${HOST}/-/project/278/uploads/${SECRET}`
    expect(result).toEqual({
      body: [
        'Motivation', '',
        `![shot](${uploads}/shot.png)`,
        `[log](${uploads}/build.log) and <img width="400" src="${uploads}/wide.png" />`,
        '![badge](https://img.shields.io/badge/x-y-blue)',
        '[guide](/help/user/index) and ![short](/uploads/0123/short.png)',
        `plain /uploads/${SECRET}/plain.png`,
      ].join('\n'),
      labels: [{ name: 'kind::feature', color: 'a2eeef' }, { name: 'area/web', color: null }, { name: 'short', color: null }],
      labelsTruncated: true,
      images: {},
      imagesExpireAt: null,
      createdAt: '2026-11-08T12:00:00Z',
    })
  })

  it('reads a merge request without a description or labels', async () => {
    const { subject } = api(answer({ description: null, createdAt: '2026-11-08T12:00:00Z', labels: { count: 0, nodes: [] } }))
    await expect(readDescription(subject, merge(6), signal)).resolves.toEqual({
      body: '', labels: [], labelsTruncated: false, images: {}, imagesExpireAt: null, createdAt: '2026-11-08T12:00:00Z',
    })
  })

  it.each([
    ['a missing merge request', answer(null), { code: 'not-found', message: 'merge request 3 was not found' }],
    ['a missing project', json({ data: { project: null } }), { code: 'not-found', message: 'merge request 3 was not found' }],
    ['an unexpected answer', answer({ description: 1 }),
      { code: 'unavailable', message: 'unexpected GitLab response to the description read' }],
    ['a project id that names no number', answer(null, 'gid://gitlab/Project/'),
      { code: 'unavailable', message: 'unexpected GitLab response to the description read' }],
    ['a refusal', output('', 1, 'glab: 502 Bad Gateway (HTTP 502)'), { code: 'unavailable', message: '502 Bad Gateway (HTTP 502)' }],
  ])('reports %s', async (_label, body, failure) => {
    await expect(readDescription(api(body).subject, merge(3), signal)).resolves.toEqual(failure)
  })

  it('rejects a project path GitLab cannot hold before any request', async () => {
    const { subject, calls } = api(answer(null))
    await expect(readDescription(subject, merge(6, { ...app, name: 'a b' }), signal))
      .rejects.toThrow('forge-gitlab: invalid project "group/sub/a b"')
    expect(calls).toEqual([])
  })
})
