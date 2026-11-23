# Agent Note: Code review page

Status: implemented

English | [中文](2026-11-11-forge-review-page.zh.md)

## Problem

The [forge panel](2026-10-09-forge-panel.md) shows the change requests one Session created or pushed. A reviewer also needs the change requests that ask for their review, that they created, or that involve them, read and reviewed without first finding or creating the Session that owns them, and a conversation with the Agent about one of them that does not mix into an unrelated existing conversation.

## Decision

A left-navigation Code review page in [`dsh-experimental-client-ui-forge`](../../../../packages/experimental/client-ui-forge/README.md) lists three viewer lists and shows one change request in full.

- **Lists** — an optional `ForgeProvider` capability (`viewer`, `listForViewer`, `countForViewer`) returns summaries of open change requests; GitHub answers each list with one GraphQL search, because one document with several searches times out. The Host reads the lists only while a page or count stream lasts, outside the forge's status polling, since a batch snapshot of dozens of change requests exceeds GitHub's query timeout; only the shown change request is polled through `ForgeService.watch`.
- **Reads by URL** — the page's `forgePanel/review*` methods name a change request by URL and no Session; they share the Session-bound methods' implementation and are reachable only by callers that may use the Host's code host credentials.
- **Description** — `readDescription` returns the Markdown body, labels, and signed addresses for private attachments, which the page substitutes before rendering with HTML omitted.
- **Activity** — two more optional `ForgeProvider` methods, `readActivity` and `addComment`, give the summary tab the comments, submitted reviews, commits, and changes of state of a change request and a field that adds a comment. A provider maps its host's records to one entry type, so the page words every entry in the reader's language and shows a host's own sentence only for a record the type has no kind for. A review's comments on lines stay on the changes tab, which already reads, answers, and resolves them; the activity counts them and opens that tab.
- **Automatic merge** — a snapshot's optional `autoMerge` and the optional `ForgeProvider.setAutoMerge` let the merge action turn the host's automatic merge on for a confirmed head, show that it is on, and cancel it. The field is optional so a provider that sets none changes nothing, and the snapshot carries what the signed-in user may do, so no surface asks the host before it draws the button. Merge queues and merge trains stay out: there the same button would queue the change request, which is another action.
- **Changes** — the page draws the changes view itself, split from the right-sidebar tab, with a panel state that holds only the shown change request; plugin lenses, annotations, and slots stay with the Session tab, whose extension points name a Session.
- **Chat** — the chat tab embeds `conversation.content` for the blank Session `connectWorkspace` resolves in the Workspace named like the repository, and never offers an existing conversation. A Workspace picked in the Hero is handled by the page, as every owner of the content handles its own picks: the page connects that Workspace's blank and shows it in the chat tab, where the main Conversation opens it as the main Session. The change request is bound when the Session's first message enters its inbox, so a blank that is never used stays unbound.
- **Hosts** — the page lists every configured host together, GitHub and GitLab. A host whose read failed is read again later each time without delaying the others, since the bundle ships a GitLab host most users are not signed in to. A repository scope names its host and is read there only: one `owner/name` can exist on two hosts, and a GitLab project path nests groups. The filter offers each host once the lists span several, and a host that could not be read shows one notice after the lists. A row names no host, because every row would then need a second line of small text; choosing among accounts of one host is not offered.

## Alternatives considered

- **A Session per change request for reading** — rejected: reading the description or the diff would create Sessions nobody converses in, and bind them.
- **Reviewing in an existing conversation** — rejected by the user: the conversation's context would mix with the review.
- **Listing through the status poller** — rejected: the batch snapshot query times out at the list sizes a reviewer has.
- **Binding when the chat opens** — rejected: the blank Session is shared with New Session, so it would carry the binding into an unrelated conversation.

## Consequences

The forge registry gains a fifth optional capability family and a `rate-limited` failure code, recorded in the [upgrade guide](../../../../docs/upgrade-guide/v0.2.2-rc.4/forge-rate-limited-failure/guide.md). A Host restart before the chat's first message forgets the staged binding.
