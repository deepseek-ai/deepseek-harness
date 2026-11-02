# Agent Note: IM media admission keeps non-images as verbatim files

Status: implemented

English | [中文](2026-11-02-im-file-media-admission.zh.md)

## Problem

`@deepseek-ai/dsh-experimental-im` labelled every media element of a stored message with a stable id (`[图片 #12.1]`, `[文件 #12.2 report.pdf]`, `[语音 #12.3 语音.opus]`) but could admit only the image kind: `ImMediaStore.admit` answered `skipped: 'unsupported'` for `file`, `audio` and `video`, and the only read tool, `im_read_image`, refused them the same way. A person who sent a document, a voice message or a video into a chat therefore handed the model a label it could not open — the transport, the Lark decoder and the core resource fetcher already carried the bytes (`<file src="satori:…/resources/<file_key>?type=file">`), and nothing consumed them. The `media` field's own contract already said images and files are downloaded, so the implementation was behind its documented behavior.

## Decision

Admission is by payload, not by kind. `ImMediaStore` fetches and bounds a reference exactly as before, then stores an image as a normalized image block and every other kind as the exact bytes of a durable verbatim file through `ctx.attachments.saveFile`. `ImFormatter.format({ media: true })` appends each admitted file as a `file` content block beside the text, so request assembly projects it to the deterministic handle text naming the saved read-only path — the same representation a browser-attached file gets.

The model reaches a file that is no longer in the delivered window through the new `im_read_file` tool: it resolves the label to its element, admits it as a verbatim file, and reports the display name, byte length, content digest and the read path (`attachments.fileHostPath` mapped through `fs.processPathFromHostPath`, the resolution request assembly itself uses). `im_read_image` keeps its image-only contract; guidance names both tools and the two label shapes.

## Alternatives considered

**Add the read tool without admitting files eagerly.** Every new message would then cost one download less, but the model would have to ask for a file the sender just handed it, which is exactly the request shape the image path already answers without a tool call.

**Read text-like files into the tool result.** Sniffing a media type to inline text adds a format allowlist and a second representation of the same bytes; a path lets the model's own file tools decide how much to read.

**Write the bytes into the session workspace through `ctx.fs`.** The filesystem seam has no binary write (`writeText` is UTF-8 text only), and the media store is not bound to one session's working directory, so this would need a new filesystem operation and a destination convention the deployment chooses.

## Consequences

The execution world decides whether an admitted file is readable: an execution filesystem that maps the harness host path serves the stored copy directly, while a remote one without a mapping gets handle text that says the copy exists and cannot be opened — `im_read_file` reports the same limitation as `skipped: 'unmapped'` instead of inventing a path. Downloading is still bounded by `media.maxItems` per message and `media.maxBytes` per element, and `media.download: false` keeps labels only.

The prompt section grew one sentence (two label shapes, two tools), and the tool catalog, subsystem page and both READMEs list `im_read_file`.
