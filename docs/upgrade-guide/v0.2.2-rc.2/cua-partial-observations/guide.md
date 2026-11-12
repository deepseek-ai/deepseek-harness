---
kind: upgrade-guide
description: "macOS CUA returns marked partial AX observations and distinguishes observation failures from stale input snapshots."
---
# macOS CUA isolates unavailable AX branches

English | [中文](guide.zh.md)

## Change

macOS `getState` previously rejected an entire AX read with `STALE_SNAPSHOT` when one traversed element became invalid. It now returns readable nodes, marks each unavailable branch in `tree`, and sets `incomplete: true`. Markers have no element IDs; their contents are unknown. `truncated` still describes traversal limits independently. Successful complete native observations include `incomplete: false`; the shared provider schema permits omission by other providers.

An invalid AX element during observation setup now returns `AX_OBSERVATION_UNAVAILABLE`. An AX `cannotComplete` failure during observation returns `AX_COMMUNICATION_FAILED`. Permission, application/window identity, cancellation and other errors still reject the read. `STALE_SNAPSHOT` remains the error for expired or mismatched snapshots used by input operations.

## Migration

Update raw-tool consumers to preserve `incomplete` and display the branch markers. Only use element IDs returned by the latest successful tree. Use a window screenshot to inspect unavailable contents; an incomplete tree does not establish that a control is absent.

Handle the two observation error codes separately from stale input snapshots. A failed refresh still invalidates the previous snapshot for its scope. Read fresh state or use a screenshot without automatically repeating preceding input. Confirm that a local invalid element returns marked partial state while communication and permission failures remain errors.
