/**
 * Program images for tool values that reference their result images through
 * `{ type: 'image', attachment }` entries, such as admitted MCP image blocks.
 * @module
 */

import type { ImageBlock } from '@deepseek-ai/dsh-llm'
import type { PtcJsonValue } from '@deepseek-ai/dsh-ptc-runtime'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/**
 * Replace each image entry whose attachment is one of the finalized result images.
 * Entries naming another attachment, such as an image a policy removed, stay JSON.
 * @param value - Canonical tool value; it is not modified.
 * @param images - Image blocks of the finalized result content.
 * @param image - Creates the program value for one finalized reference, or returns undefined when the program cannot read it.
 * @returns The substituted value, or undefined unless every finalized image was substituted.
 */
export function substituteProgramImages(
  value: JsonValue, images: readonly ImageBlock[], image: (ref: ImageBlock['attachment']) => PtcJsonValue | undefined,
): PtcJsonValue | undefined {
  const refs = new Map(images.map(block => [String(block.attachment.attachmentId), block.attachment]))
  const substituted = new Set<string>()
  const unreadable = new Set<string>()
  const result = mapImageEntries(value, (attachmentId) => {
    const ref = refs.get(attachmentId)
    if (ref === undefined) return undefined
    const programImage = image(ref)
    if (programImage === undefined) unreadable.add(attachmentId)
    else substituted.add(attachmentId)
    return programImage
  })
  return unreadable.size === 0 && substituted.size === refs.size ? result : undefined
}

function mapImageEntries(value: JsonValue, replace: (attachmentId: string) => PtcJsonValue | undefined): PtcJsonValue {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    const items = value.map(item => mapImageEntries(item, replace))
    return items.some((item, index) => item !== value[index]) ? items : value
  }
  const attachment = value.attachment
  if (value.type === 'image' && attachment !== null && typeof attachment === 'object' && !Array.isArray(attachment)
    && typeof attachment.attachmentId === 'string') {
    const replaced = replace(attachment.attachmentId)
    if (replaced !== undefined) return replaced
  }
  const entries = Object.entries(value)
  const mapped = entries.map(([key, item]) => [key, mapImageEntries(item, replace)] as const)
  // Object.fromEntries defines own data properties, so a `__proto__` key stays an ordinary key.
  return mapped.some(([, item], index) => item !== entries[index]?.[1]) ? Object.fromEntries(mapped) : value
}
