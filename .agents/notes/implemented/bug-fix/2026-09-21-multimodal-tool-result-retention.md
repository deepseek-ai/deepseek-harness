# Agent Note: Multimodal tool-result retention

Status: implemented

English | [中文](2026-09-21-multimodal-tool-result-retention.zh.md)

## Problem

MCP prepares durable images asynchronously while its pure renderer emits text placeholders. Installing prepared content after post-execute policy makes text retention invalidate image replacement. A byte-only limit also cannot compare text with visual input costs.

## Decision

`ToolDefinition.projectContent` installs execution-prepared content before post-execute policy. The final callback retains its separate role for terminal and job limits. Policy blocks and replacements remain authoritative.

The spill policy prices ordered text/image blocks in estimated tokens, reusing the text estimator and the active route image calculator, including descriptor text. It reserves omission notices, divides remaining tokens between contiguous ends, and omits the middle. Text can split between code points; images remain indivisible at their original positions.

The complete spill file contains accepted text and readable attachment paths in order. Attachments own image bytes. Missing image pricing or a readable recovery path preserves the original result with a diagnostic. PTC program values remain complete; forwarding and logs retain a recovery notice even when every image is omitted.

The [spill storage decision](../architecture/2026-07-08-tool-output-spill-files.md) still owns backend separation and secure local files. The [MCP client decision](../feature/2026-07-07-mcp-client-plugin.md) still owns canonical values and image admission.

## Alternatives considered

**Restore images after policy edits.** This can resurrect blocked images or discarded text. Preparing content before policy lets transformations inspect the actual images.

**Keep images outside the budget or charge a fixed maximum.** Images must share the result budget with text. The existing route calculator already prices projected dimensions and descriptor text, so it owns that cost.

**Embed image bytes in spill text.** Base64 inflates the artifact and duplicates attachment storage. Readable attachment paths preserve retrieval and ordering without copying bytes.

## Consequences

The shipped result budget is 12,500 estimated tokens, replacing the former 50,000-byte setting. Text estimation remains heuristic; provider usage is authoritative. Unused space at an image boundary stays unused to preserve contiguous ends. Other block types pass through.
