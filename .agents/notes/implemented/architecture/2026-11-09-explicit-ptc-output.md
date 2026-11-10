# Agent Note: Explicit text and image output in PTC

Status: implemented

English | [中文](2026-11-09-explicit-ptc-output.zh.md)

## Problem

PTC lets a program acquire and filter intermediate tool results before choosing what the model sees. A final expression or return value can expose incidental data, while automatically attaching every acquired image defeats that selection. Separate screenshot bytes and image-output callbacks also make programs convert images before comparing or displaying them.

## Decision

TypeScript `run_code` programs select text, objects and images through top-level `inspect(...values)`. Arguments are rendered independently: strings appear directly, and other values use Node's object formatting without depth, array-length or string-length preview limits. Inspection displays undefined properties, Error objects and circular references; requiring lossless JSON for display would interrupt subsequent work after tools have already executed. Images can occur inside arrays or objects. The runtime Image's custom inspection hook collects images reached by Node's formatter; each formatting call owns its collector. One output sequence preserves the relationship between explanatory text and selected images.

The tool executor requests `discardCompletion: true`, so completion values are discarded before JSON validation and serialization. This is a consumer choice: direct runtime and workflow consumers retain completion values when their protocols require them. The [PTC foundation](../feature/2026-06-15-ptc.md) owns dispatch and settlement. The [typed-return decision](../feature/2026-07-20-ptc-typed-tool-returns.md) continues to own ordinary JSON binding values, failures and output accounting; this note owns TypeScript output selection and image projection.

The Node environment supplies `inspect` alongside the complete native console. Native console methods remain available to programs and imported libraries, and their stdout and stderr writes share the captured output sequence. Model instructions direct programs to select output through `inspect`.

`read_image` and CUA screenshot bindings expose stored `Image` values. Readonly `attachmentId`, `path`, `width` and `height` identify the stored image and its readable execution-world file. The dimensions describe that file's pixels, including the image used for CUA coordinate mapping. The [CUA object API](2026-09-17-experimental-cua-object-api.md) returns the program Image directly and routes text observations through its caller's callback.

The host carries the attachment reference with the program-readable path. The runtime transports image metadata and keeps the attachment reference behind a process-owned image ID. Inspection resolves that ID directly to the registered reference. Image identity is established by the runtime; matching object properties alone do not grant access to an image output. Retained program Images follow their owning process's lifetime.

Nested tool dispatches retain their complete rendered content in the Session log. Successful outer `run_code` results interleave inspected images with text in emission order, where model history and UI rendering use the same durable attachment references. Successful outer-result replacement remains authoritative over the selected output.

## Alternatives considered

**Display the completion value alongside printed output.** The last expression or return then controls context admission as well as program control flow. Discarding it before validation lets a program finish with an arbitrary internal value while explicitly selecting a smaller visible result.

**Automatically forward every acquired image.** Acquisition then implies model-context cost, even when the program needs several screenshots to select one. Explicit inspection gives text and images the same selection rule.

**Keep a CUA byte-returning facade and image sink.** This maintains a separate screenshot representation and a second image-emission path. Returning the runtime's Image lets file reads and screenshots share inspection and preserves the stored attachment reference through display.

**Discover images with a separate object traversal.** A separate traversal must duplicate Node's handling of collections, symbols and custom formatters and can emit images absent from the text representation. The Image hook ties collection to Node's formatting.

**Bounded object previews.** Item and string preview limits can omit file contents that a program explicitly selected. Removing those limits keeps selected contents complete within the shared output budget.

**Restrict console availability.** Missing bindings and incomplete replacements can break program code and imported libraries. The native console preserves Node methods while prompt guidance directs output selection through `inspect`.

## Consequences

Programs explicitly choose the output needed for the next model request, including image comparisons and selected nested results. The [upgrade guide](../../../../docs/upgrade-guide/v0.2.2-rc.1/ptc-inspect-output/guide.md) owns caller migration. Acquiring an image still performs storage and processing work; selection controls its presentation to the model.

The runtime owns process-local image identity and output ordering; the tool executor owns attachment projection and durable result content. Text and image-reference metadata share the outer output budget. Runtime teardown releases retained image identities, while stored attachments follow the attachment store's lifetime.
