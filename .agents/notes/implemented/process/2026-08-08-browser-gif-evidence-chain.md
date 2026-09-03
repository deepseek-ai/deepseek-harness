# Agent Note: Browser GIFs preserve one evidence chain

Status: implemented

English | [中文](2026-08-08-browser-gif-evidence-chain.zh.md)

## Problem

A browser-demo storyboard can contain individually truthful screenshots without proving one truthful execution. Reusing global application state can admit old settings or sessions, capture automation can accidentally combine frames from separate model runs, and a chat transcript can show a successful fallback without exposing the tool rejection that caused it. Fuzzy accessible-name matching can also accept prompt echoes or descendant text instead of the intended result.

Headless production recording has two further boundaries. A product default may open a native operating-system surface that automation cannot drive, while replacing that surface with a mock or test hook would mean the GIF no longer shows the production path. After publication, a successful upload or push does not prove that the uploaded asset is reachable and intact on the review path, or that GitHub recognizes the pull-request Markdown as an image.

## Decision

The [`record-browser-gif`](../../../skills/record-browser-gif/SKILL.md) workflow treats one storyboard as one evidence chain pinned to an exact pull-request head. Before building, it requires a clean worktree and records that commit SHA. Each run uses fresh `DSH_HOME`, `DSH_AGENTS_HOME`, workspace, session, and isolated browser state, and every published frame comes from the same server and model-backed scenario run. When a fresh browser context is unavailable, the exact origin's cookies and site storage are cleared before navigation. Existing user browser state is used only when requested or required, is stated next to the GIF, and does not substantiate fresh client state. A failed capture run is discarded and repeated from fresh roots rather than combined with another run.

Browser automation waits for unique, exact semantic states. When the claim concerns a tool call, rejection, or recovery, the storyboard includes a detail or trajectory frame that identifies the tool, shows its status or stable error code, and shows the downstream result. The final encoded GIF remains the verification subject; when a viewer cannot animate it, representative frames are decoded from that GIF instead of treating source screenshots as equivalent evidence.

The available browser-control workflow remains preferred. When it is unavailable, the recorder uses the repository-declared Playwright dependency in an isolated headless browser rather than installing another driver or opening the user's browser. A native production surface may be replaced only through normal application configuration with an official browser-operable production backend, and that override is stated next to the GIF. Fixtures, mock transports, synthetic events, and test-only hooks do not substantiate a real-production claim.

Publication verifies the boundary again. The preferred path attaches with `gh --attach` (v2.99.0 or later; github.com only; at most 10 MB): the body file references the local GIF path, the command uploads the verified artifact and rewrites that reference in place, and the live body must then show the rewritten uploaded URL, which must respond with `200` and `image/gif`. When attach cannot apply — the GIF exceeds 10 MB, `gh` is older, or the repository is GitHub Enterprise Server — the assets-branch path remains: the branch contains media only, the staged and published bytes match the verified artifact, and a private-repository asset is checked through authenticated API or raw requests for its path, byte size, checksum, response status, and media type, proving only the repository-member review path (the [documentation-site image decision](2026-08-06-doc-site-carries-its-images.md) owns why a public site cannot depend on a private raw URL). Immediately before the pull-request body changes, the live head must still equal the recorded head. After the edit, the live head is checked again and must remain at that recorded value; GitHub's Markdown renderer separately must produce the expected image.

## Alternatives considered

**Allow frames from separate runs when their visible states look equivalent.** Visual similarity does not establish shared state, causal order, or one scenario execution. Re-recording costs another real round but preserves the claim the storyboard makes.

**Use the chat transcript as sufficient proof of tool recovery.** A final answer proves that the task completed, but it can hide which tool ran, whether the failure was structured, and whether the model recovered from that failure. A trajectory or detail frame carries those facts directly.

**Replace inaccessible native UI with a fixture or test hook.** That makes automation easier by changing the product path under observation. Selecting an official production backend through normal configuration keeps the exercised implementation real and makes the narrower mode explicit.

**Trust a successful upload or push.** An upload or push proves only that GitHub accepted the bytes, not that the body reference points at the uploaded asset or that the Markdown renders the image. Re-reading the live body and rendering it through GitHub's Markdown API test the two publication boundaries reviewers use.

## Consequences

GUI evidence now establishes one causal execution rather than a collage of plausible states, and reviewers can inspect both a structured tool failure and the completed result. Publication detects stale pull-request heads, corrupted or misplaced media, and invalid image Markdown before the body is treated as finished.

The workflow spends additional scratch state, may repeat a real model round after a capture failure, and usually adds a detail frame plus publication checks — live head and body re-reads, Markdown rendering, and an uploaded-URL fetch; the assets-branch path adds its authenticated asset checks. Headless recordings can use fewer production backends than an interactive desktop, and every selected backend is stated next to the GIF.
