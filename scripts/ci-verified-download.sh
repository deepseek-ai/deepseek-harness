# shellcheck shell=bash
# Sourced by CI preparation scripts; defines functions only.

# Prints the SHA-256 digest of <file>.
#
# CI runners do not all provide the same tool: GNU coreutils ships `sha256sum`,
# while macOS ships `shasum -a 256`. Probing both keeps a missing tool from
# being reported as a digest mismatch, which would discard a verified cached
# archive and send the next run back to a possibly unavailable download host.
sha256_digest() {
  local output
  if command -v sha256sum >/dev/null 2>&1; then
    output="$(sha256sum < "$1")"
  elif command -v shasum >/dev/null 2>&1; then
    output="$(shasum -a 256 < "$1")"
  else
    echo 'No SHA-256 tool found: need sha256sum or shasum -a 256' >&2
    return 2
  fi
  printf '%s\n' "${output%% *}"
}

# Succeeds when <file> has the SHA-256 digest <sha256>. Returns 2, reporting the
# missing tool on stderr, when neither digest tool exists.
#
# Usage: verified_sha256 <sha256> <file>
verified_sha256() {
  local actual status=0
  actual="$(sha256_digest "$2")" || status=$?
  if (( status != 0 )); then
    return "$status"
  fi
  [[ "$actual" == "$1" ]]
}

# Leaves a copy of <url> whose SHA-256 digest is <sha256> at <cache-file>.
#
# A cached file with the expected digest is used without network access, so a
# restored Actions cache keeps CI independent of the download host. A cached
# file with any other digest is discarded. A download is verified before it
# replaces <cache-file> atomically, so the cache only ever holds a verified
# payload. A failed download or verification leaves nothing at <cache-file> and
# reports the URL on stderr. A missing SHA-256 tool returns 2 instead of
# treating the payload as mismatched. Each attempt is bounded so a stalled host
# fails within minutes.
#
# Usage: acquire_verified_archive <url> <sha256> <cache-file>
acquire_verified_archive() {
  local url="$1" sha256="$2" cache_file="$3" cache_dir
  cache_dir="$(dirname -- "$cache_file")"

  # Probe before the network work: a runner without a digest tool must fail
  # immediately instead of downloading a payload it cannot verify.
  sha256_digest /dev/null >/dev/null

  if [[ -f "$cache_file" ]]; then
    local cache_status=0
    verified_sha256 "$sha256" "$cache_file" || cache_status=$?
    if (( cache_status == 0 )); then
      echo "Using verified cached archive $cache_file"
      return 0
    fi
    if (( cache_status != 1 )); then
      return "$cache_status"
    fi
    echo "Discarding cached archive $cache_file: SHA-256 mismatch" >&2
    rm -f -- "$cache_file"
  fi

  if ! mkdir -p -- "$cache_dir"; then
    echo "Failed to create $cache_dir while preparing $url" >&2
    return 1
  fi
  local partial
  if ! partial="$(mktemp "${cache_file}.partial.XXXXXX")"; then
    echo "Failed to create a temporary file in $cache_dir while preparing $url" >&2
    return 1
  fi
  # A cancelled job must not leave a partial payload in the directory that
  # actions/cache/save uploads.
  trap 'rm -f -- "$partial"' EXIT

  if ! curl --fail --silent --show-error --location \
    --connect-timeout 15 --max-time 60 \
    --retry 8 --retry-all-errors --retry-max-time 240 \
    --output "$partial" "$url"; then
    rm -f -- "$partial"
    trap - EXIT
    echo "Failed to download $url and no verified cached copy exists at $cache_file" >&2
    return 1
  fi
  local download_status=0
  verified_sha256 "$sha256" "$partial" || download_status=$?
  if (( download_status != 0 )); then
    rm -f -- "$partial"
    trap - EXIT
    if (( download_status != 1 )); then
      return "$download_status"
    fi
    echo "Downloaded $url does not have SHA-256 $sha256" >&2
    return 1
  fi
  mv -f -- "$partial" "$cache_file"
  trap - EXIT
}
