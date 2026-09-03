---
name: record-browser-gif
description: Record browser or Web UI interaction demos as optimized GIFs using the available built-in browser, state-based frame capture, and deterministic encoding, then attach the GIF to a pull request with `gh --attach`, falling back to a dedicated assets branch where attach cannot apply. Use when asked to make, record, or generate a GIF that demonstrates a browser workflow, and for every pull request that changes product-user-visible GUI behavior, which MUST include a GIF recorded from the pull request's real server and model flow.
---

# Record Browser GIF

Produce a short, truthful UI demonstration as a local GIF, and — only when the task includes attaching it to a pull request — publish it through the attach workflow at the end of this skill. Use the browser-control skill for interaction and the bundled encoder for repeatable timing, dimensions, and size.

The [evidence-chain decision](../../notes/implemented/process/2026-08-08-browser-gif-evidence-chain.md) owns why one storyboard comes from one isolated run and why publication revalidates both the artifact and the demonstrated pull-request head.

## Every GUI pull request includes a GIF

A pull request that changes product-user-visible GUI behavior MUST include a demonstration GIF recorded with this skill and embedded in the pull request body via [the attach workflow](#publish-the-gif).

The recording itself is part of the evidence: use a real server booted from that pull request's branch tree, a real API key, and real model rounds. Never substitute fixture queries, mock transports, synthetic event injection, or test-only hooks unless the user explicitly asked for a fixture recording. Next to the embed, state the exact demonstrated commit SHA, the tree and origin that served it, any mode flags or browser-state exceptions, and whether a real model round ran, so reviewers know exactly what the recording proves.

## Keep recording separate from publication

- Recording produces frame images and one local `.gif` artifact only; it never mutates remote state.
- Publication — attaching the GIF to a pull request body with `gh --attach`, or pushing it to an assets branch and embedding its URL where attach cannot apply — is the separate final step, performed only when the task includes attaching the GIF to a pull request. It never touches the pull request's own branch.
- Preserve the requested recording conditions. A real-server or real-API demo must not use fixture queries, mock transports, synthetic event injection, or test-only hooks. If credentials or the server are unavailable, report that limitation instead of substituting a fixture.
- Never read or expose credential values. Use the application's normal configuration path and a benign demonstration prompt.

## Stage the application

A GIF for a specific pull request demonstrates that pull request's tree, so stage per pull request:

1. Require a clean worktree, record its exact commit with `git rev-parse HEAD`, then build that recorded tree — here, `pnpm run build && pnpm run build:web`. A GIF recorded against another commit's build misattributes the evidence.
2. Boot one server per port from that tree with fresh scratch `DSH_HOME`, `DSH_AGENTS_HOME`, workspace, and session state. Give the browser a fresh isolated context or profile as well; if the browser workflow cannot create one, clear that origin's cookies and site storage before navigation so persisted client state cannot affect the evidence. Source the root `.env` for the API key through the application's normal path; never echo the key.
3. Treat one storyboard as one evidence run: every published frame comes from that server and those state roots, workspace, session, and model-backed scenario run. If capture automation fails, discard its frames and rerun from fresh roots; never splice frames from separate runs.
4. When switching between pull requests, stop the old server by PID or an exact match on its command line. A broad `pkill -f` pattern can match and kill the shell that launched it — including your own.

## Record the flow

1. Invoke the available browser-control skill and follow its setup, interaction, and cleanup instructions. Use the user's existing Chrome state only when requested or required; state that exception in the provenance and do not claim fresh client state. If browser control is unavailable, use the repository-declared Playwright dependency in an isolated headless browser; do not install another driver or launch the user's browser. State that fallback in the provenance.
2. Before recording, identify the exact origin, whether the app is built or in development, the transport, and any fixture or mock mode. Record only claims that the observed setup supports.
3. When a production default opens a native operating-system surface that headless automation cannot drive, select an official browser-operable production backend through the application's normal configuration. State the override in the provenance; a fixture, mock transport, or test-only hook is not an acceptable substitute.
4. Choose three to six states that tell one story, such as typed, running, settled, and detail. Prefer semantic state changes over continuous capture; omit loading churn that does not help the viewer.
5. Keep one viewport and crop for every frame, and name frames lexically: `00-initial.png`, `01-typed.png`, and so on.
6. Store frames under the repository's gitignored `.playwright-mcp/` directory — browser-tool screenshots can only be written under the tool's allowed roots, and relative filenames resolve against the repository root. Create the frame subdirectory first (`mkdir -p .playwright-mcp/gif-frames-<label>`); writing into a missing directory fails with ENOENT at capture time.
7. Before each screenshot, wait for a concrete UI condition such as a unique label, enabled control, changed document title, or completed response. Require the locator to resolve exactly one element; for Playwright accessible-name locators, use `exact: true` when equality is intended because descendant text or a prompt echo can otherwise create a false match. Do not use a fixed delay as proof that the application reached the state.
8. Make completion predicates match an exact-text element — for example, an element whose trimmed text equals the expected reply — never a substring check such as `body.textContent.includes(...)`, which the echo of the user's own prompt also satisfies.
9. When the claim involves a tool call, rejection, or recovery, include a detail or trajectory frame that shows the tool identity, status or stable error code, and the downstream result. A chat-only outcome does not prove why the tool path behaved that way.
10. Capture a transient state (spinner, running row) by driving a slow foreground operation — for example, a `sleep 15` bash command — and polling a concrete DOM marker (a `data-*` attribute) inside one browser-script call that also takes the screenshot. State polled across separate tool calls is lost, because the turn settles between calls.
11. Engineer the prompt so the state you need actually occurs: instruct the model to wait in the foreground when it would otherwise background a slow command, and give it a settle sentinel such as "reply with the single word done" to anchor the completion predicate.
12. Capture no secrets, personal data, unrelated tabs, or transient notifications. Stop any unnecessarily long real-API run after the demonstrated state is visible.

Use the browser's own screenshot API. When it returns image bytes, save those bytes directly; the encoder detects image content independently of the filename extension.

## Encode the GIF

Require `python3`, `ffmpeg`, and `ffprobe`. If either media binary is missing, report the dependency instead of installing software without authorization.

Export `GIF_SKILL_DIR` as this skill's absolute directory on its own line before the python command — an inline `GIF_SKILL_DIR=... python3 "$GIF_SKILL_DIR/..."` assignment fails, because the argument expands before the assignment takes effect:

```sh
export GIF_SKILL_DIR=/absolute/path/to/this/skill
python3 "$GIF_SKILL_DIR/scripts/encode_gif.py" \
  /absolute/path/to/frames \
  /absolute/path/to/demo.gif \
  --durations 1.5,1.5,1.5,3.5 \
  --fps 10 \
  --max-width 1200 \
  --colors 128
```

One duration applies to every frame; otherwise provide one comma-separated positive duration per frame, holding the final settled state longest. The encoder rejects fewer than two frames, mismatched dimensions or durations, invalid limits, accidental overwrite, unexpected duration, and output above `--max-bytes`.

For a large artifact, reduce `--max-width` first, then `--colors` or `--fps`; retain readable text and the final state long enough to inspect. Use `--force` only after resolving the exact output path.

## Verify the artifact

1. Read the encoder's JSON summary and confirm the output path, source and encoded frame counts, dimensions, duration, and byte size.
2. Visually read the encoded GIF itself, not only the source frames. Confirm that the transition is legible, the last state is held long enough, and no sensitive content appears. If the viewer renders only the first frame, decode representative frames from the encoded GIF with `ffmpeg` and inspect those; the pre-encode screenshots do not prove the encoded order, palette, or final hold.
3. Run `git status --short` and confirm frames and the artifact landed only under ignored paths.
4. Return the absolute GIF path, render it when the client supports local media, and state whether the recording used a real API, fixture, or another transport. When the task does not include attaching the GIF to a pull request, stop here.

## Publish the GIF

Perform this step only when the task includes attaching the GIF to a pull request.

Never commit a GIF to the pull request's own branch or any branch that merges into a long-lived branch: binary media committed there bloats the repository history for every future clone. Prefer `gh --attach`, which uploads the GIF to GitHub and rewrites the body reference in one command, so no branch carries the media.

### Attach with gh

`gh --attach` requires `gh` v2.99.0 or later (`gh --version`), a repository on github.com — GitHub Enterprise Server is not supported — write access to the repository, and a GIF at or below 10 MB. Confirm the verified artifact fits that limit; when it does not, shrink it with `--max-width`, then `--colors` or `--fps`, before attaching.

Write the GIF into the body file as an ordinary local-path reference, using the same path passed to `--attach`; `gh` rewrites the reference in place to the uploaded URL, keeping its position and alt text:

```markdown
![<alt text>](<path/to/demo.gif>)
```

Immediately before attaching, re-read the pull request's live head — for a new pull request, the pushed branch tip — and compare it with the commit recorded next to the GIF. Stop and re-record when it moved. Then attach:

```sh
gh pr create --body-file <body.md> --attach <path/to/demo.gif>     # new pull request
gh pr edit <pr> --body-file <body.md> --attach <path/to/demo.gif>  # existing pull request
```

`--attach` is repeatable but refuses the same file twice. A GIF the body does not reference is appended at the end, where alt text set on the flag (`--attach '<path>#<alt text>'`) applies; a rewritten reference keeps the body's alt text. After attaching, re-read the live head and require it to remain at that recorded commit. Re-read the live body and confirm the reference now points at the uploaded URL, render the body through GitHub's Markdown API and confirm the expected `<img>`, and fetch the uploaded URL once to confirm `200` and `image/gif`.

### Fall back to an assets branch

Use the assets-branch workflow only when `gh --attach` cannot apply: the GIF still exceeds 10 MB, `gh` is older than v2.99.0, or the repository is not on github.com. GIFs then live on a dedicated orphan assets branch — a branch with no parent commit and nothing but media — and one assets branch serves a whole pull request series (named `<series>-assets`; list existing ones with `git ls-remote --heads origin '*assets*'`).

Before either workflow below pushes, verify that the assets branch contains media only and that the staged GIF's checksum matches the verified local artifact.

For an existing assets branch, work in a shallow single-branch scratch clone so the publication cannot touch your working tree:

```sh
git clone --branch <assets-branch> --single-branch --depth 1 <repo-url> /tmp/assets-checkout
cp /absolute/path/to/demo.gif /tmp/assets-checkout/<name>.gif
cd /tmp/assets-checkout
git add <name>.gif
git commit -m "assets: <what it shows> gif (#<pr>)"
git push origin <assets-branch>
```

For a new series, make a fresh shallow scratch clone (`git clone --depth 1 <repo-url> /tmp/assets-checkout`), create the orphan branch with `git switch --orphan <assets-branch>`, then add the GIF, commit, and push the same way.

After pushing, use authenticated GitHub API or raw requests to confirm the remote path, byte size, checksum, `200` response, and `image/gif` content type. An anonymous `404` does not disprove a private-repository asset; authenticate the verification instead. This proves the repository-member review path, not public availability.

Immediately before editing the pull-request body, re-read its live head and compare it with the commit recorded next to the GIF. Stop and re-record when it moved. After the edit, re-read the live head and require it to remain at that recorded commit. Separately, render the body through GitHub's Markdown API and confirm that the expected `<img>` is present.

Embed the GIF in the pull request body with the raw blob URL; the `?raw=true` suffix is required, because the plain blob URL renders GitHub's file page instead of the image:

```markdown
![<alt text>](https://github.com/<owner>/<repo>/blob/<assets-branch>/<name>.gif?raw=true)
```

Never delete or rewrite an assets branch, and never force-push it: merged pull request bodies reference its URLs forever. Append new commits only.
