# Agent Note: Continuous CUA hover without cross-call ownership

Status: implemented

English | [中文](2026-10-13-cua-continuous-hover.zh.md)

## Problem

Hover interactions span movement, delayed content, observation and input inside a revealed region. A request cleanup that restores the pointer, or a click that first presses outside that region, can dismiss the content even when nobody else sends input.

## Decision

App and Window expose `hover` for an observed AX element or an explicit coordinate target. It never presses a mouse button; disabled controls can use system-pointer movement. Completion, AX reads and screenshots do not restore a previous pointer position. Successive calls can visit intermediate points before entering a popup. Clicks deliver button events at their target without an off-window priming click. The [input-routing decision](2026-10-13-cua-hover-routes-and-coordinates.md) selects AX alternate UI before falling back to system movement with foreground and mouse-hit checks. It never activates or raises the app implicitly. Other input or window changes can race that check.

The [shared helper](2026-10-09-cua-shared-native-helper.md) serializes complete individual operations. It grants no application ownership across calls. Earlier arrival, a retained app object and Session lifetime do not establish task priority. Waiting for the model does not reserve the application. Explicit task coordination determines any required execution order.

## Alternatives considered

**Cross-call application reservation** would block other tasks throughout observation and model inference without evidence that the first task deserves priority. Continuous interaction instead relies on CUA preserving the last hover state when no further input occurs.

**Click or drag as hover** introduces button input that can activate a control, select text or dismiss a popup. Hover requires a separate unpressed movement operation.

**PID-directed virtual movement** can display Chromium hover content after prior interaction, but a fresh window can ignore it, and later pointer checks can dismiss the content. Native AppKit tracking also requires real pointer movement in the measured fixture. The system-pointer fallback avoids reporting this unreliable event route as continuous hover.

## Consequences

Other input and application-driven changes can interrupt the interaction; callers observe fresh state before continuing. Dispatch does not verify that a hover delay has elapsed or a popup has appeared. The Electron fixture verifies delayed reveal, AX and screenshot preservation, entry into the popup, exactly one trusted click and dismissal on exit. The recorded Session covers hover dispatch and observed popup content; it does not substitute for native event verification.
