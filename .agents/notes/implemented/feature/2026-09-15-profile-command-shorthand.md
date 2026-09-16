# Agent Note: Profile command shorthand

Status: implemented

English | [中文](2026-09-15-profile-command-shorthand.zh.md)

## Problem

Profile launch needs a concise spelling that works for custom names without making plugin management depend on the contents of the Harness home.

## Decision

The CLI expands a leading non-option argument other than `plugin` into `--profile <name>` before parsing. Both spellings use the same launcher flags, app-argument forwarding, and profile validation. `plugin` retains command priority only as the first argument; `dsh --profile plugin` selects the same-named profile explicitly. After profile selection, `plugin` is forwarded as an app argument. Repeated profile selection before app arguments is rejected.

This decision supersedes the Web-only shorthand mechanism in [one dsh application launcher](../architecture/2026-08-22-single-dsh-application-launcher.md); that note retains authority over application composition and lifecycle ownership.

## Alternatives considered

- Registering profiles as commands requires filesystem discovery and makes parsing depend on installed profiles.
- Giving profiles priority over built-in commands makes installing a profile change the meaning of plugin-management invocations.
- Last-wins profile selection can launch a different app from the leading name; explicit rejection avoids that ambiguity.

## Consequences

Custom profiles and shipped profiles share one shorthand without adding public types. Names must immediately follow `dsh`; an unknown name reaches the existing missing-profile diagnostic. Removing the dedicated `web` command also lets an already selected profile receive `web` as an app argument. Parser equivalence tests, built-bin acceptance, and the keyless headless tool round trip cover the shared launch path.
