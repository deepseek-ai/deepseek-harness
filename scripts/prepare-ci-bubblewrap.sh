#!/usr/bin/env bash
set -euo pipefail

# Ubuntu's package transaction scans the hosted image's full dpkg database and
# runs post-install hooks. CI needs only the signed-archive payload, so pin and
# verify that payload before extracting it into the ephemeral runner directory.
# This amd64 build needs glibc 2.38+ and Linux 5.10+; Ubuntu 24.04 satisfies both.
readonly BUBBLEWRAP_VERSION='0.12.0-1'
readonly BUBBLEWRAP_SHA256='db4d572a7927bfd34cc9b8e24b56983efa8e0483d03da6c810f6caae081dcc36'
# The recorded build remains addressable after Ubuntu prunes its live package pool.
readonly BUBBLEWRAP_URL="https://launchpad.net/ubuntu/+source/bubblewrap/${BUBBLEWRAP_VERSION}/+build/33546835/+files/bubblewrap_${BUBBLEWRAP_VERSION}_amd64.deb"

: "${RUNNER_TEMP:?prepare-ci-bubblewrap requires RUNNER_TEMP}"
: "${GITHUB_PATH:?prepare-ci-bubblewrap requires GITHUB_PATH}"

if [[ "$(uname -s)" != 'Linux' || "$(uname -m)" != 'x86_64' ]]; then
  echo 'prepare-ci-bubblewrap supports only Linux x86_64 hosted runners' >&2
  exit 1
fi

archive="${RUNNER_TEMP}/bubblewrap_${BUBBLEWRAP_VERSION}_amd64.deb"
root="${RUNNER_TEMP}/dsh-bubblewrap"

curl --fail --silent --show-error --location --retry 3 --retry-all-errors --output "$archive" "$BUBBLEWRAP_URL"
printf '%s  %s\n' "$BUBBLEWRAP_SHA256" "$archive" | sha256sum --check --status
mkdir -p "$root"
dpkg-deb --extract "$archive" "$root"
printf '%s\n' "$root/usr/bin" >> "$GITHUB_PATH"

sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 \
  || echo 'apparmor userns knob absent — the functional probe decides'
"$root/usr/bin/bwrap" --version
"$root/usr/bin/bwrap" --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- true
echo 'bubblewrap functional probe passed'
