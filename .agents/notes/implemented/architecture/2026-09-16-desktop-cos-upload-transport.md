# Agent Note: Upload Desktop releases through the Tencent COS SDK

Status: implemented

English | [中文](2026-09-16-desktop-cos-upload-transport.zh.md)

## Problem

Release objects were uploaded with the AWS S3 client pointed at the Tencent COS endpoint. That client's default checksum configuration can send a streamed request trailer under `Content-Encoding: aws-chunked`, a marker S3 removes before storing but the compatibility path can retain as object metadata. A user-visible application download failed with an HTTP/2 `RST_STREAM` immediately after response headers while an adjacent download on the same connection completed, and objects reported to carry the marker failed segmented downloads. Neither observation identifies an exclusive cause, but the upload transport is the part this repository owns, and a CDN serving metadata no origin request produced is a defect worth removing before chasing it further.

## Decision

[desktop-cos.ts](../../../../apps/desktop/scripts/desktop-cos.ts) builds every Desktop COS client from the official `cos-nodejs-sdk-v5` package: HTTPS, no keep-alive, no redirect following, no backup-host switching, no clock-offset correction, and a 900-second inactivity timeout. [upload-target.ts](../../../../apps/desktop/scripts/upload-target.ts) and [installed-update-cos.ts](../../../../apps/desktop/scripts/installed-update-cos.ts) obtain their client from that factory, and `@aws-sdk/client-s3` is no longer a Desktop dependency.

Every uploaded object — binary, blockmap, and YAML feed, including the small string manifests — travels as one `putObject` whose body is a stream carrying an explicit `ContentLength` and a precomputed `Content-MD5`. The stream is what makes the write unrepeatable: the SDK repeats a request only while the body lacks `pipe`, so a streamed PUT is attempted once and neither uploader adds a retry of its own. The SDK also injects an empty `Cache-Control` header when the caller names none; the factory removes that header so the release uploader still leaves cache policy to deployment infrastructure.

The qualification transport keeps the same store interface and namespace check as before. It reads objects through `getObject` with a `Writable` output that hashes received bytes, so an object is never held in memory, and a confirmed `NoSuchKey` is the only absence result; every other status, and a transfer that ends before its declared length, fails the operation.

## Testing

[cos-loopback.ts](../../../../apps/desktop/tests/cos-loopback.ts) redirects a real SDK instance's `before-send` URL to a per-test loopback origin that records the received bytes, so the transport's serialization — not a mock of it — is what the tests observe. [desktop-upload-run.spec.ts](../../../../apps/desktop/tests/desktop-upload-run.spec.ts) and [installed-update-cos.spec.ts](../../../../apps/desktop/tests/installed-update-cos.spec.ts) assert exact body bytes, `Content-Length`, `Content-MD5`, the absence of transfer and content encodings, the signed `x-cos-forbid-overwrite` header, one request per object on an HTTP 500 and on a dropped connection, read 404/403/truncation handling, and that retained records exclude credentials and raw server messages.

[cos-operation.spec.ts](../../../../apps/desktop/tests/cos-operation.spec.ts) verifies total deadlines across retries, active response streams, cancellation of unconfirmed PUTs, and closure without interfering with another operation. Virtual deadline timers are combined with real socket and stream observations.

## Alternatives considered

**Keep the S3 client with `requestChecksumCalculation: WHEN_REQUIRED` on both paths.** The qualification transport already used that setting, and it suppresses the trailer. It still writes through a compatibility layer for a product whose vendor ships a supported client, and the release path would depend on a configuration staying correct rather than on an encoding never being produced. The official SDK removes the layer instead of tuning it.

**Send a buffer body for the small YAML manifests.** A buffer is cheaper for a few hundred bytes and needs no stream handling. It also re-enables the SDK's fixed four-attempt retry, so an uncertain feed write could silently repeat a mutable object. Uniform streamed PUTs keep one write path with one guarantee.

**Use the SDK's `uploadFile` queue or multipart upload.** Those paths parallelize large objects and add progress reporting. They also split one object into parts with per-part retries and upload state, widening the repeat surface for an artifact that must be written exactly once. The release uploader sends one request per object.

**Replace only the release uploader and leave the qualification transport on S3.** The qualification transport writes to the same bucket family, and leaving it behind would keep the compatibility path alive for the objects most likely to be compared against production behavior.

## Consequences

Object writes cannot repeat, which is the property the incident needed, and the transport no longer depends on S3-compatibility behavior. In exchange, each object is one request: a large installer is not parallelized and has no progress reporting, matching the single-request behavior it replaces. Qualification version queries share a 30-second total deadline across all SDK attempts; object reads and PUTs have a 15-minute total deadline. Each operation owns its client and abort signal. [cos-operation.ts](../../../../apps/desktop/scripts/cos-operation.ts) passes that signal to native HTTP requests through the SDK transport and waits for their close events before returning, including on timeout. Continuous response data does not extend the deadline, and an expired signal prevents later retries from opening connections. The release uploader retains its separate inactivity timeout.

The SDK's dependency tree is a fork of the retired `request` package, pulling in older `http-signature`, `tough-cookie`, and `form-data` releases; the lockfile supply-chain check accepts it, and the alternative was hand-writing COS request signing.

Existing objects that already carry the retained encoding marker, and their cached copies, are unaffected by this change. Removing or re-uploading them, and any CDN cache purge, remain separate operator actions; this note records no cloud operation.

The release decision that an uncertain write must stay one inspectable attempt lives in the [packaging and updates decision](2026-08-25-electron-desktop-packaging-and-updates.md); this note changes the transport that implements it.
