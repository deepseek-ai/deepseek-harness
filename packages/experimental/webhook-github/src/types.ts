/** GitHub event values projected after signature verification. */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Signed GitHub JSON object. Event-specific field validation belongs to each rule. */
export type GitHubJsonObject = { readonly [key: string]: JsonValue }

/** Provider event supplied to `WebhookRule<'github'>`. */
export interface GitHubWebhookEvent {
  /** Raw `X-GitHub-Event` name such as `pull_request`. */
  readonly name: string
  /** Signed JSON object exactly as parsed from the request body. */
  readonly payload: GitHubJsonObject
}

declare module '@deepseek-ai/dsh-webhook' {
  interface WebhookEventMap {
    github: GitHubWebhookEvent
  }
}

export type { EmitterWebhookEvent, EmitterWebhookEventName } from '@octokit/webhooks'
