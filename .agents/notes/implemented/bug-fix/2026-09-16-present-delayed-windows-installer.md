# Agent Note: Present delayed Windows installer

Status: implemented

English | [中文](2026-09-16-present-delayed-windows-installer.zh.md)

## Problem

The native installer hides its window while preparing resources. If the user activates another application during that interval, the welcome page can appear behind that application and seem absent.

## Decision

The first welcome-page display moves the installer above ordinary windows without activating it. When another window owns the foreground, the installer also flashes its taskbar button until foreground interaction. Later page changes do not repeat the move. The window never becomes permanently topmost.

## Alternatives considered

**Force foreground focus.** Windows may reject a background process's foreground request, and taking focus after the user switches applications interrupts their current action.

**Keep the installer topmost.** A persistent topmost window obscures applications the user intentionally opens during installation.

## Consequences

The welcome page becomes visible when preparation completes, while the user retains control of focus and can cover the installer again. A native window-order test and the signed installer smoke test exercise the first display.
