# Agent Note: Web delivers explicit file snapshots

Status: implemented
Archived: 2026-09-08

English | [中文](2026-09-08-web-explicit-file-delivery.zh.md)

## Problem

Workspace links read live paths, so edits or deletion can invalidate a final deliverable. Files created through shell commands also lack first-party editor mutation records. Delivery needs an explicit operation and saved bytes without expanding Session ZIP exports.

## Decision

The [present tool](../../../../packages/fs/tool-present/README.md) owns execution, immutable snapshots, delivery types, and the durable event. The [deliverables plugin](../../../../packages/client/ui-deliverables/README.md) owns authenticated snapshot actions and browser rendering, with type-only imports from the tool’s `./types` entry. The `standard`, `ptc`, and `cordis` presets mount the tool package; `minimal` retains its two-tool training configuration. The existing attachment service saves immutable bytes; successful final `tools/result` notifications append `deliverables/presented` to the calling Session. Native and nested calls use the same recorder. A later enclosing program failure does not undo a completed nested delivery. Blocked tool results publish none.

Download and native-open requests authorize a reference by the viewed Session, event sequence, and file index. The event stores no Session ID, so forked history uses the child's own log. The existing produced-file row keeps its names and behavior. Session ZIP retains delivery events but does not collect their attachment bytes.

Card and closing-mention gestures open a verified private copy with the existing native-command utility. A POST expresses the desktop side effect; GET remains a byte read. Each gesture receives a new copy so application edits cannot corrupt the immutable attachment or alter later opens. Successful copies survive until plugin disposal for applications that read lazily; failed copies are removed immediately, and disposal awaits cancelled work before cleanup.

## Alternatives considered

**A Host tool subpath in the UI package** couples preset installation to browser packaging and requires extra published entries. An ordinary tool package preserves shared filesystem and tool error classes through the repository’s peer dependency rules.

**Live workspace links** cannot preserve a delivered version after edits or deletion. Opening the attachment store’s own path instead would expose immutable saved bytes to application writes.

**Generic artifact fields throughout tools, dispatch, and Session** would broaden unrelated APIs for one Web feature. A plugin-owned event uses existing extension points and avoids parent-result forwarding.

**Tool text as the durable index** is unreliable because post-processing and spill can replace ordinary or nested result text. Each plugin instance retains its own completed snapshots by execution identity and publishes them only on a successful final result. Same-name scoped replacements cannot create or duplicate another instance’s delivery records.

**Descriptor-bound filesystem extensions** would change multiple capability providers. This feature uses existing bounded reads with containment and before/after version checks. Those checks reject ordinary concurrent changes but do not guarantee atomic confinement against swap-and-restore; stronger filesystem guarantees belong to the filesystem provider.

## Consequences

The implementation adds no artifact service or attachment format. Unreferenced snapshots can remain after partial failure; attachment retention remains service-owned. A downstream build must understand the new required event to read the log. The generated Session event inventory records that requirement without changing released format generations.

The delivery event is required-on-read because it is the authorization index for saved bytes, not only display metadata. Skipping it would allow an older reader to reconstruct or fork a Session without its completed deliveries. Unsupported readers refuse that loss instead of silently dropping the references.

Focused tests cover snapshot bytes, invalid inputs, blocked results, HTTP integrity, native-open copy isolation, retry and disposal, turn isolation, and fork-addressed actions. The recorded Web scenario covers nested completion followed by an enclosing failure, source deletion, reload, native-open gestures without browser downloads, and ZIP exclusion.
