---
description: "List Workspace and Session metadata through optional read-only tools, with pagination and cached titles and activity times."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-session-list

English | [中文](README.zh.md)

## Summary

Discover workspaces and sessions without resuming an agent or reading cold conversation logs. List empty workspaces, find sessions in a workspace, or list archived sessions. Results contain identifiers and lightweight metadata, with bounded page sizes. Enable these tools when callers may inspect the metadata of the whole mounted runtime.

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

Mount this optional plugin where the intended callers receive tools. It has no configuration fields and is absent from the default profiles.

### Access and composition

Granting these tools grants read access to every Workspace and Session in the mounted runtime. Tool availability is the access control; there is no per-agent Workspace ACL or implicit restriction to the caller's working directory. LiveShare's tool allowlist does not include these tools.

The plugin requires `tools`, `sessions`, `sessionQuery`, `workspaceRegistry`, and `sessionProjections`. A projection cache supplies metadata for cold sessions; without it, cold rows use the documented missing-metadata values. In a headless profile, the base bundle supplies the other dependencies; add the Workspace registry and this plugin in a profile patch:

```yaml
- insert:
    - id: workspace-registry
      name: '@deepseek-ai/dsh-workspace'
    - id: tool-session-list
      name: '@deepseek-ai/dsh-tool-session-list'
```

When the composition already mounts `workspaceRegistry`, add only the tool row. Workspace initialization follows the [registry's existing history bootstrap](../../workspace/workspace/README.md); listing calls do not create or attach sessions or change registry records.

### Listing behavior

Both tools return an array directly. The [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-session-list) defines arguments. Pagination follows filtering and ordering; each call defaults to 20 entries, accepts at most 100, and starts at offset zero. Increase the offset by the number of returned entries to continue; an empty array ends the traversal.

`list_workspace` preserves registry order and includes workspaces with no sessions. `list_session` never returns subagent sessions. It includes unarchived sessions by default, including sessions outside every Workspace when no `workspace_id` is supplied. Explicit Workspace selection uses recorded membership, not a matching working directory. Archival matches each Session's own ID.

Session order is descending `updated_at`, then ascending Session ID for ties. Activity time is the later of creation and the latest human-authored prompt; assistant activity and title changes do not advance it. Titles come from live projections or persisted projection metadata. Unavailable titles are `null`, and unavailable activity metadata falls back to creation time. Timestamps are ISO 8601 strings. Pin order and manual sidebar order do not affect the results.

With `workspace_id`, the call reads its members' headers from the Workspace registry index without persistence I/O, so its work grows with the member count. Without `workspace_id`, it first enumerates every stored and live Session header. Filtering, metadata reads, and sorting then run synchronously. The call does not promise prompt handling of new cancellation requests during this work or one snapshot across all Sessions.

### Failures

Invalid pagination and an unknown `workspace_id` fail with `ToolArgsError` (`INVALID_ARGS`); use `list_workspace` to find a registered ID. Query and storage failures fail the call. Cancellation returns no partial result. These failures leave sessions and Workspace records untouched.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

A Workspace selection reads `Workspace.getSessionHeaders()`; an unscoped call uses the existing header-only query listing. Both combine headers with projected metadata. Live rows read blankness and prompt recency through `ctx.sessionQuery.getListMetadata`, the same projection the Session API reads. The title projection remains owned by `dsh-session-title`. Cold rows read the projection cache without opening the underlying log, including on a cache miss. No Session Controller or Agent activation is required.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Tool schemas, registration, JSON result rendering, and generic tool cards |
| [`src/list.ts`](src/list.ts) | Pagination, membership selection, and live or cached metadata reads |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workspace registry](../../workspace/workspace/README.md) — recorded membership, registry order, and archival.
- [Session query](../session-query/README.md) — corpus header enumeration and the shared list metadata reader.
- [Session projection cache](../../session/session-projection-cache/README.md) — persisted metadata and cache availability.
- [Session query package map](../README.md) — adjacent retrieval capabilities.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schemas and results

#### What the model sees

The [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-session-list) owns the `list_workspace` and `list_session` schemas. Each result renders as a JSON array. The plugin adds no separate system-prompt section.

#### Token effect

Available tool schemas contribute request tokens; each invocation adds its arguments and returned metadata. The page limit bounds the number of returned entries, while title and path lengths still affect result size.

#### KV Cache effect

The schemas remain stable while tool availability is unchanged. Calls append ordinary tool call and result history without replacing prior messages; enabling or disabling the tools changes the schema prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These constraints affect consumers of the lists.

- **Cold metadata can be missing or stale** — listing never rebuilds it by reading the full log. A `null` title can mean either no title or unavailable title metadata.
- **Pagination is not a stable snapshot** — concurrent registry or Session changes can move entries between calls. Session listing reads every candidate before selecting a page, so the page size does not bound total work; an unscoped call scales with the Session count.
- **Blank sessions are listed** — a Session without a turn, such as a Workspace's unused new Session, is a regular result; its `updated_at` equals `created_at` and its title is usually `null`.
- **Unscoped listing has unit coverage only** — the recorded headless replay passes `workspace_id` on every `list_session` call, so enumeration without a Workspace runs only in unit tests.
- **Metadata access is runtime-wide** — callers needing per-agent Workspace authorization require a separately defined access policy before these tools are enabled for them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
