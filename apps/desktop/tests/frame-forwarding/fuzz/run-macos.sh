#!/usr/bin/env bash
# Build and run the frame-forwarding fuzz targets on macOS with libFuzzer, AddressSanitizer, and UndefinedBehaviorSanitizer.
#
# Apple clang ships no libFuzzer, so the script uses Homebrew LLVM when it is installed. It compiles against a native
# source snapshot (the directory holding transport.cc), never against a working tree, so a fuzz run is unaffected by
# edits in flight. Crashes, generated corpora, and logs stay under the work directory.
#
# Usage:
#   ./run-macos.sh --native <snapshot native directory> --work <work directory> [--max-total-time 600] [--build|--run]
#
# Passing neither --build nor --run does both.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
native_dir=""
work_dir="${TMPDIR:-/tmp}/dsh-frame-forwarding-fuzz/work"
corpus_dir="$here/corpus"
targets="packet endpoint"
max_total_time=600
do_build=0
do_run=0
cxx="${CXX:-}"

usage() {
  sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --native) native_dir="$2"; shift 2 ;;
    --work) work_dir="$2"; shift 2 ;;
    --corpus) corpus_dir="$2"; shift 2 ;;
    --targets) targets="$2"; shift 2 ;;
    --max-total-time) max_total_time="$2"; shift 2 ;;
    --build) do_build=1; shift ;;
    --run) do_run=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "run-macos.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

if [ -z "$native_dir" ]; then
  echo "run-macos.sh: --native is required" >&2
  exit 2
fi
if [ ! -f "$native_dir/transport.cc" ]; then
  echo "run-macos.sh: $native_dir does not hold transport.cc" >&2
  exit 2
fi
if [ -z "$cxx" ]; then
  cxx=clang++
  if [ -x /opt/homebrew/opt/llvm/bin/clang++ ]; then
    cxx=/opt/homebrew/opt/llvm/bin/clang++
  fi
fi
if [ "$do_build" -eq 0 ] && [ "$do_run" -eq 0 ]; then do_build=1; do_run=1; fi
mkdir -p "$work_dir"

# IOSurface and CoreFoundation hold the producer frames, and these sources take the producer's audit token from libbsm.
frameworks=(-framework IOSurface -framework CoreFoundation -lbsm)
common=(-std=c++17 -g -O1 -I"$native_dir")

if [ "$do_build" -eq 1 ]; then
  echo "building corpus-gen"
  "$cxx" "${common[@]}" -O2 "$here/corpus-gen.cc" -o "$work_dir/corpus-gen" "${frameworks[@]}"
  for target in $targets; do
    echo "building $target-fuzzer"
    "$cxx" "${common[@]}" -fsanitize=fuzzer,address,undefined -fno-sanitize-recover=undefined \
      "$here/$target-fuzzer.cc" -o "$work_dir/$target-fuzzer" "${frameworks[@]}"
  done
fi

if [ "$do_run" -eq 1 ]; then
  mkdir -p "$work_dir/logs"
  for target in $targets; do
    # Each target keeps its own corpus: a wire packet is meaningless to the credential parser and the other way round.
    corpus="$work_dir/corpus-$target"
    mkdir -p "$corpus"
    # The checked-in seeds plus the large, Mach-padded, and credential seeds the repository does not carry.
    find "$corpus_dir" -name '*.bin' -exec cp {} "$corpus" \; 2>/dev/null || true
    "$work_dir/corpus-gen" "$corpus" extras
    max_len=20000
    if [ "$target" = endpoint ]; then max_len=4096; fi
    artifacts="$work_dir/artifacts-$target"
    mkdir -p "$artifacts"
    echo "fuzzing $target for $max_total_time s; log $work_dir/logs/$target-fuzzer.log"
    "$work_dir/$target-fuzzer" "-max_total_time=$max_total_time" -timeout=10 -rss_limit_mb=2048 \
      "-max_len=$max_len" -print_final_stats=1 "-artifact_prefix=$artifacts/" "$corpus" 2>&1 \
      | tee "$work_dir/logs/$target-fuzzer.log"
  done
fi
