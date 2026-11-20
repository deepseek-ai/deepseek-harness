/** Pull request descriptions through GraphQL, with the image addresses a browser can load without a GitHub session. */

import type { ChangeRequestDescription, ChangeRequestRef, ForgeFailure } from '@deepseek-ai/dsh-experimental-forge'
import { z } from 'zod'
import type { GraphqlReader } from './commits.ts'
import { checkedRepository } from './urls.ts'

/** Most labels one read lists, GitHub's connection maximum. */
const LABELS = 100

/** One pull request's description, its rendered form, and its labels; variables `owner`, `name`, and the integer `number`. */
export const DESCRIPTION_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { body bodyHTML createdAt labels(first: ${LABELS}) { totalCount nodes { name color } } }
  }
}`

const descriptionSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        body: z.string(),
        bodyHTML: z.string(),
        createdAt: z.string(),
        labels: z.object({
          totalCount: z.number().int().nonnegative(),
          nodes: z.array(z.object({ name: z.string(), color: z.string() })),
        }),
      }).nullable(),
    }).nullable(),
  }),
})

/** A UUID, as GitHub names an uploaded attachment. */
const UUID = String.raw`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`

/** An attachment address in Markdown: `https://<host>/user-attachments/assets/<uuid>`. */
const ATTACHMENT = new RegExp(String.raw`https://[^\s"'()<>]+/user-attachments/assets/(${UUID})`, 'gi')

/** A rendered image source signed for loading without a session, ending in `-<uuid>.<ext>?jwt=<token>`. */
const SIGNED = new RegExp(String.raw`<img\b[^>]*\bsrc="(https://[^"]+-(${UUID})\.[a-z0-9]+\?[^"]*\bjwt=([^"&]+)[^"]*)"`, 'gi')

const HEX_COLOR = /^[0-9a-f]{6}$/i

const claimsSchema = z.object({ exp: z.number() })

/**
 * Read a pull request's description. On a private repository an uploaded image's Markdown address answers only with the
 * user's GitHub session, while the rendered description names a short-lived signed address for the same upload; each
 * upload the Markdown names is mapped to its signed address. The rendered description is used for nothing else.
 * @param read - runs one GraphQL request.
 * @param ref - pull request.
 * @param signal - cancellation of the read.
 * @returns the description, or why GitHub did not provide it.
 */
export async function readDescription(
  read: GraphqlReader, ref: ChangeRequestRef, signal: AbortSignal,
): Promise<ChangeRequestDescription | ForgeFailure> {
  const { host, owner, name } = checkedRepository(ref)
  const output = await read(['api', 'graphql', '--hostname', host, '-f', `query=${DESCRIPTION_QUERY}`, '-f', `owner=${owner}`,
    '-f', `name=${name}`, '-F', `number=${ref.number}`], signal)
  if (!output.ok) return output.failure
  const parsed = descriptionSchema.safeParse(output.body)
  if (!parsed.success) return { code: 'unavailable', message: 'unexpected GitHub response to the description read' }
  const pull = parsed.data.data.repository?.pullRequest
  if (pull == null) return { code: 'not-found', message: `pull request ${ref.number} was not found` }
  const { images, expiresAt } = signedImages(pull.body, pull.bodyHTML)
  return {
    body: pull.body,
    labels: pull.labels.nodes.map(label => ({ name: label.name, color: HEX_COLOR.test(label.color) ? label.color.toLowerCase() : null })),
    labelsTruncated: pull.labels.totalCount > pull.labels.nodes.length,
    images,
    imagesExpireAt: expiresAt,
    createdAt: pull.createdAt,
  }
}

/**
 * Pair each attachment address in the Markdown with the signed address the rendered description gives its upload.
 * @param body - Markdown source.
 * @param html - GitHub's rendering of `body`.
 * @returns the pairs, and the earliest expiry the signed addresses name, or null when none names one.
 */
function signedImages(body: string, html: string): { readonly images: Record<string, string>; readonly expiresAt: string | null } {
  const signed = new Map<string, { readonly url: string; readonly expires: number | undefined }>()
  for (const [, source = '', uuid = '', token = ''] of html.matchAll(SIGNED)) {
    const url = source.replaceAll('&amp;', '&')
    signed.set(uuid.toLowerCase(), { url, expires: expiryOf(token) })
  }
  const images: Record<string, string> = {}
  let earliest: number | undefined
  for (const [address = '', uuid = ''] of body.matchAll(ATTACHMENT)) {
    const match = signed.get(uuid.toLowerCase())
    if (match === undefined) continue
    images[address] = match.url
    if (match.expires !== undefined) earliest = Math.min(earliest ?? match.expires, match.expires)
  }
  return { images, expiresAt: earliest === undefined ? null : new Date(earliest * 1000).toISOString() }
}

/**
 * Read the expiry of a signed address from its JSON Web Token.
 * @param token - the `jwt` query value.
 * @returns the `exp` claim in epoch seconds, or undefined when the token names none.
 */
function expiryOf(token: string): number | undefined {
  const [, payload] = token.split('.')
  if (payload === undefined) return undefined
  let claims: unknown
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch (error) {
    void error // A token GitHub did not sign as JSON names no expiry.
    return undefined
  }
  const parsed = claimsSchema.safeParse(claims)
  return parsed.success ? parsed.data.exp : undefined
}
