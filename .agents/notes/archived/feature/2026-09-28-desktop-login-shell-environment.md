# Agent Note: Desktop reads the login-shell environment once

Status: implemented
Archived: 2026-09-30

English | [中文](2026-09-28-desktop-login-shell-environment.zh.md)

## Problem

macOS Dock, Finder, and Linux desktop launches start Desktop with only the session manager's environment. Variables that users export from `~/.zprofile` or `~/.zshrc`, including PATH entries for Homebrew, version managers, and API keys, are absent from the Host, agent shells, terminals, and profile configuration. The same Host launched from a terminal sees them.

## Decision

Before creating the first Host, [Desktop](../../../../apps/desktop/README.md) runs one delimited `env -0` dump through `<shell> -ilc`, where `<shell>` is the account record's login shell, followed by `/bin/zsh`, `/bin/bash`, and `/bin/sh`. Every Host in the application process uses the merged result. Shell values replace inherited values except probe-session variables and the `DSH_*` and `ELECTRON_*` namespaces. The read completes at the closing delimiter. A timeout or quit kills the probe's process group, and a failed read falls back to the inherited environment without blocking startup. Windows skips the read.

## Alternatives considered

**Read `$SHELL` instead of the account record.** A Dock launch inherits `$SHELL` from launchd, not from the user's current choice, and a terminal launch can carry a temporary shell. The account record names the shell the user selected with `chsh`.

**Non-interactive `-lc` only.** Most users export PATH additions from `~/.zshrc`, which only interactive shells read. Interactive mode requires the probe variables that stop oh-my-zsh update prompts and tmux autostart from blocking.

**Let shell values replace `DSH_*` variables.** Desktop resolves `DSH_HOME` and its profile paths before the read, so a `DSH_HOME` exported from `~/.zshrc` would give the Host a different home from the one Desktop prepared.

**Wait for stdout to close.** Background processes that startup files start inherit stdout and can hold it open indefinitely, which turns every read into a timeout.

## Consequences

Dock and Finder launches give the Host the environment a terminal launch provides. Changes to startup files apply only after Desktop restarts. Startup waits for the read, up to `DSH_DESKTOP_LOGIN_SHELL_TIMEOUT_MS` per candidate. Account shells that cannot run the POSIX dump, such as csh, tcsh, and nushell, receive the first system shell's environment instead. `DSH_*` settings must come from the launcher's environment rather than startup files. Unit tests run stand-in shells for the early completion, timeout, abort, and fallback paths, and the Desktop startup test verifies that the Host waits for the read.
