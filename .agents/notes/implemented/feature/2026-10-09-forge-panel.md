# Agent Note: Change request panel and worktree Sessions

Status: implemented

English | [中文](2026-10-09-forge-panel.zh.md)

## Problem

[Session change request bindings](2026-10-09-session-change-request-bindings.md) give each Session a list of change requests, but nothing shows it. A user who asks the agent to open change requests needs their checks, reviews, and mergeability without leaving the conversation, and wants a new Session's edits and commits kept out of the current checkout. Git must run where the Session's commands run, which can be a remote or confined execution world; inspection must not change the repository, and a worktree must exist before the model's first action.

## Decision

[`dsh-experimental-client-ui-forge`](../../../../packages/experimental/client-ui-forge/README.md) is a two-face package. Its Host half, the `forgePanel` Remote, assembles everything the panel shows for one Session into one streamed state; the forge registry and the binding service keep only their domain operations. Its Client half is a right-sidebar tab, a Session header button that shows or hides it, a New Session option, a creation card above the composer, a toast, and the [Session list icons and hover card section](2026-10-20-forge-session-list.md). Every surface calls a bound item a change request, the forge registry's term, whatever its code host calls it. The [forge bundle](../../../../packages/experimental/forge-bundle/README.md) ships the panel, the forge registry, the GitHub provider, the bindings, and an isolated worktree service as one default-disabled Plugins page entry.

The Remote inspects the checkout through the Session's subprocess provider under the Session's read-only sandbox policy, so it reads what the Session's commands see and cannot write. Inspection reads the top-level, Git, and common Git directories, the branch or the abbreviated HEAD commit, the upstream, the remotes, and the size of the branch's changes against its fork point. It runs when a Session is followed, after each `working-directory/change`, `tool/result`, and `sandbox/mode` event, and on refresh, one at a time with one trailing rerun.

Status polling follows panel subscriptions: a Session's bindings are watched only while one of its surfaces is mounted, and the registry stops polling change requests nobody watches. Each card keeps the last snapshot a poll returned, so a transient failure keeps the title and number visible. A Session's only open change request starts expanded, and with several every card starts collapsed; the user's first toggle replaces this default.

An expanded card marks a draft ready for review and merges a change request the host would merge now. The forge seam carries both as provider actions that return a typed failure, and every snapshot says whether the host would merge the change request now for the signed-in user and which methods the repository allows, so the panel offers only actions that can succeed. A merge carries the head commit the card showed, and the host refuses it once new commits arrived. The panel acts only on change requests bound to the Session.

A new Session starts in a worktree through a request, not an immediate creation. Checking the option in the New Session row, a `conversation.hero.options` entry, appends a `plugin:client-ui-forge/worktree` record with the base branch; changing the base or clearing the option appends another, and nothing touches the repository until the user sends. The option is offered only where creation can succeed: under `workspace-write`, the checkout and its common Git directory must lie inside the writable root, which excludes a project that is itself a linked worktree. The worktree must exist before the first message's turn starts, so the turn runs there and its first request already names the new directory. When the message enters the Session's inbox, the panel's `agent/inbox/inserted` listener starts maintenance of the Agent before the delivery wakes it; the Agent latches the wake until the maintenance ends, and the panel creates and enters the worktree inside it. The creation's stage streams to a card above the composer, where Cancel stops the attempt. After a stopped or failed attempt the message keeps waiting in the inbox, and the card keeps the failure and offers another attempt with a new branch name or Continue without a worktree, which withdraws the request and lets the message go on. An `agent/pre-step` listener still creates the worktree at the first step proposal of a Session whose request is open, because a message that enters while the Agent runs a turn or other maintenance gets no hold; it moves the working-directory notice into the proposed messages, and a failure ends the turn. The `forgeWorktree` projection ignores requests after the first `turn/start` and creations after the first `step/start`, so a running Session never moves. The tab's first row names the branch the Session works on, and the Session list marks a Session that works in its created worktree.

The worktree a Session works in can be removed outside it. Each inspection checks whether the created worktree's directory still exists, and every message that enters while the Agent is idle starts a hold that checks again, so the message waits without starting its turn while the directory is missing. The check must come before the turn: while it assembles a step's context, the working-directory service moves a Session whose directory is gone back to its project, before any pre-step listener runs. Restore checks the branch out again at the recorded directory, or creates the branch again at its base commit when it is gone; Continue in the project moves the Session to the source checkout. Either runs inside the hold and lets the waiting message go on.

The panel does not move a Session between existing worktrees. Removing a change request appends a `dismiss` record, and its toast offers Undo through `track`.

The panel also shows the changes behind a Session's work in a changes view, a resource tab type of this package. The Remote parses every diff on the Host into files and hunks, so the browser draws them without a patch parser, and bounds each read with `maxDiffBytes` and `maxUntrackedFiles`. Local changes come from confined `git diff` in the Session's execution world, in a scope the user picks: the branch against its fork point by default, or the uncommitted, unstaged, or staged changes; untracked files are read through the Session's filesystem and shown as new files. A change request's changes come from its code host at the head of the binding's latest status, through two provider reads the forge seam gained, `diff` and `fileText`. The Host keeps the patch it read last for each change request, keyed by the head commit and base branch and bounded by `maxCachedDiffBytes`, so reopening, refreshing, and navigating at the same head download nothing again; a host or provider that refuses an answer over its size limit reports the forge failure `too-large`, and the view then offers the change request's web page instead of a retry. Unchanged lines between hunks expand from the file's new side, which is the working tree, the index, or the head commit, and only while that text still matches the hunks. Each inspection also sizes the branch's changes for a local changes card, shown while no open change request carries the checked-out branch; its Create change request sends the Session a user message, so the Agent creates the change request with its own tools and the binding follows from `gh pr create` as for any other.

