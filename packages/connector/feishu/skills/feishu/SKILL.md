---
name: feishu
description: "Feishu (飞书) and Lark through the bundled lark-cli: documents and wiki, Base, sheets, slides, Drive files, messages and group chats, calendar, video meetings and minutes, tasks, approvals, mail, contacts, OKR, attendance, events, and the CLI's app setup and sign-in. Load it before any Feishu or Lark task; it indexes the guides and how to open them."
---

# Feishu in DSH

Call this integration the Feishu plugin (飞书插件 in Chinese) in user-facing replies. Run `lark-cli` in the Host Shell by the absolute path that the current runtime context gives for it, not by name; DSH installs the version this plugin pins. It uses the default lark-cli configuration and sign-in shared with the user's own terminal, so do not remove, switch, or sign out of apps or profiles unless the user asks.

When a command reports a missing app configuration or sign-in, first ask the user to connect Feishu on the Feishu plugin page in Plugins. Open the lark-shared guide and run its setup and auth flow yourself only when the user asks to finish it in this conversation. Never ask for or print app secrets or tokens.

Commands that save sign-in state, such as `auth login --device-code` and `config init`, write outside the workspace and use up their one-time authorization even when the save is denied: on the first attempt, set the Shell tool's `sandbox_permissions` to the narrowest mode that can write outside the workspace, with a `justification`. Run other commands in the existing sandbox and set `sandbox_permissions` only when a credential, lock, log, or cache write is denied.

Do not install another lark-cli or run `lark-cli update`.

## Guides

- `lark-approval`: Feishu Approval: list and handle approval tasks, look up instances, search the definitions you can start, and start native approval instances; to-dos that are not approvals belong to `lark-task`.
- `lark-apps`: Miaoda (Spark) app development and hosting: create apps, develop locally or in the cloud, design mockups and prototypes, deploy and publish, and manage logs, metrics, environment variables, collaborators, roles, and automation triggers; use for apps served from `*.aiforce.cloud`.
- `lark-attendance`: Feishu Attendance: read your own check-in records.
- `lark-base`: Feishu Base (bitable): tables, fields, records, views, statistics, formulas, forms, dashboards, BaseApp pages, workspaces, workflows, roles, and templates; use for `/base/` and `/app/` links.
- `lark-calendar`: Feishu Calendar: view, search, create, and update events, manage attendees, query free/busy and suggested times, and book meeting rooms; past video meetings belong to `lark-meeting` and to-dos to `lark-task`.
- `lark-contact`: Feishu contacts: resolve a name or email to an `open_id`, look a user up by `open_id`, and search the bots and agents you can see; department trees need the native OpenAPI.
- `lark-doc`: Feishu Docs and Wiki documents: read, create, and edit documents, insert or download image attachments, and work with mind notes; route by document URL or token, including `doubao.com` `/docx/` and `/wiki/` links.
- `lark-drive`: Feishu Drive: files and folders, upload and download, copy, move, delete, metadata, permissions, comments, subscriptions, titles, versions, security labels, and importing local Word, Markdown, Excel, CSV, PPTX, or `.base` files as Feishu documents.
- `lark-event`: Feishu real-time events: subscribe to and consume message, approval, task, meeting, minutes, and whiteboard events as NDJSON, with bounded runs for agents that run as subprocesses.
- `lark-im`: Feishu Messenger: send and reply to messages, search chat history, manage group chats and members, transfer images and files, reactions, urgent notices, pinned feeds, interactive cards, and card callbacks.
- `lark-mail`: Feishu Mail: draft, send, reply to, forward, read, and search mail, and manage folders, labels, mail contacts, new-mail listeners, and inbox rules; mail intent only.
- `lark-markdown`: Feishu Markdown files: view, create, upload, edit, and diff native Markdown files in Feishu, including comparing the remote version with a local draft.
- `lark-meeting`: Feishu video meetings: meeting records and artifacts such as minutes and transcripts, Minutes search, upload, download, and editing, bot participation, live meeting content, and in-meeting chat; scheduling, free/busy, and rooms belong to `lark-calendar`.
- `lark-minutes`: alias that defers to `lark-meeting`; open it only when the user or a configuration names it.
- `lark-note`: alias that defers to `lark-meeting`; open it only when the user or a configuration names it.
- `lark-okr`: Feishu OKR: view and edit cycles, objectives, key results, alignments, metrics, and progress records.
- `lark-openapi-explorer`: Feishu native OpenAPI exploration: find and call OpenAPI endpoints the CLI does not wrap when no other guide or registered command fits.
- `lark-shared`: lark-cli setup and auth: login, status, and logout, user versus bot identity, business-domain permissions, missing scopes, revoking authorization, and `_notice` JSON.
- `lark-sheets`: Feishu Sheets: create and edit spreadsheets, sheet and row or column structure, cell values, formulas, styles, charts, pivot tables, conditional formats, filters, and Excel or CSV import and export; Base belongs to `lark-base`, and searching Drive for a sheet to `lark-drive`.
- `lark-skill-maker`: create custom lark-cli skills that wrap Feishu API operations or multi-step flows.
- `lark-slides`: Feishu Slides: create presentations, read slide content, and create, delete, read, or partially replace pages; whiteboards inside documents belong to `lark-whiteboard`.
- `lark-task`: Feishu Tasks: create and update tasks and their status, subtasks, task lists, assignees, attachments, and task agents.
- `lark-vc`: alias that defers to `lark-meeting`; open it only when the user or a configuration names it.
- `lark-vc-agent`: alias that defers to `lark-meeting`; open it only when the user or a configuration names it.
- `lark-whiteboard`: Feishu whiteboards inside documents: export a whiteboard as an image or as raw nodes and update its content in several formats.
- `lark-wiki`: Feishu Wiki: knowledge spaces, their members, the node hierarchy, and organizing documents and shortcuts; use for `/wiki/` links, while document content belongs to `lark-doc`.
- `lark-workflow-meeting-summary`: workflow that collects the meeting minutes of a date range into a structured report.
- `lark-workflow-standup-report`: workflow that combines the calendar agenda and open tasks into a summary for a day or a week.

## Opening a guide

These guides belong to lark-cli and are not skills: open one with `lark-cli skills read <name>` in the Host Shell, not with the skill tool.

Read a file that a guide references, such as `references/...`, with `lark-cli skills read <name> <relative-path>`. Read a reference to another guide, such as `../lark-foo/...`, with the same command without the leading `../`: `lark-cli skills read lark-foo/...`.
