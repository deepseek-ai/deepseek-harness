# Agent Note: Steer and follow-up image delivery

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-27-steer-followup-image-delivery.zh.md)

## Problem

Images submitted while an agent is running did not reliably reach the model context or retain their intended browser placement (#3186), for three addressed reasons and one deferred agent-loop race.

First, a steer or follow-up spliced into a live driver latched no wake: the live driver was expected to claim it, but a turn that finished or failed between the splice and the claim exited without re-checking, stranding the accepted message until an unrelated waking send. Image admission widens this window because the Host awaits attachment normalization before `agent.steer()`/`agent.followup()` runs.

Second, continuable-subagent follow-ups rejected images in the Client (`SUBAGENT_IMAGE_UNSUPPORTED`) before any RPC, and stripped image parts from the text-only call. The Host route had no admission at all, and its wire content was `ContentBlock[]`, so lifting the Client rejection alone would have let a browser cite any `attachmentId` it never uploaded.

Third, the browser queue projection reduced a queued image to the text `[image]` even though the durable reference was already present and readable through the session attachment authorization.

Fourth, every local submission echo rendered at the Chat flow tail while the browser serialized image bytes. A direct steer therefore appeared as an ordinary chat message during the pre-admission wait, then moved to the pending-steering position when the Host queue snapshot arrived. Busy Queue sends had the same transition into QueueDock.

## Decision

**Host-side subagent image admission.** `SubagentPromptRequest.content` is now upload-shaped `PromptContentPart[]` (updating the wire contract in [Web subagent conversations](../feature/2026-07-27-web-subagent-conversations.md)). `dsh-attachment` owns the shared upload vocabulary and the `admitPromptContent()` conversion used by both the Session prompt endpoint and `SubagentRuntime.prompt`; Session Controller's shared request types retain a structurally identical Client wire declaration so the generated Client Cordis catalog contains the complete prompt-part fields, with a compile-time equality test preventing drift. The subagent route admits and persists image batches through `ctx.attachments` before `followup()`, and the continuation manager refuses delivery inside the per-child lock when the child's `agent.options` route resolves to a model without image input (`MODEL_DOES_NOT_SUPPORT_IMAGES`, surfaced as `subagent/attachment-invalid` with the same reason vocabulary as the Session route). A child without a fixed options route, or a deployment without the LLM registry, delivers and relies on the LLM layer's text-only projection. The Client forwards image parts unchanged and the `SUBAGENT_IMAGE_UNSUPPORTED` copy is gone.

**Queue presentation.** The queue mirror's text preview excludes image blocks, and the queue dock renders each durable image part as a thumbnail resolved through `ctx.uiConversation.imageUrl` — the same session-authorized read the transcript uses. Editing queued image messages stays refused (#3072).

**Stable optimistic placement.** Session derives a `PendingSubmission` placement synchronously from its running state and the requested delivery mode: `transcript` for an idle send, `queued` for a busy Queue send, and `steering` for a busy Steer send. The captured placement remains stable while serialization is in flight. Chat renders transcript and steering echoes on their respective surfaces, while QueueDock renders queued echoes with browser-owned image previews. The existing `rpcId` correlation suppresses the local echo in the same render that introduces the Host queue occurrence or durable user node. If the turn closes while images serialize and the Host places a requested steer in the next-turn queue, the later move from steering to QueueDock reflects the authoritative delivery decision.

## Alternatives considered

**Keep the wire content `ContentBlock[]` and admit refs on the Host.** Rejected: a reference-shaped wire lets a Client fabricate `attachmentId` citations; an upload-shaped wire makes Host admission the only way an attachment reference can exist in a child message.

**Check child image capability in `SubagentRuntime.prompt`.** Rejected: the route may address a cold child whose agent does not exist yet; the continuation manager sees the live or freshly materialized agent in both arms and inside the per-child delivery lock, so the check cannot race a concurrent delivery.

## Testing

Host tests cover `mode: 'steer'` image admission; subagent control tests cover ordered admission, batch refusal, non-canonical base64, and the capability refusal mapping; continuation tests cover refusal without a partial message, capable delivery, and the routeless deferral. Client tests cover unstripped forwarding, the catalog-visible upload declaration, queue thumbnails (load, failure placeholder, unmount), the image-free preview, Session-owned placement derivation and capture, local steering presentation, queued echo presentation, and `rpcId` handoff on both surfaces.

## Deferred

A steer or follow-up inserted after a running driver's final inbox check and before it becomes idle can remain pending until another waking send starts the driver. Image admission performs asynchronous work before insertion, so image submissions can reach this timing window more often. This change leaves the agent-loop lifecycle unchanged; the wake race requires a separate lifecycle change and review.

## Consequences

Slow image serialization leaves optimistic messages on their selected transcript, QueueDock, or pending-steering surface until the Host handoff. The subagent package depends on `dsh-attachment` and reads `ctx.llm` optionally. Images persisted by a batch whose delivery is later refused stay as unreachable content-addressed objects under the existing retention rules. Queue thumbnails add one authorized attachment read per queued image, shared with the transcript cache. The deferred closing-turn race can leave an accepted message pending as described above.
