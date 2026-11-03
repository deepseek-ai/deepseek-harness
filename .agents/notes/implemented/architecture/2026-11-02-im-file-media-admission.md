# Agent Note: IM media admission keeps non-images as verbatim files

Status: implemented

English | [中文](2026-11-02-im-file-media-admission.zh.md)

## Problem

`@deepseek-ai/dsh-experimental-im` labelled every media element of a stored message with a stable id (`[图片 #12.1]`, `[文件 #12.2 report.pdf]`, `[语音 #12.3 语音.opus]`) but could admit only the image kind: `ImMediaStore.admit` answered `skipped: 'unsupported'` for `file`, `audio` and `video`, and the only read tool, `im_read_image`, refused them the same way. A person who sent a document, a voice message or a video into a chat therefore handed the model a label it could not open — the transport, the Lark decoder and the core resource fetcher already carried the bytes (`<file src="satori:…/resources/<file_key>?type=file">`), and nothing consumed them. The `media` field's own contract already said images and files are downloaded, so the implementation was behind its documented behavior.

## Decision

Admission is by payload, not by kind. `ImMediaStore` fetches and bounds a reference exactly as before, then stores an image as a normalized image block and every other kind as the exact bytes of a durable verbatim file through `ctx.attachments.saveFile`. `ImFormatter.format({ media: true })` appends each admitted file as a `file` content block beside the text, so request assembly projects it to the deterministic handle text naming the saved read-only path — the same representation a browser-attached file gets.

The model reaches a file that is no longer in the delivered window through the new `im_read_file` tool: it resolves the label to its element, admits it as a verbatim file, and stages the bytes at `<tools.fileDir>/<seq>.<index>-<name>` under the session's working directory through `ctx.fs.writeBytes`, returning that path with the display name, byte length and content digest. The seam gained `writeBytes` for this: staging through `writeText` would have decoded and normalized the bytes, and the attachment store's host path is not reachable from a remote execution filesystem. `im_read_image` keeps its image-only contract; guidance names both tools and the two label shapes.

## Alternatives considered

**Add the read tool without admitting files eagerly.** Every new message would then cost one download less, but the model would have to ask for a file the sender just handed it, which is exactly the request shape the image path already answers without a tool call.

**Read text-like files into the tool result.** Sniffing a media type to inline text adds a format allowlist and a second representation of the same bytes; a path lets the model's own file tools decide how much to read.

**Resolve the stored attachment's host path and hand it to the model.** That is what the request projection does for a delivered `file` block, and it works only where the execution filesystem maps the harness host path — a local backend does, a remote SSH environment does not, which is exactly the deployment that needed this. Staging through the seam works wherever the provider can write bytes, and the path it returns is one the model's own file tools can open.

## Consequences

An execution filesystem must be able to store the bytes: `fs-local` writes them through the same atomic staging file as its text writes, `fs-ssh` carries them as base64 to the helper under that helper's single-frame budget (8 MiB), and a provider that keeps the base rejection makes `im_read_file` fail instead of inventing a path. A delivered file still depends on host-path mapping for the handle text, so a remote worker learns the copy exists there and stages it on demand. Staging costs a second copy of the element (the durable attachment plus the workspace file), and one id always stages to the same relative path, so a re-read overwrites instead of accumulating. Downloading is still bounded by `media.maxItems` per message and `media.maxBytes` per element, and `media.download: false` keeps labels only.

The prompt section grew one sentence (two label shapes, two tools), and the tool catalog, subsystem page and both READMEs list `im_read_file`.
