---
description: "Session-addressed browser file uploads with streaming intake, progress, cancellation, and staged receipts for later prompts."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-file-upload

English | [中文](README.zh.md)

## Summary

This package lets browser features store a `Blob`, exact bytes, or a `ReadableStream<Uint8Array>` for one Session and receive an opaque receipt for a later prompt. Served pages send Blob and stream bodies without aggregating their bytes on the page thread; pages whose Host runs in another execution context supply a Fetch-shaped carrier before Cordis boots. Callers can observe consumed bytes and cancel an active operation. A stream body is consumed once and transfers ownership when it crosses a Worker boundary. The standalone `?fixture` page uses the generated Remote for replayable Blob and exact-byte inputs.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the package before a consumer that injects `fileUpload`, then call `ctx.fileUpload.upload(sessionId, body, name, signal, onProgress)`. The Session identity addresses both the raw route and generated Remote fallback; callers do not assemble either request.

```yaml
- id: file-upload
  name: '@deepseek-ai/dsh-client-file-upload'
```

The package has no Cordis configuration fields. A `Blob` uses XMLHttpRequest inside a dedicated Worker so the service can report browser upload progress, including the total when the browser provides it. A `ReadableStream` transfers to that Worker and feeds Fetch incrementally; progress reports consumed bytes without a total. An `AbortSignal` terminates the dedicated Worker or reaches a page-owned carrier. Exact bytes and fixture Blob inputs use the generated Remote.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client plugin provides `ctx.fileUpload`. Its `upload()` method receives the owning Session identity, assembles the raw route request, and invokes the generated Remote fallback for replayable inputs. The provider reads the optional pre-Cordis `__DSH_FILE_UPLOAD__` hook once. Without a hook, each non-fixture raw request owns a short-lived Worker and releases it after completion, failure, or cancellation. With the hook, the service sends the body through the page-owned Fetch carrier; the Web Worker runtime transfers stream bodies through its request frame and exposes them to the Host HTTP bridge as backpressured chunks.

The Host plugin provides `ctx.fileUploads`. It owns the authenticated streaming route, encoded Remote fallback, command receipt resolver, and staged-receipt lifecycle; encoded admission, attachment-error recognition, and byte storage stay behind `ctx.attachments`. Receipt tables use the receiving Agent's Session object as their key. The Session Controller registers the resolver that can resume a cold ordinary Agent and consumes receipts during prompt admission. Prompt delivery holds each receipt binding in a disposable transaction: disposal restores the previous binding until successful delivery commits it, and queue or history observation then retires the committed receipt.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Host streaming route, attachment-service admission, and Agent-scoped receipt lifecycle |
| [`src/types.ts`](src/types.ts) | encoded request, receipt, and durable result types |
| [`src/client/contract.ts`](src/client/contract.ts) | Client upload, progress, and page-hook types |
| [`src/client/runtime.ts`](src/client/runtime.ts) | Dedicated Worker and page-owned carrier implementations |
| [`src/client/index.ts`](src/client/index.ts) | Client plugin registration and `ctx.fileUpload` declaration |

</details>

**Runtime invariant:** No companion is published. Each upload receipt belongs to one exact Session, and each request uses one selected carrier. Unsupported stream carriers fail before the body is sent.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Connection](../connection/README.md) — authenticated RPC, exact Host routes, and connection generations.
- [Session Controller](../../api/session-controller/README.md) — prompt admission that consumes staged receipts.
- [Web Worker runtime](../../experimental/webworker-runtime/README.md) — the page-to-Host Worker request tunnel.
- [Client group map](../README.md) — browser services and UI feature packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package transfers browser request bodies and contributes no model input.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits apply to the transport operation itself.

- **Uploads are not resumable** — a failed or cancelled retry starts from the first byte.
- **Stream bodies are one-shot** — transferring a `ReadableStream` locks the caller's object, so retry requires a newly created stream.
- **Stream progress has no total** — callers receive consumed-byte counts because the stream API carries no byte length.
- **The browser Worker is self-contained** — its source is emitted from a function string. Adding runtime imports requires moving it to a standalone Worker entry bundled by tsdown.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
