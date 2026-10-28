# Agent Note: SDK native user questions

Status: implemented

English | [中文](2026-10-19-sdk-native-user-questions.zh.md)

## Problem

The SDK can expose the shared `ask_user_question` tool without a Web GUI, but an out-of-process host cannot answer the native user-questions event through the SDK. Publishing the tool alone leaves calls without an answerer. The SDK must carry the interaction while the application chooses its user interface or simulated-user policy.

## Decision

The TypeScript and Python clients accept a question callback and advertise it during initialization. The SDK server adapts the existing user-questions seam to a bidirectional RPC only for its exact owned root Agents. Clients without the capability keep native in-process answerers. Tool definitions and the service's live-root and delegation checks remain shared with the desktop composition.

Question identity is independent of the JSON-RPC envelope so cancellation can identify outstanding host work. The runtime validates a complete answer batch, aborts pending requests when the tool or server stops, and ignores late responses. The host owns answer collection; the SDK neither chooses answers nor treats missing input as approval. The [protocol reference](../../../../packages/sdk/protocol/README.md#native-user-questions) owns wire details.

## Consequences

A GUI and runtime patch module are unnecessary. A host can use the same interface for a terminal, browser, or simulated user. The Python SDK keeps its synchronous API by running callbacks outside the reader thread; callbacks must observe cancellation and release their own resources. Late callbacks cannot publish into a later runtime process. Question waits are process-local; completed tool results retain ordinary Session persistence.

A Web Session controller is not an interaction provider for the SDK. Reminder restoration uses the SDK's own Session owner and initialized model options; it does not claim a second write handle through a GUI controller.

## Alternatives considered

Requiring a Web GUI or mounting its controller couples headless execution to another lifecycle owner. Asking each host to inject a runtime patch repeats the transport bridge outside the maintained SDK. Removing the shared question tool would reduce the model's available capabilities rather than supply its missing answer path.

## Verification

Server tests cover ownership, native fallback, answer validation, cancellation, and transport failure. Client tests cover concurrent bidirectional transport and cancellation, including callback advertisement and answer delivery with either explicit startup or a direct `initialize()` call. Initialization starts the runtime before constructing the handshake capabilities so both entry paths advertise the installed callback. Python tests also cover reentrant requests and a late callback after process replacement. Real shipped-profile tests drive the built-in question in standard and PTC modes and close a runtime while the host is answering. The [server tests](../../../../packages/sdk/server/tests/user-questions.spec.ts), [client tests](../../../../packages/sdk/client/tests/user-questions.spec.ts), [Python tests](../../../../python/sdk/tests/test_user_questions.py), and [profile tests](../../../../apps/cli/tests/profiles/sdk/user-questions.e2e.ts) retain this evidence.
