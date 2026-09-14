---
name: record-browser-gif
description: Record browser or Web UI interaction demos as optimized GIFs using the available browser-control workflow, optional Playwright Videos for higher capture frame rates, and deterministic encoding, then attach the GIF to a pull request with `gh --attach`, falling back to a dedicated assets branch where attach cannot apply. Use when asked to make, record, or generate a GIF that demonstrates a browser workflow, and for every pull request that changes product-user-visible GUI behavior, which MUST include a GIF recorded from the pull request's real server and model flow.
---

# Record Browser GIF

Produce a short, truthful UI demonstration as a local GIF, and — only when the task includes attaching it to a pull request — publish it through the attach workflow at the end of this skill. The available browser-control workflow remains preferred. Use [Playwright Videos](https://playwright.dev/docs/videos) when that workflow supports continuous capture at higher frame rates; use the bundled encoder for trimming, playback speed, final hold, dimensions, and size.

The [evidence-chain decision](../../notes/implemented/process/2026-08-08-browser-gif-evidence-chain.md) owns why one storyboard comes from one isolated run and why publication revalidates both the artifact and the demonstrated pull-request head.

## Every GUI pull request includes a GIF

A pull request that changes product-user-visible GUI behavior MUST include a demonstration GIF recorded with this skill and embedded in the pull request body via [the attach workflow](#publish-the-gif).

The recording itself is part of the evidence: use a real server booted from that pull request's branch tree, a real API key, and real model rounds. Never substitute fixture queries, mock transports, synthetic event injection, or test-only hooks unless the user explicitly asked for a fixture recording. Next to the embed, state the exact demonstrated commit SHA, the tree and origin that served it, any mode flags or browser-state exceptions, and whether a real model round ran, so reviewers know exactly what the recording proves.

## Keep recording separate from publication

- Recording produces local video or screenshots and one `.gif` artifact only; it never mutates remote state.
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

Follow the available browser-control workflow's setup, interaction, and cleanup instructions. When it exposes `recordVideo`, enable video on the same controlled context to capture more intermediate frames. Otherwise use [screenshot capture](#screenshot-capture) within that workflow; video availability does not determine which browser-control workflow to use. Existing user browser state remains an explicit isolation exception.

Only when browser control is unavailable, use the repository-declared Playwright dependency in an isolated headless browser and state that fallback in the capture notes. In this repository it resolves from `apps/web/package.json`; do not install another driver or open the user's browser.

Before recording, identify the origin, built or development server, transport, and any mode overrides. When a production default opens a native surface that automation cannot drive, select an official browser-operable production backend through normal application configuration and disclose the override.

Store the script, raw video, timing notes, QA frames, and GIF under the repository's gitignored `.playwright-mcp/` directory. Create the run directory first.

### Capture video

Match `viewport` and `recordVideo.size` explicitly: Playwright otherwise scales the video down to fit 800×800, which can make UI text unreadable.

Configure video through the chosen browser-control workflow. The standalone Playwright fallback uses:

```js
const { chromium } = createRequire(join(repo, 'apps/web/package.json'))('playwright')
const browser = await chromium.launch()
const size = { width: 1440, height: 900 }
const context = await browser.newContext({
  viewport: size,
  recordVideo: { dir: join(runDir, 'videos'), size },
})
try {
  const page = await context.newPage()
  const video = page.video()
  // Navigate and exercise the real application here.
  await context.close()
  await video.saveAs(join(runDir, 'demo.webm'))
} finally {
  await context.close()
  await browser.close()
}
```

Import `createRequire` from `node:module` and `join` from `node:path`; set `repo` and a fresh `runDir` to absolute paths in the recording script. Retain the page's video handle before closing it. Await `context.close()` before `video.saveAs()` or encoding; closing only the browser does not guarantee the video's flush. Each page has its own video: choose the demonstrated page explicitly and do not concatenate unrelated pages or runs. Failed runs are diagnostic only.

Choose a short story with three to six meaningful states. Wait for unique semantic locators before acting; use `exact: true` for accessible-name equality and exact-text completion predicates that cannot match a prompt echo. Fixed waits may provide a reading hold after the state is verified, but never establish readiness. When capturing video, preserve animations and scrolling.

When demonstrating a tool call, rejection, or recovery, open its detail or trajectory so the video shows the tool identity, status or stable error code, and downstream result. If a transient running state matters, prompt for a slow foreground operation and observe its concrete DOM marker; continuous video captures its intermediate frames. Give the model a short final sentinel to anchor completion. Stop an unnecessarily long real-API run after the demonstrated state is visible.

Capture no secrets, personal data, unrelated tabs, or notifications. Browser video contains page content, not browser chrome; avoid rendering credential-bearing URLs in the application. Review the whole selected interval, including intermediate states. Keep one viewport throughout.

## Encode the GIF

Require `python3`, `ffmpeg`, and `ffprobe`. If a media binary is missing, report the dependency instead of installing software without authorization. Export `GIF_SKILL_DIR` on its own line before using it; an inline assignment cannot affect argument expansion in the same command.

```sh
export GIF_SKILL_DIR=/absolute/path/to/this/skill
python3 "$GIF_SKILL_DIR/scripts/encode_gif.py" \
  /absolute/path/to/demo.webm \
  /absolute/path/to/demo.gif \
  --start 2 --end 32 --speed 2 --final-hold 3 \
  --fps 10 --max-width 1200 --colors 128
```

`--start` and `--end` select one continuous source interval in seconds. Defaults retain the full video at 1× speed and add a two-second final hold. `--speed` changes playback speed; disclose it and the selected interval beside the GIF so the demo cannot imply measured response latency. Use observed video times, not guessed wall-clock offsets, and preserve the complete cause and outcome of the demonstrated behavior. The final hold repeats the last selected frame. `--fps` sets the encoded GIF frame rate; increasing it cannot recover motion that the source recording did not capture. Keep the original WebM for QA; do not splice separate runs or synthesize missing states.

The encoder probes WebM container duration, applies trim and speed before palette conversion, and checks encoded duration, animation, width, and byte size. It refuses an empty or out-of-range interval, a selection shorter than two output frames, mode-inappropriate flags, and accidental overwrite. Reduce `--max-width`, then `--colors` or `--fps` for a large artifact; preserve readable text. Use `--force` only after resolving the exact output path.

### Screenshot capture

When continuous video is unavailable or the user requests a storyboard, follow the available browser-control workflow. Capture three to six verified states from one isolated run with the browser's screenshot API. Save returned image bytes directly under one run directory as `00-initial.png`, `01-typed.png`, and so on; use identical dimensions and crop. For a transient state, poll its DOM marker and capture within the same browser-script call.

```sh
python3 "$GIF_SKILL_DIR/scripts/encode_gif.py" \
  /absolute/path/to/frames /absolute/path/to/demo.gif \
  --durations 1.5,1.5,1.5,3.5 --fps 10 --max-width 1200 --colors 128
```

One duration applies to every screenshot; otherwise supply one positive duration per frame and hold the settled state longest. Directory input rejects fewer than two frames and mismatched dimensions or duration counts. Video timing flags apply only to video files; `--durations` and `--pattern` apply only to screenshot directories.

## Verify the artifact

1. Read the encoder's JSON summary and confirm the output path, source interval and speed (or screenshot count), encoded frame count, dimensions, duration, and byte size.
2. Visually read the encoded GIF itself, not only the source frames. Confirm that the transition is legible, the last state is held long enough, and no sensitive content appears. If the viewer renders only the first frame, decode representative frames from the encoded GIF with `ffmpeg` and inspect those; the pre-encode screenshots do not prove the encoded order, palette, or final hold.
3. Run `git status --short` and confirm raw video, QA frames, and the artifact landed only under ignored paths.
4. Return the absolute GIF path, render it when the client supports local media, and state whether the recording used a real API, fixture, or another transport. When the task does not include attaching the GIF to a pull request, stop here.

Encoder maintenance: run `python3 -m unittest discover -s "$GIF_SKILL_DIR/scripts" -p 'test_*.py' -v` with the media prerequisites installed. These local media tests do not run in repository CI.

## Publish the GIF

Perform this step only when the task includes attaching the GIF to a pull request.

Never commit a GIF to the pull request's own branch or any branch that merges into a long-lived branch: binary media committed there bloats the repository history for every future clone. Prefer `gh --attach`, which uploads the GIF to GitHub and rewrites the body reference in one command, so no branch carries the media.

### Attach with gh

`gh --attach` requires `gh` v2.99.0 or later (`gh --version`), a repository on github.com — GitHub Enterprise Server is not supported — write access to the repository, and a GIF at or below 10 MB. Confirm the verified artifact fits that limit; when it does not, shrink it with `--max-width`, then `--colors` or `--fps`, before attaching.

Write the GIF into the body file as an ordinary local-path reference, using the same path passed to `--attach`; `gh` rewrites the reference in place to the uploaded URL, keeping its position and alt text:

```markdown
![<alt text>](<path/to/demo.gif>)
```

The demonstrated pull request is normally the publication target. A tooling pull request may instead embed a clearly labeled example from another pull request; name that source PR and compare its live head in every check below. Never attribute the example to the tooling branch.

Immediately before attaching, re-read the demonstrated pull request's live head — for a new demonstrated pull request, the pushed branch tip — and compare it with the commit recorded next to the GIF. Stop and re-record when it moved. Then attach:

```sh
gh pr create --body-file <body.md> --attach <path/to/demo.gif>     # new pull request
gh pr edit <pr> --body-file <body.md> --attach <path/to/demo.gif>  # existing pull request
```

`--attach` is repeatable but refuses the same file twice. A GIF the body does not reference is appended at the end, where alt text set on the flag (`--attach '<path>#<alt text>'`) applies; a rewritten reference keeps the body's alt text. After attaching, re-read the demonstrated live head and require it to remain at that recorded commit. Re-read the live body and confirm the reference now points at the uploaded URL, render the body through GitHub's Markdown API and confirm the expected `<img>`, and fetch the uploaded URL once to confirm `200` and `image/gif`.

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

Immediately before editing the pull-request body, re-read the demonstrated pull request's live head and compare it with the commit recorded next to the GIF. Stop and re-record when it moved. After the edit, re-read the demonstrated live head and require it to remain at that recorded commit. Separately, render the body through GitHub's Markdown API and confirm that the expected `<img>` is present.

Embed the GIF in the pull request body with the raw blob URL; the `?raw=true` suffix is required, because the plain blob URL renders GitHub's file page instead of the image:

```markdown
![<alt text>](https://github.com/<owner>/<repo>/blob/<assets-branch>/<name>.gif?raw=true)
```

Never delete or rewrite an assets branch, and never force-push it: merged pull request bodies reference its URLs forever. Append new commits only.
