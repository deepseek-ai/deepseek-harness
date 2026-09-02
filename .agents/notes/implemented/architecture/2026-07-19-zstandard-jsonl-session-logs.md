# Agent Note: Zstandard JSONL session logs

Status: implemented

English | [中文](2026-07-19-zstandard-jsonl-session-logs.zh.md)

## Problem

The JSONL persistence backend keeps every `SessionEvent` verbatim, including high-volume `assistant/chunk` records. Raw text makes logs inspectable but spends storage and I/O on repeated JSON keys and model text. Compression must retain the existing append/fsync commit boundary, collision-safe first materialization, crash repair, and metadata-only listing; rewriting a whole compressed file after every turn would discard those properties.

The encoding also has to remain explicit at the deployment boundary. Snapshot fixtures and external line readers require raw JSONL, while a backend cannot safely guess between compressed and raw artifacts in one root or silently migrate pre-release session data.

## Decision

### Configuration and suffix ownership

`dsh-session-persistence-jsonl` accepts `compression?: 'zstd' | 'none'` and explicitly resolves omission to `'zstd'`. Zstandard artifacts end in `.jsonl.zstd`; `'none'` retains the original newline-delimited UTF-8 `.jsonl` representation. `SessionLocation.kind` remains `'jsonl'`, because both encodings carry the same logical record format, and `SESSION_FORMAT_VERSION` remains `0` under the repository's pre-release reject-without-migration policy.

Each persistence root belongs to one encoding. A one-time discovery preflight rejects any opposite suffix, and targeted load, live-adoption, listing, and materialization paths repeat the relevant suffix check after an initially empty preflight. The error names the incompatible artifact and directs the deployment to the matching configuration or a separate root. There is no migration, dual read, dual write, or extension-based fallback.

### Frame and write path

The compressed artifact is a standard concatenation of independent [Zstandard frames](https://datatracker.ietf.org/doc/html/rfc8878): one checksummed frame containing exactly the header line, followed by one checksummed frame for every durable append batch. Normal loop batches are turn commits, so frame boundaries preserve the existing persistence checkpoint without making the storage layer depend on turn event types.

Compression uses Node's built-in [`zstdCompress` and `zstdDecompress`](https://nodejs.org/download/release/v22.19.0/docs/api/zlib.html), available at the repository's Node 22.19 floor. The backend enables `ZSTD_c_checksumFlag`, otherwise accepts Node's defaults, and exposes neither a compression-level knob nor a new dependency. The API is marked experimental by Node, so the Node 22.19, 24, and 26 compatibility gate exercises the exact helper.

First materialization compresses the two initial frames before opening the temporary file, then writes and `fsync`s that file. POSIX publishes it through a collision-safe hard link and directory `fsync`; Windows publishes it without replacement through `MoveFileExW(..., MOVEFILE_WRITE_THROUGH)`. Later batches are compressed before opening the destination and appended at EOF. A caught write or file-sync failure closes the append handle, reopens the log read/write, truncates to the prior byte length, syncs the rollback, and rethrows so the coordinator can retry the unchanged batch on both platforms.

### Read, listing, and crash recovery

A frame-boundary scanner reads the standard magic, variable header fields, block headers and payload sizes, and optional checksum trailer. It does not interpret compressed blocks. Complete frames are independently checksum-validated and passed through the [large-session restore pipeline](2026-08-05-large-session-jsonl-restore-pipeline.md), which owns decoder reuse, cooperative yielding, and incremental JSONL scanning. A checksum/decompression failure in any complete frame, a malformed complete-frame JSONL tail, or invalid frame structure is corruption and rejects.

Listing reads in bounded chunks only until the first complete frame is available, validates and decompresses that header frame, and never reads an event frame. The dedicated header frame therefore preserves metadata-only listing even for very large session logs.

EOF inside the final frame is a torn tail. The frame belongs to an append that never resolved, so none of its records were acknowledged durable: repair truncates from that frame's starting byte, retains all prior complete frames, and appends the coordinator's synthetic tool, step, and turn closers as one new checksummed frame ([export and pre-release trims](../simplification/2026-08-27-persistence-export-and-pre-release-trims.md) owns dropping the earlier partial-plaintext salvage).

### Consumers and verification

The CLI, ACP, and stdio app bundles expose symmetric `persistenceCompression` pass-through configuration. The web host assembly and ordinary app compositions omit the option and use the compressed default. Snapshot recording and replay compositions select `'none'` explicitly because committed fixtures are raw JSONL inputs to replay and normalization.

The shared persistence and coordinator contracts run against both encodings. Backend tests cover standard framing and checksum interoperability, header-only listing, append rollback, encoding mismatch rejection, complete-frame corruption, and final-frame tears through headers, blocks, and checksum trailers. Default runtime, built-bin, headless, ACP, and Python smokes assert the compressed suffix and Zstandard magic or decode the header; raw-content tests opt out explicitly.

## Alternatives considered

- **One frame per JSONL record** — rejected because it multiplies frame headers and checksums for high-volume chunk events and makes a physical boundary unrelated to the durable append batch.
- **Rewrite one whole compressed stream after every append** — rejected because cost grows with log size and replacement would give up append/fsync rollback and the established collision-safe materialization mechanics.
- **Use a streaming compressor across appends** — rejected because an interrupted encoder state does not leave independently checksummed append units, complicating bounded listing and frame-start repair.
- **Add an external native Zstandard dependency** — rejected because the supported Node floor already provides the required codec; another native artifact would enlarge installation and executable-packaging risk without adding a required behavior.
- **Expose compression level or keep raw JSONL as the default** — rejected because there is no deployment evidence for a second tuning policy, while `'none'` preserves the line-readable path for fixtures and integrations that need it.

## Consequences

- Ordinary session roots store `.jsonl.zstd` and retain append-only, fsync, rollback, and interrupted-turn recovery semantics.
- Raw JSONL remains a deliberate configuration, but changing encoding requires a fresh/separate root or selecting the mode that matches existing artifacts.
- One frame per durable batch adds bounded framing/checksum overhead and allows header-only listing plus repair from an exact append boundary.
- External tools must understand concatenated Zstandard frames or consume raw-mode artifacts; generic one-shot Node decompression reads only the first independent frame, so backend reads walk frames through the [restore pipeline](2026-08-05-large-session-jsonl-restore-pipeline.md).
- The implementation depends on Node's experimental built-in Zstandard API without an npm dependency; the supported-version compatibility gate makes drift visible.
