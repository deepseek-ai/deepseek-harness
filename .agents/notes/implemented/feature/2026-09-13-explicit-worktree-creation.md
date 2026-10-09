# Agent Note: Explicit worktree creation

Status: implemented

English | [中文](2026-09-13-explicit-worktree-creation.zh.md)

## Problem

A Session that needs an isolated checkout otherwise has to coordinate Git commands with its own working directory. Changing a shell process directory does not update the Session's later tools or recorded context, and a linked worktree's Git administration directory can lie outside the Session's existing write grant.

## Decision

The experimental [worktree runtime](../../../../packages/experimental/worktree/README.md) creates a new named branch and checkout from a pinned local commit, then enters its canonical directory through the shared working-directory service. The [tool](../../../../packages/experimental/tool-worktree/README.md) exposes `create_worktree({ name?, from? })`. These packages use ordinary explicit composition, with no additional runtime feature flag.

The source repository comes from the calling Session's current directory. Creation does not fetch or copy uncommitted files. The default pool is `.agents/worktrees` under the current checkout’s top-level directory, including when the caller is in a linked checkout. The process that creates a pool writes its self-ignoring `.gitignore`; existing directories and ignore files are preserved. Names must be new branches and unused checkout paths.

Git and directory creation use the mounted subprocess and sandbox providers without widening the calling Session's policy. Both destination and shared Git metadata writes must already be permitted. Successful creation changes only the current working directory; the Session identity and original sandbox root remain owned by their existing services.

Leaving uses the shared working-directory operation and retains the checkout and branch. Failed setup can retain partial artifacts and reports their location. The service does not own a checkout registry, cleanup schedule, branch merge policy, or task association database.

## Alternatives considered

**A separate worktree-exit tool.** Leaving is the existing working-directory operation; another exit operation would needlessly couple directory changes to Git ownership or deletion.

**Copy the dirty checkout into each new worktree.** A pinned local commit gives the caller an explicit baseline without mixing staged, unstaged, untracked, and ignored state or inventing conflict rules.

**Automatic subagent isolation.** [Agent Teams](2026-08-05-agent-teams.md) keeps its existing explicit coordination model. Creating a checkout is available as an operation rather than an implicit consequence of delegation.

**Expand write grants during creation.** A convenience operation cannot acquire authority over a shared Git administration directory merely because the destination is writable.

## Consequences

The caller can continue one Session in a new checkout with a reconstructable directory change. Retention avoids deleting work on exit or a failed final publication, but callers must manage unused checkouts and branches themselves. Git and Node must be available in the filesystem provider's execution world. Submodule setup and dependency installation remain separate operations.
