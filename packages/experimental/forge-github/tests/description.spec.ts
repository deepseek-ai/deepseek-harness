import { describe, expect, it } from 'vitest'
import type { GhOutput, GhRunner } from '../src/gh.ts'
import { DESCRIPTION_QUERY } from '../src/description.ts'
import { GitHubProvider } from '../src/provider.ts'
import type { GitHubLimits } from '../src/provider.ts'
import { pull } from './fixtures.ts'

const signal = new AbortController().signal

const limits: GitHubLimits = {
  maxOutputBytes: 8_388_608, maxReviewThreads: 1_000, maxCommits: 250, maxViewedFiles: 3_000, maxViewerItems: 50,
}

function fakeGh(handler: (args: readonly string[]) => GhOutput): { run: GhRunner; calls: string[][] } {
  const calls: string[][] = []
  return { calls, run: async (args) => { calls.push([...args]); return handler(args) } }
}

function output(stdout: unknown, exitCode = 0, stderr = ''): GhOutput {
  return { exitCode, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr }
}

function provider(run: GhRunner): GitHubProvider {
  return new GitHubProvider(run, ['github.com'], limits)
}

const FIRST = '07901e44-8333-47f0-9422-94a73c19d18c'
const SECOND = '389b0451-394a-434e-b4e5-76a74f021acf'
const THIRD = 'bc19499b-80a6-4aaf-bd24-313216c9863c'

/** A JSON Web Token whose payload is `claims`, as GitHub signs private image addresses. */
function token(claims: unknown): string {
  return `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.c2ln`
}

function signed(uuid: string, jwt: string, extension = 'png'): string {
  return `https://private-user-images.githubusercontent.com/1/2-${uuid}.${extension}?jwt=${jwt}`
}

function descriptionBody(pullRequest: unknown): Record<string, unknown> {
  return { data: { repository: { pullRequest } } }
}

describe('GitHub descriptions', () => {
  it('reads the body and labels and maps each uploaded image to the signed address the rendering gives it', async () => {
    const body = [
      'Motivation', '',
      `![shot](https://github.com/user-attachments/assets/${FIRST})`,
      `<img width="400" src="https://github.com/user-attachments/assets/${SECOND}" />`,
      `![gif](https://github.com/user-attachments/assets/${THIRD})`,
      '![badge](https://img.shields.io/badge/x-y-blue)',
      `again https://github.com/user-attachments/assets/${FIRST}`,
    ].join('\n')
    const html = [
      `<p><a href="x"><img src="${signed(FIRST, token({ exp: 1794367597, nbf: 1794367297 }))}" alt="shot"></a></p>`,
      `<img width="400" src="${signed(SECOND.toUpperCase(), token({ exp: 1794367500 }))}&amp;size=2">`,
      `<img src="${signed(THIRD, token({ nbf: 1 }), 'gif')}">`,
      '<img src="https://camo.githubusercontent.com/abc" data-canonical-src="https://img.shields.io/badge/x-y-blue">',
    ].join('\n')
    const gh = fakeGh(() => output(descriptionBody({
      body, bodyHTML: html, createdAt: '2026-11-08T12:00:00Z',
      labels: { totalCount: 3, nodes: [{ name: 'kind/feature', color: 'A2EEEF' }, { name: 'area/web', color: 'not-a-color' }] },
    })))

    const result = await provider(gh.run).readDescription(pull(8149), signal)

    expect(gh.calls).toEqual([['api', 'graphql', '--hostname', 'github.com', '-f', `query=${DESCRIPTION_QUERY}`, '-f', 'owner=octo',
      '-f', 'name=demo', '-F', 'number=8149']])
    expect(result).toEqual({
      body,
      labels: [{ name: 'kind/feature', color: 'a2eeef' }, { name: 'area/web', color: null }],
      labelsTruncated: true,
      images: {
        [`https://github.com/user-attachments/assets/${FIRST}`]: signed(FIRST, token({ exp: 1794367597, nbf: 1794367297 })),
        [`https://github.com/user-attachments/assets/${SECOND}`]: `${signed(SECOND.toUpperCase(), token({ exp: 1794367500 }))}&size=2`,
        [`https://github.com/user-attachments/assets/${THIRD}`]: signed(THIRD, token({ nbf: 1 }), 'gif'),
      },
      imagesExpireAt: new Date(1794367500 * 1000).toISOString(),
      createdAt: '2026-11-08T12:00:00Z',
    })
  })

  it('maps nothing when the rendering names no signed address, and names no expiry for tokens without one', async () => {
    const attachment = `https://github.com/user-attachments/assets/${FIRST}`
    const read = async (html: string): Promise<unknown> => await provider(fakeGh(() => output(descriptionBody({
      body: `![a](${attachment})`, bodyHTML: html, createdAt: '2026-11-08T12:00:00Z', labels: { totalCount: 0, nodes: [] },
    }))).run).readDescription(pull(1), signal)

    await expect(read(`<img src="${attachment}">`)).resolves.toMatchObject({ images: {}, imagesExpireAt: null, labelsTruncated: false })
    await expect(read(`<img src="${signed(SECOND, token({ exp: 1 }))}">`)).resolves.toMatchObject({ images: {}, imagesExpireAt: null })
    for (const jwt of ['no-dot', 'a.!!!.c', `a.${Buffer.from('not json').toString('base64url')}.c`, token({ exp: 'soon' })]) {
      await expect(read(`<img src="${signed(FIRST, jwt)}">`)).resolves.toMatchObject({ images: { [attachment]: signed(FIRST, jwt) }, imagesExpireAt: null })
    }
  })

  it.each([
    ['a missing pull request', output(descriptionBody(null)), { code: 'not-found', message: 'pull request 3 was not found' }],
    ['a missing repository', output({ data: { repository: null } }), { code: 'not-found', message: 'pull request 3 was not found' }],
    ['an unexpected answer', output(descriptionBody({ body: 1 })), { code: 'unavailable', message: 'unexpected GitHub response to the description read' }],
    ['a refusal', output('', 1, 'gh: Something went wrong (HTTP 502)'), { code: 'unavailable', message: 'gh: Something went wrong (HTTP 502)' }],
  ])('reports %s', async (_, answer, failure) => {
    await expect(provider(fakeGh(() => answer).run).readDescription(pull(3), signal)).resolves.toEqual(failure)
  })

  it('refuses an unconfigured host without asking GitHub', async () => {
    const gh = fakeGh(() => output(''))
    await expect(provider(gh.run).readDescription(pull(1, { forge: 'github', host: 'other.example', owner: 'o', name: 'n' }), signal))
      .resolves.toEqual({ code: 'unavailable', message: 'forge-github: host "other.example" is not configured' })
    expect(gh.calls).toEqual([])
  })
})
