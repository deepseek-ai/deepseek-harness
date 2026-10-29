---
kind: upgrade-guide
description: "SDK run recognizes native commands and returns RunResult after its input completes."
---

# SDK run accepts native commands

English | [中文](guide.zh.md)

## Change

Python and TypeScript `run()` accept strings and content-block arrays through the existing entry and always return `RunResult`. Supported native commands are recognized by their definition identities and effective registered names. English and Chinese aliases follow renamed definitions; unrelated exact-name replacements remain ordinary input. See the [supported command rules](../../../../packages/sdk/server/README.md#command-input).

`final_response` / `finalResponse` contains the final assistant text, or an empty string when the activity emits none. State-only commands return the native handler's result text. `finish_reason` / `finishReason` reports the terminal outcome. Every result retains its Session id, root events and Session-tree notifications. State-only commands finish without waiting for a model turn; `/plan <task>` waits for its admitted activity, including native review and any approved continuation. Goal creation and resume wait across automatic rounds until the goal stops and its closing activity ends. Low-level strict command calls still return `CommandExecution` after the native handler settles.

Content-block arrays no longer bypass native routing. A recognized command requires one text block and optional encoded raster images; native handlers enforce image admission. `/plan off` with an image fails without changing plan state. Empty arrays and blank-only input reject before Session creation; image-only input remains accepted. Identity rejection by the strict endpoint retains its initialized Session without executing a handler or submitting a prompt.

## Migration

1. Keep the existing `result.final_response` / `result.finalResponse` access for prompts and commands. Inspect `finish_reason` / `finishReason` for failure; command ids and native outcomes remain in `command/run` and `command/done` events. Save the result's Session id to continue or restore it.
2. Keep the user-question callback alive for plan review. State-changing command failures appear in `RunResult`; routing, malformed protocol data and transport failures still raise or reject. A timeout or observer failure does not roll back runtime work.
3. For literal queued input, use Python `client.session_prompt(session_id, blocks)` or TypeScript `client.prompt(sessionId, blocks)`, and manage its subsequent activity. Runtime skill recognition still applies.
4. Custom `session/query` clients send `{ sessionId, contentBlocks }`. Command responses acknowledge the native handler; the matching `session.query.completed` notification carries the final input outcome. Preserve notification order and subscribe before sending.
5. Filter empty input before calling `run()`. Use an image-capable model and the existing `run([text_block, image_block])` form for images. Python malformed native command responses raise `SdkProtocolError`, preserving their validation cause; generic caller-selected response models retain their validation behavior.
