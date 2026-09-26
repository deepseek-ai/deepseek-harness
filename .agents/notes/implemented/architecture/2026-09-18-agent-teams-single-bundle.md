# Agent Note: Enable Agent Teams with one bundle

Status: implemented

English | [中文](2026-09-18-agent-teams-single-bundle.zh.md)

## Problem

Separate Agent Teams and Agent Teams Web switches require users to discover that tools and their browser controls need both selections. The package split exposes composition details in the plugin page without helping users choose a different Team capability.

## Decision

`@deepseek-ai/dsh-experimental-agent-team-profile` carries the Team service, tools, and browser UI in one optional bundle. Its patch retains the `agent-team`, `tool-agent-team`, and `ui-agent-team` row ids, so profile patches can still configure individual rows. The UI package has an inert Host entry; its browser entry mounts only in a Web Client, and headless does not start a Web server.

The separate `@deepseek-ai/dsh-experimental-agent-team-web-profile` package is absent from the workspace and release family. The plugin page exposes one Team selection, disabled by default.

This decision supersedes the separate Host/Web composition in the [package publication note](2026-08-18-experimental-agent-teams-packages.md) and the two Team selections in the [optional-bundle note](../process/2026-09-15-shipped-optional-bundles.md). Both remain active for publication, dependency isolation, promotion, and installation ownership. The [archived Web-controls note](../../archived/feature/2026-08-06-agent-teams-web.md) records the original split; its historical text remains frozen.

## Alternatives considered

**Keep two switches and explain their dependency.** Users still need two selections for one feature, and either selection alone leaves an incomplete browser experience.

**Combine the entries in the generic profile loader or plugin manager.** Recognizing Team package names there would make shared loading or presentation code own feature-specific composition. The bundle patch already declares the required rows and dependencies.

## Consequences

Users enable tools and browser controls together. Separate installation-level selection of a UI-only Team bundle is unavailable; custom profiles still control individual patch rows. Headless installations include the UI dependency graph even though they do not mount its browser entry.

Existing profiles that select the removed Web bundle have an upgrade compatibility gap: startup fails when that package cannot be resolved. Bundle composition provides no automatic rewrite of those saved selections. Compatibility handling remains separate from this composition decision.

## Verification

The plugin-manager browser test observes the Team controls appear after one switch, reads the roster and task board through Remote, and observes their removal after disabling the bundle. The Team-panel browser test covers the read-only task board; the built headless CLI test covers delegation without a Web server. These scenarios do not cover upgrading a profile that still selects the removed Web bundle.
