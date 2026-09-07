# Agent Note: Workspace-write defaults for shipped surfaces

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-31-workspace-write-surface-default.zh.md)

## Problem

The shipped terminal and browser surfaces exposed the same coding tools under different unconfined compositions. Web mounted the sandbox and permission services but selected `danger-full-access`; the TUI mounted the unrestricted local bash and filesystem providers directly. A fresh coding session could therefore mutate any path its same-UID process could reach before the user deliberately chose that authority.

## Decision

[`base.cordis.yml`](../../../../packages/bundle/base/cordis.patch.yml) owns one sandbox and permission stack for every shipped TUI, Web, and browser-backed headless session: `dsh-sandbox-local`, `dsh-sandbox-policy`, `dsh-bash-sandbox`, `dsh-fs-sandbox`, `dsh-user-approval`, and `dsh-permission-presets`. The composition fallback is the `workspace-write` preset, which bundles `workspace-write` file effects with the `ask` approval policy. `DSH_PERMISSION_MODE` remains an explicit process override; a stored `permission.defaultPreset` remains the user preference for later sessions and outranks the fallback through the Settings seam.

A genuinely fresh session pins `permission/preset: workspace-write`, `sandbox/mode: workspace-write`, and `approval/policy: ask` before execution. Existing and resumed sessions retain their logged permission, and changing the General-settings default affects only sessions created afterward. The browser keeps its Access picker, answerable approval cards, and risk confirmation for Full access. The TUI gains the existing `/permission` command because the shared Permission service activates its command child there.

The mode governs file effects only. Sandboxed bash and filesystem mutations admit the session workspace and platform temporary roots; reads, network access, and process visibility remain outside this policy. If no platform runner can enforce a confined bash call, execution fails closed instead of falling through to an unrestricted command.

## Testing

The keyless shipped-TUI pseudo-terminal smoke boots the real Loader tree, reads the persisted first request, and asserts both the `sandbox_permissions`/`justification` bash schema and the initial workspace-write event triplet. The shipped-Web composition smoke asserts the same policy, approval, and Permission defaults. The assembled browser Settings snapshot opens on Workspace Write, preserves an existing workspace-write session while changing the future default, and still proves the confirmed Full-access path.

## Alternatives considered

**Keep the sandbox stack in `web.cordis.yml` and duplicate it into `tui.cordis.yml`.** Rejected because the plugin identities, presets, fallback, and executor swap are identical. Two copies would make a security default depend on keeping surface overlays synchronized; the shared base is their one owner.

**Leave the TUI unrestricted and change only the browser fallback.** Rejected because it preserves the unexplained surface difference and leaves a fresh terminal session with the authority this decision removes.

**Add a terminal approval dialog in the same change.** Rejected as a separate interaction and lifecycle decision. The TUI has no `approval/request` answerer, so a one-shot automatic escalation currently settles unavailable and fails closed; a user who needs wider authority can deliberately select another preset through `/permission`.

## Consequences

Fresh sessions can modify the active workspace and temporary roots without extra prompts, while an attempted mutation elsewhere is denied before it reaches the target. Full access remains available by explicit selection, and browser selection retains its acknowledgement dialog. Stored user defaults and logged session permissions are not rewritten.

The browser-backed headless entry inherits the Web composition and therefore the same default. The TUI's missing approval answerer is a deliberate limitation of this change: automatic wider retries fail closed there instead of displaying a permission question.
