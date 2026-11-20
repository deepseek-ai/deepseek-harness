# Agent Note: Conversation file references after directory moves

Status: implemented

English | [中文](2026-11-19-conversation-file-references-after-directory-moves.zh.md)

## Problem

A Session's directory moves during its life: `enter_worktree`, `exit_worktree`, and Host operations each record a `workspace-root/change` ([Session working directory](../architecture/2026-09-13-session-working-directory.md)). Tool rows, produced-file mentions, presented files, and changed-file cards store the absolute path of the operation that produced them, so they keep naming their file. References that stored only relative text did not:

- A relative Markdown link in an earlier reply, and a picked `@file` in an earlier message, were resolved against the directory at the click. After a move they opened the same path in another checkout or reported a missing file.
- A relative inline image was resolved against the header directory, so an image written in a worktree did not load even before a later move.
- An opened Sidebar tab stored a relative address for a file inside the Session's directory. After a move and a page reload it showed another file or none.

## Decision

**Each reference carries an absolute path from the moment it is written.** No reader reconstructs the directory a reference was written in.

- The `ui:deliverable-file-references` guidance asks the model for absolute Markdown link and image targets.
- `fileAddressFor` puts the absolute path in the `dsh-resource://file/session/…` address: an absolute path is kept, and a relative path is joined to the directory the caller knows. An opened tab names one file for its lifetime.
- A file or folder picked from the `@` list is written as an absolute mention. A file dropped or pasted in Desktop keeps the absolute path the shell reports.
- A relative path that still reaches the Client resolves against the Session's current directory: one the model wrote despite the guidance, one typed by hand after `@`, or one written before this decision. Links, images, and context-menu actions share that base.

## Alternatives considered

**Resolve each relative reference against the directory its message was written in.** A Host projection would list each `workspace-root/change` with its sequence number, and the Client would select the directory by message sequence. It repairs existing conversations and leaves model-visible text unchanged. It adds a projection and a lookup in every reference consumer, and it cannot repair a target the model wrote against the wrong base: in recorded runs with the earlier guidance, a model working in a worktree wrote 7 of 66 link targets relative to the original project. Folding only the loaded events instead of adding a projection misses moves that precede the loaded page of a long conversation. An implementation of this route, a `workingDirectoryHistory` projection with a Markdown path resolver, was merged in #8268 and reverted in #8438.

**Rewrite relative targets to absolute when the reply is stored.** The stored reply would differ from the text the model produced, and later requests would replay the altered text. None of the eight surveyed agent products rewrites assistant prose; three of them ask for absolute targets in their prompts instead.

**Keep relative tab addresses and convert them when the directory moves.** Every Client that holds the Session would rewrite its stored tabs on each move, including a Client that is closed when the move happens.

**Leave picked `@file` mentions relative.** The model reads the mention under the directory of that request, so the request itself is correct. The sent message names another file after a move, and its chip becomes plain text after a reload when the file exists only in the earlier directory.

## Consequences

Recorded runs with the absolute-target guidance produced 128 link and image targets in eight Sessions on two DeepSeek models, including project paths with spaces and non-ASCII characters; all were absolute and 127 named an existing file. Link targets averaged 76 characters instead of 19 in a project whose path has 51 characters; output tokens per Session showed no measurable rise.

A picked or dropped reference carries its absolute path wherever its serialized text appears: the fallback Session title and the turn-navigation preview show the path when a message starts with a reference. The chip label still shows the file name.

References written before this decision keep their relative text and follow the Session's current directory, and so does a hand-typed `@relative/path`. The `@` list omits `out`, `dist`, `build`, and similar directories, so a file there is reachable only by typing. A tab stored with a relative address keeps following the Session's directory, and opening the same file again adds a second tab under the absolute address.

Compliance with the guidance was measured on DeepSeek models only. A model that still writes a relative target gets the current-directory rule above.
