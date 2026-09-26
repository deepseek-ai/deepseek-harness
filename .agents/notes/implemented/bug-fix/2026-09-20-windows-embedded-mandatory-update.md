# Agent Note: Windows embedded mandatory update

Status: implemented

English | [中文](2026-09-20-windows-embedded-mandatory-update.zh.md)

## Problem

A second native Windows window does not resize atomically with its parent, producing a detached overlay during maximization (#4566). Native modality also disables the parent controls that users need to exit.

## Decision

Windows uses one native window and a shell-origin frame below the caption. This partially supersedes the presentation decision in the [mandatory-update client](../feature/2026-09-11-desktop-mandatory-update-client.md); that note retains policy and installation ownership. macOS retains its native overlay.

The isolated application preload transfers a private MessageChannel endpoint directly to the shell frame. Only messages on the paired private port authorize update IPC; synthetic window events cannot invoke actions. The main process validates the current application main frame and rebinds state delivery when the main window changes. Destroyed windows receive neither state nor focus operations.

## Alternatives considered

**Synchronize a second native window.** Parent movement, maximization and restoration expose independently scheduled geometry updates; removing the second window removes that synchronization problem.

**Treat source and origin on window events as authentication.** Product scripts can construct those event fields. A private port keeps action authority outside the shared product document.

## Consequences

Caption menus and Web controls remain reachable. The DOM overlay blocks ordinary background input but cannot prevent product scripts from hiding or imitating presentation; it is not a tamper-proof security surface. Main-process policy and installation authorization remain separate from that display. Regression coverage requires forged-event rejection, real channel delivery, caption keyboard operation, and destroyed/replacement-window lifecycle cases.
