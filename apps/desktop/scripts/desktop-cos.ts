/** Shared Tencent COS client construction for Desktop update objects. */

import COS from 'cos-nodejs-sdk-v5'

/** Region of every Desktop update bucket, present or future deployment. */
export const DESKTOP_COS_REGION = 'ap-beijing'

/** Request-level inactivity deadline for COS transfers, in milliseconds. */
const TRANSFER_TIMEOUT_MS = 900_000

/** Credentials for one COS client; values are never written to retained records. */
export interface DesktopCosCredentials {
  readonly secretId: string
  readonly secretKey: string
}

/** Request options the SDK exposes to `before-send` listeners. */
interface CosRequestOptions {
  headers: Record<string, unknown>
}

/**
 * Create a COS client whose writes cannot be repeated by the SDK.
 *
 * The SDK retries a failed request only while the request body is not a stream, so every caller
 * supplies a stream with an explicit `ContentLength` and a precomputed `Content-MD5`. Host
 * switching, redirect following, and clock-offset correction stay off so an ambiguous write is
 * never sent to another endpoint. The SDK also injects an empty `Cache-Control` header when the
 * caller names none; that header is removed here so uploading leaves cache policy to deployment
 * infrastructure.
 * @param credentials SecretId and SecretKey for the selected deployment.
 * @param timeoutMs Request-level inactivity deadline; a caller that must not wait out a transfer passes its own.
 * @returns A COS client that sends HTTPS requests to the region named by each call.
 */
export function createDesktopCos(credentials: DesktopCosCredentials, timeoutMs: number = TRANSFER_TIMEOUT_MS): COS {
  const cos = new COS({
    SecretId: credentials.secretId,
    SecretKey: credentials.secretKey,
    Protocol: 'https:',
    KeepAlive: false,
    FollowRedirect: false,
    AutoSwitchHost: false,
    CorrectClockSkew: false,
    ChunkRetryTimes: 0,
    Timeout: timeoutMs,
    UploadCheckContentMd5: false,
  })
  cos.on('before-send', (options: CosRequestOptions) => {
    for (const name of Object.keys(options.headers)) {
      if (name.toLowerCase() === 'cache-control' && options.headers[name] === '') delete options.headers[name]
    }
  })
  return cos
}
