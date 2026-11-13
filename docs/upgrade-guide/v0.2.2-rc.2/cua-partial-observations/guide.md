---
kind: upgrade-guide
description: "macOS CUA returns marked partial AX observations and distinguishes observation failures from stale input snapshots."
---
# macOS CUA isolates unavailable AX branches

English | [中文](guide.zh.md)

## Change

macOS `getState` previously rejected an entire AX read with `STALE_SNAPSHOT` when one traversed element became invalid. It now returns readable nodes, marks each unavailable branch in `tree` with `[One child could not be read.]`, and sets `hasUnreadableElements: true`. Markers have no element IDs; their contents are unknown. `truncated` still describes traversal limits independently. macOS omits `hasUnreadableElements` when no unreadable node or child-list entry was encountered; other providers may also omit the field.

Invalid top-level roots no longer prevent reading healthy windows. Application-wide observations mark those roots unreadable, and a focus lookup that encounters an invalid root yields a null `focusedWindowId`. An invalid AX object that prevents resolving the requested observation scope returns `AX_OBSERVATION_UNAVAILABLE`. Encountering such an object while discovering an unresolved window or sheet rejects the read instead of publishing an empty complete snapshot. An AX `cannotComplete` failure during observation previously returned `NATIVE_ERROR`; it now also returns `AX_OBSERVATION_UNAVAILABLE`. Both failures retain the failing AX operation and native error code in the message. Permission, application/window identity, cancellation and other errors still reject the read. `STALE_SNAPSHOT` remains the error for expired or mismatched snapshots used by input operations.

## Migration

Update raw-tool consumers to preserve `hasUnreadableElements` and display the branch markers. Only use element IDs returned by the latest successful tree. Use a window screenshot to inspect unavailable contents; an incomplete tree does not establish that a control is absent.

Handle `AX_OBSERVATION_UNAVAILABLE` separately from stale input snapshots. A failed refresh still invalidates the previous snapshot for its scope. Read fresh state or use a screenshot without automatically repeating preceding input. Confirm that a local invalid element returns marked partial state while communication and permission failures remain errors.
