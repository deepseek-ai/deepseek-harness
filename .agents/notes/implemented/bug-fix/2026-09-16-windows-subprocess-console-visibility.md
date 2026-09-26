# Agent Note: Hide Windows subprocess console windows at creation

Status: implemented

English | [中文](2026-09-16-windows-subprocess-console-visibility.zh.md)

## Problem

PTC runtime and shell calls share the Windows subprocess provider. Its ordinary Job runner omits window hiding, and native targets supply standard handles without a startup visibility flag. Desktop execution can therefore flash console windows for short-lived commands.

## Decision

The private Node Job runner uses `windowsHide: true`. Native ordinary and restricted-token process creation supplies `STARTF_USESHOWWINDOW` and `SW_HIDE` alongside standard handles before target code runs. Console inheritance, Job assignment before resume, and pipe ownership stay intact. No operation hides an existing parent console or promises to suppress windows explicitly opened by the command.

The [ACL sandbox decision](../feature/2026-08-08-windows-acl-restricted-token-sandbox.md) still owns restricted-token policy and console-isolation limits. Initial window visibility does not require adding `CREATE_NO_WINDOW` or `CREATE_NEW_CONSOLE` to restricted creation.

## Alternatives considered

**Hide only the outer runner.** Native target creation is independent of Node's launch options, so its initial visibility also needs an explicit setting.

**Remove consoles from every process.** Restricted-token creation with console-isolation flags has a recorded DLL initialization failure. Startup visibility preserves the existing console attachment rules instead.

**Hide the window after PowerShell starts.** A window can become visible before the script executes; creation-time settings avoid that interval.

## Consequences

Ordinary subprocess startup suppresses incidental console windows without changing tool output or process cleanup. Native Windows tests inspect console visibility in a descendant and in both ACL modes, alongside existing stream, control-pipe, and Job-lifetime tests. A missing console is valid; the tests do not require one to exist. Startup-parameter tests pin the creation-time guarantee that a final visibility observation alone cannot establish.

Session recordings cannot observe native console windows and their transcripts are unchanged. Windows native tests own this regression; browser screenshots cannot establish the absence of desktop windows.
