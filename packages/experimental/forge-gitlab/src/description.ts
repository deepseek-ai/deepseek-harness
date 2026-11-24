/** Merge request descriptions through GraphQL, with the uploads they name at the addresses GitLab serves them from. */

import type { ChangeRequestDescription, ChangeRequestRef, ForgeFailure } from '@deepseek-ai/dsh-experimental-forge'
import { z } from 'zod'
import type { GitLabApi } from './api.ts'
import { checkedProject } from './urls.ts'

/** Most labels one read lists, GitLab's connection page maximum. */
const LABELS = 100

/** One merge request's description, creation time, and labels, with its project's id; variables `path` and `iid` are strings. */
export const DESCRIPTION_QUERY = `query($path: ID!, $iid: String!) {
  project(fullPath: $path) { id mergeRequest(iid: $iid) { description createdAt labels(first: ${LABELS}) { count nodes { title color } } } }
}`

/** Global id of a project, which ends in the number that names the project in upload addresses. */
export const PROJECT_ID = /^gid:\/\/gitlab\/Project\/\d+$/

const descriptionSchema = z.object({
  project: z.object({
    id: z.string().regex(PROJECT_ID),
    mergeRequest: z.object({
      description: z.string().nullable(),
      createdAt: z.string(),
      labels: z.object({
        count: z.number().int().nonnegative(),
        nodes: z.array(z.object({ title: z.string(), color: z.string() })),
      }),
    }).nullable(),
  }).nullable(),
})

/**
 * The start of an upload address as GitLab writes it in Markdown, `/uploads/<32 hex digits>/<file>` without host or
 * project, where a Markdown link or image (`](`) or an HTML `src="` names it.
 */
const UPLOAD = /(\]\(|\bsrc=")(\/uploads\/[0-9a-f]{32}\/)/g

/** A label color as GitLab reports it, `#rrggbb`. */
const COLOR = /^#([0-9a-f]{6})$/i

/**
 * Give the uploads that a Markdown text names the addresses GitLab's own rendering gives them,
 * `https://<host>/-/project/<project id>/uploads/…`; an upload of a private project answers only with a GitLab session.
 * @param text - Markdown source of a description or a comment as GitLab stores it.
 * @param host - host of the project.
 * @param project - global id of the project the text belongs to, which {@link PROJECT_ID} accepts.
 * @returns the text with those addresses in place of the ones without host and project.
 */
export function withUploadAddresses(text: string, host: string, project: string): string {
  const uploads = `https://${host}/-/project/${project.slice(project.lastIndexOf('/') + 1)}`
  return text.replace(UPLOAD, (_, lead: string, upload: string) => `${lead}${uploads}${upload}`)
}

/**
 * Read a merge request's description and labels through one request. Upload addresses in the description become the
 * ones {@link withUploadAddresses} gives them, and `images` maps none.
 * @param api - GitLab reads.
 * @param ref - merge request.
 * @param signal - cancellation of the read.
 * @returns the description, or why GitLab did not provide it.
 * @throws when the project path or the number of `ref` is not one GitLab can hold.
 */
export async function readDescription(
  api: GitLabApi, ref: ChangeRequestRef, signal: AbortSignal,
): Promise<ChangeRequestDescription | ForgeFailure> {
  const path = checkedProject(ref)
  const read = await api.graphql(ref.repository.host, DESCRIPTION_QUERY, { path, iid: String(ref.number) }, signal)
  if (!read.ok) return read.failure
  const parsed = descriptionSchema.safeParse(read.body)
  if (!parsed.success) return { code: 'unavailable', message: 'unexpected GitLab response to the description read' }
  const { project } = parsed.data
  const merge = project?.mergeRequest
  if (project === null || merge == null) return { code: 'not-found', message: `merge request ${ref.number} was not found` }
  return {
    body: withUploadAddresses(merge.description ?? '', ref.repository.host, project.id),
    labels: merge.labels.nodes.map(label => ({ name: label.title, color: COLOR.exec(label.color)?.[1]?.toLowerCase() ?? null })),
    labelsTruncated: merge.labels.count > merge.labels.nodes.length,
    images: {},
    imagesExpireAt: null,
    createdAt: merge.createdAt,
  }
}
