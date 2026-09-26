/** Source locators and converter-owned identities for shared PDF reuse. */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/** Authorized execution scope and canonical source path, encoded by the consumer. */
export type OfficeSourceKey = Branded<'OfficeSourceKey'>
/**
 * Label an authorized source locator for pre-read deduplication.
 * @param key - unambiguous encoding of authorization scope, execution world, and canonical path.
 * @returns branded source locator; source authorization remains the caller's responsibility.
 */
export function OfficeSourceKey(key: string): OfficeSourceKey { return brandString<OfficeSourceKey>(key) }

/** One provider lifetime, including its engine, rendering settings, and font configuration. */
export type OfficeToPdfGeneration = Branded<'OfficeToPdfGeneration'>
/**
 * Label a provider lifetime.
 * @param value - unique generation created by the provider.
 * @returns branded converter generation.
 */
export function OfficeToPdfGeneration(value: string): OfficeToPdfGeneration {
  return brandString<OfficeToPdfGeneration>(value)
}

/** Provider generation and source-content digest; consumers must not parse it. */
export type OfficeToPdfKey = Branded<'OfficeToPdfKey'>
/**
 * Label a converter-owned content identity.
 * @param value - generation and content identity created by the provider.
 * @returns branded conversion identity.
 */
export function OfficeToPdfKey(value: string): OfficeToPdfKey { return brandString<OfficeToPdfKey>(value) }