## Deferred

A left-navigation review page next to Plugins and Scheduled tasks, listing the user's pull requests or merge requests on the selected provider, is deferred. It attaches without changing this package's Session surfaces:

- **Provider capability** — an optional `ForgeProvider` method such as `listForViewer(host, filter, signal)` returns change request references; GitHub implements it with `gh search prs --author @me` or the GraphQL `viewer`, and the registry aggregates enabled providers.
- **Remote** — a stream like `follow` that is keyed by provider and filter instead of a Session and polls through the same `ctx.forge.watch`.
- **Client** — a `sidebar.panellist` entry with a `main` page in this package, as `ui-schedule` does, rendering `ChangeRequestCard`, which takes a change request, its snapshot, and optional actions.
- **Settings** — provider choice and hosts on the bundle's configuration page.

The changes view offers no scope for one commit or for the last turn yet; both would be further `ForgeLocalScope` kinds read through `localDiff`.

## Alternatives considered

**Per-host nouns.** Calling items pull requests on GitHub and merge requests on GitLab would need each provider to declare its noun and every string to take it; GitHub is the only provider, and one term keeps the copy fixed.

**Merging through `gh pr merge`.** It enables auto-merge while required checks are pending and joins a merge queue when the base requires one, so a click could schedule a later merge instead of merging. The REST merge endpoint merges at once or refuses.

**Deleting the head branch after a merge.** The Session's worktree can be on that branch.

**A Host service package for Git inspection.** No second consumer needs checkout facts yet; a model tool can move them into a shared service when it exists.

**Running Git as a Host process.** Remote and confined execution worlds would show the Host's files instead of the Session's, and the Host would read directories the Session cannot.

**Creating the worktree when the option is checked.** Every toggle or base change would create and abandon a checkout, and the Session would move before the user decided to send.

**Carrying the option in the Session creation request.** The Session controller owns a closed request; a plugin record keeps the option inside this package and survives a reload of the blank Session.

**Switching between existing worktrees from the panel.** A switched Session keeps the sandbox root of its project, so a worktree outside the project stays read-only, and moving mid-conversation splits the model's view of the files. Starting a Session in its worktree avoids both.

**The option in the composer tool row.** The tool row stays after the first message, when the option no longer applies; the New Session row disappears once the Session starts. The row offered only single slots, so `ui-conversation` gained the list slot `conversation.hero.options`.

**Creating the worktree within the first turn.** The turn has started when the first step proposal runs: its context was assembled for the old directory, a failure can only end the turn and drop the claimed message, and the working-directory service has already moved a Session out of a removed worktree. It remains the fallback for a message no hold took.

**Holding the message at Agent admission.** An `agent-controller/admission` stage would hold a message before it enters the inbox, so the composer keeps it until the worktree exists and a failure returns it for editing. It needs a controller service in front of every sender's delivery, a core addition that one panel does not justify; a hold at inbox insertion uses the existing inbox event and maintenance, and covers every sender.

**Returning a waiting message to the composer.** Once the Host accepted a message the composer cannot take it back without a new public API in the conversation package for one plugin; the message keeps waiting with the card's actions instead.

**A submit gate in the Web composer.** The browser held the message before the Host saw it, so every check needed a Remote call, the stage of a refused message lived only in the browser, and other senders bypassed it. A hold at inbox insertion keeps the message where it enters the Agent and the failure in the panel state.

**The creation card in the transcript.** Transcript nodes accept no plugin kinds; the input dock above the composer is the nearest list slot, and it renders on the New Session screen.

**Manual URL tracking.** It duplicated the bindings the Session's own commands record. Bindings come from `gh pr create`, the `gh pr` commands that act on one change request, pushes, and the branch the checkout tracks, and `track` remains for Undo.

**Parsing patches in the browser.** The Remote would carry unbounded patch text, and the browser would need a patch parser; the Host bounds the read and parses it once.

**Reusing the review tab's file comparison.** It belongs to another plugin, which this package may not import at run time, and moving it into the shared primitives would change a shared package for one consumer; the view is built from the shared highlighter, menu, tooltip, and diff color tokens instead.

**Reading a change request's diff from the local repository.** The checked-out branch can be ahead of or behind the host, and the base may not be fetched; the host's diff is what reviewers see. The view says when the checked-out branch has commits beyond the head instead.

**Recognizing a too-large diff from the failure message in the panel.** The message belongs to the provider and its host and changes with them; a failure code lets each provider report its own limits, and the panel branches on the code.

**Creating the change request from the card.** The panel would need to push the branch and compose the title and description; a message lets the Agent do both with its tools and the user's instructions, and keeps one way to bind change requests.

## Consequences

The panel shows current status only while it is open; checks that finish while nothing is mounted produce no notification. Changes made outside the Session appear after Refresh or the next tool result. Every inspection spawns up to eleven short Git processes in the Session's execution world with one remote, and two more for each further remote it tries for a fork point. A worktree exists only for a Session that requested it before its first step, and a failed or cancelled attempt can leave its branch or checkout behind. A message that enters while the Agent runs a turn or other maintenance gets no hold, so its worktree is created within the first turn and a removed worktree is not checked. While a message waits, the Agent stays idle in maintenance: the composer offers no stop, and callers waiting for the Agent to become idle wait as well. Restoring loses changes that were never committed. A base branch that requires a merge queue cannot merge from the panel. With Git Worktrees also enabled, two independent worktree services exist; the model's tool never sees the panel's service. A local or change request diff over `maxDiffBytes`, or one the host refuses, shows no files. Expanding unchanged lines of a change request reads each file from the code host once.
