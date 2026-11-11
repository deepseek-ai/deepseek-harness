# shellcheck shell=bash
# Sourced by CI preparation scripts; defines functions only.

# Succeeds when <file> has the SHA-256 digest <sha256>.
#
# Usage: verified_sha256 <sha256> <file>
verified_sha256() {
  local actual
  actual="$(sha256sum < "$2")" || return 1
  [[ "${actual%% *}" == "$1" ]]
}

# Leaves a copy of <url> whose SHA-256 digest is <sha256> at <cache-file>.
#
# A cached file with the expected digest is used without network access, so a
# restored Actions cache keeps CI independent of the download host. A cached
# file with any other digest is discarded. A download is verified before it
# replaces <cache-file> atomically; on failure nothing is left at
# <cache-file> and the function reports the URL on stderr and returns 1.
# Each attempt is bounded so a stalled host fails within minutes.
#
# Usage: acquire_verified_archive <url> <sha256> <cache-file>
acquire_verified_archive() {
  local url="$1" sha256="$2" cache_file="$3"
  if [[ -f "$cache_file" ]]; then
    if verified_sha256 "$sha256" "$cache_file"; then
      echo "Using verified cached archive $cache_file"
      return 0
    fi
    echo "Discarding cached archive $cache_file: SHA-256 mismatch" >&2
    rm -f -- "$cache_file"
  fi

  mkdir -p -- "$(dirname -- "$cache_file")"
  local partial
  partial="$(mktemp "${cache_file}.partial.XXXXXX")"
  if ! curl --fail --silent --show-error --location \
    --connect-timeout 15 --max-time 60 \
    --retry 8 --retry-all-errors --retry-max-time 300 \
    --output "$partial" "$url"; then
    rm -f -- "$partial"
    echo "Failed to download $url and no verified cached copy exists at $cache_file" >&2
    return 1
  fi
  if ! verified_sha256 "$sha256" "$partial"; then
    rm -f -- "$partial"
    echo "Downloaded $url does not have SHA-256 $sha256" >&2
    return 1
  fi
  mv -f -- "$partial" "$cache_file"
}
