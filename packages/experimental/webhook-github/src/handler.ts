/** GitHub HTTP authentication, parsing, and fire-and-forget dispatch. */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Webhooks } from '@octokit/webhooks'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import {
  WebhookDeliveryId,
  WebhookSourceId,
  type VerifiedWebhookDelivery,
} from '@deepseek-ai/dsh-webhook'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { readBoundedUtf8Body, WebhookHttpError } from './body.ts'
import type { GitHubJsonObject } from './types.ts'

/** Handler values validated once at plugin load. */
export interface GitHubWebhookHandlerConfig {
  readonly source: string
  readonly secretEnv: CredentialRef
  readonly maxBodyBytes: number
}

/** Require one unambiguous non-empty request header. */
function requiredHeader(request: IncomingMessage, name: string): string {
  const values = request.headersDistinct[name]
  const value = values?.[0]
  if (values?.length !== 1 || value === undefined || value.trim() === '') {
    throw new WebhookHttpError(400, `missing ${name} header`)
  }
  return value
}

/** Whether Content-Type names JSON with at most one UTF-8 charset parameter. */
function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) return false
  const parts = value.split(';').map(part => part.trim())
  const [mediaType, parameter, ...extra] = parts
  if (mediaType?.toLowerCase() !== 'application/json') return false
  if (parameter === undefined) return true
  return extra.length === 0 && /^charset=(?:utf-8|"utf-8")$/i.test(parameter)
}

/** Send one empty or plain-text response exactly once. */
function respond(response: ServerResponse, status: number, message?: string): void {
  if (message === undefined) {
    response.writeHead(status)
    response.end()
    return
  }
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  response.end(message)
}

/** Convert a parsed value into the adapter's generic signed-object guarantee. */
function parsePayload(body: string): GitHubJsonObject {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    // JSON.parse is the only statement in the try; no other failure is normalized.
    throw new WebhookHttpError(400, 'request body is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WebhookHttpError(400, 'GitHub webhook payload must be a JSON object')
  }
  const snapshot = snapshotJsonValue(parsed)
  if (snapshot === undefined) throw new WebhookHttpError(400, 'GitHub webhook payload is not lossless JSON')
  return snapshot as GitHubJsonObject
}

/**
 * Create one exact-route GitHub handler.
 * @param ctx - adapter context carrying credentials and webhook runtime.
 * @param config - validated source, credential reference, and body ceiling.
 * @returns an HTTP handler that answers after in-memory dispatch, never rule settlement.
 */
export function createGitHubWebhookHandler(
  ctx: Context,
  config: GitHubWebhookHandlerConfig,
): WebRoute['handler'] {
  return async (request, response) => {
    try {
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST')
        throw new WebhookHttpError(405, 'method not allowed')
      }
      if (!isJsonContentType(request.headers['content-type'])) {
        throw new WebhookHttpError(415, 'content type must be application/json')
      }
      const body = await readBoundedUtf8Body(request, config.maxBodyBytes)
      const signature = requiredHeader(request, 'x-hub-signature-256')
      const deliveryId = requiredHeader(request, 'x-github-delivery')
      const eventName = requiredHeader(request, 'x-github-event')
      const credential = await ctx.credentials.resolve(config.secretEnv)
      if (credential === undefined || credential.value === '') {
        throw new WebhookHttpError(503, 'GitHub webhook secret is unavailable')
      }
      let verified = false
      try {
        verified = await new Webhooks({ secret: credential.value }).verify(body, signature)
      } catch {
        // Octokit verification errors carry no response detail safe or useful to the sender.
      }
      if (!verified) throw new WebhookHttpError(401, 'invalid webhook signature')
      const payload = parsePayload(body)
      const delivery: VerifiedWebhookDelivery<'github'> = {
        kind: 'github',
        source: WebhookSourceId(config.source),
        deliveryId: WebhookDeliveryId(deliveryId),
        event: { name: eventName, payload },
        receivedAt: Date.now(),
      }
      try {
        ctx.webhookRuntime.dispatch(delivery)
      } catch {
        ctx.logger.warn('webhook-github: dispatch unavailable')
        throw new WebhookHttpError(503, 'webhook runtime is unavailable')
      }
      respond(response, 202)
    } catch (error: unknown) {
      if (error instanceof WebhookHttpError) {
        respond(response, error.status, error.message)
        return
      }
      ctx.logger.warn('webhook-github: request failed')
      respond(response, 503, 'webhook ingress is unavailable')
    }
  }
}
