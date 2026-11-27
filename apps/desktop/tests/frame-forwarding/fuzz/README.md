# Frame-forwarding wire-protocol fuzz targets

English | [中文](README.zh.md)

These libFuzzer harnesses cover the native parsing code in `packages/experimental/frame-forwarding/native`. They feed arbitrary bytes to the parsers for what a producer process sends to the receiver and what a producer reads from a receiver, under AddressSanitizer on Windows and macOS and also UndefinedBehaviorSanitizer on macOS, since MSVC has no UBSan. The targets run only when started by hand; no test suite or CI job runs them.

The harnesses compile the production `transport.cc` into their own translation unit, which reaches its file-local `decode_packet` and `encode_header` without exporting them from the addon. The scripts build a source snapshot such as `git archive HEAD` output, so edits in the working tree do not change a run.

## Targets

| Source | Entry points | Checks |
| --- | --- | --- |
| `packet-fuzzer.cc` | `decode_packet` as a Windows pipe message (`padded=false`) and as a macOS Mach message (`padded=true`) | An accepted packet re-encodes with `encode_header` and decodes to the same fields, token, and text; the text ends with NUL inside its capacity unless it fills the capacity; both conventions agree whenever both accept the input. |
| `endpoint-fuzzer.cc` | `parse_endpoint`, `parse_connection`, and the identifier that `Channel::send` stamps | An accepted endpoint fits the protocol and parses back from its `1\|<pid>\|<token>\|<name>` form; an accepted connection identifier is at most 2^53-1 and parses back from its decimal form. |

A failed check prints the input in hex and aborts, so libFuzzer keeps the input as a crash artifact.

## Seed corpus

`corpus/` holds one legal packet of each kind, written by `corpus-gen.cc` with the production `encode_header`. The run scripts add seeds the repository does not store: a protocol 1 hello, a current hello that ends before the header, a message whose text fills the capacity without a terminator, and the Mach-padded form of each seed whose text length is not a multiple of 4.

## Run on Windows

Visual Studio 2022 with the C++ AddressSanitizer component provides the toolchain. From the repository root:

```powershell
$root = Join-Path $env:TEMP 'dsh-frame-forwarding-fuzz'
New-Item -ItemType Directory -Force "$root\src" | Out-Null
git archive --output "$root\src.tar" HEAD packages/experimental/frame-forwarding/native
tar -x -f "$root\src.tar" -C "$root\src"
apps/desktop/tests/frame-forwarding/fuzz/run-windows.ps1 -NativeDir "$root\src\packages\experimental\frame-forwarding\native" -MaxTotalTime 600
```

The script locates `vcvarsall.bat`, builds with `/fsanitize=address /fsanitize=fuzzer` because MSVC rejects the comma-separated form, puts the directory holding `clang_rt.asan_dynamic-x86_64.dll` on `PATH`, and runs each target with `-timeout=10 -rss_limit_mb=2048`. `-Build` or `-Run` performs one of the two steps. Binaries, the generated corpus, logs, and crash artifacts go under `%TEMP%\dsh-frame-forwarding-fuzz\work`.

## Run on macOS

Apple clang ships no libFuzzer, so the script uses Homebrew LLVM. From the repository root:

```bash
d=$(mktemp -d /tmp/dsh-frame-forwarding-fuzz.XXXXXX)
git archive HEAD packages/experimental/frame-forwarding/native | tar -x -C "$d"
CXX=/opt/homebrew/opt/llvm/bin/clang++ bash apps/desktop/tests/frame-forwarding/fuzz/run-macos.sh \
  --native "$d/packages/experimental/frame-forwarding/native" --work "$d/work" --max-total-time 600
```

The script builds with `-fsanitize=fuzzer,address,undefined -fno-sanitize-recover=undefined` and links `IOSurface`, `CoreFoundation`, and `libbsm`.

## Read a run

Each run ends with a `DONE` line and the `-print_final_stats=1` statistics. MSVC builds report features (`ft:`) only; clang builds also report covered edges (`cov:`). An input that crashes, times out, or exhausts memory is written as `crash-*`, `timeout-*`, or `oom-*` under `<work>/artifacts-<target>/`. Minimize it with:

```
<work>/<target>-fuzzer -minimize_crash=1 -timeout=10 -rss_limit_mb=2048 <work>/artifacts-<target>/crash-<hash>
```
