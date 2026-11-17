/**
 * JSON payload helpers shared by the owner's HTTP adapters and Relay reads.
 * @module @deepseek-ai/dsh-experimental-liveshare/src/host/wire-json
 */

/**
 * Answer one JSON payload with the content type the owner routes use.
 * @param value - Payload to serialize.
 * @param status - HTTP status to answer with.
 * @returns The response carrying the serialized payload.
 */
export function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/**
 * Whether one value is a plain record, the only object shape wire payloads may take.
 * @param value - Value read from a wire payload.
 * @returns Whether the value is a non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read one JSON request body.
 * @param request - Owner request that may carry JSON.
 * @returns Parsed body, or undefined when the body is absent or malformed.
 */
export async function readJsonBody(request: Request): Promise<unknown> {
  return await request.json().catch(() => undefined)
}
