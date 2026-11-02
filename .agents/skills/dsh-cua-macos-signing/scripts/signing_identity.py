"""Manage an explicitly requested developer identity outside DSH home.

macOS keeps Accessibility and Screen Recording grants for a bundle identifier together with the
designated requirement of the signature that was granted. An ad-hoc signature's requirement is the
code hash, so every changed build loses the grant. A certificate signature's requirement names the
bundle identifier and the certificate, preserving the requirement across changed builds.

The identity lives in a dedicated keychain whose password is stored beside it with owner-only
permissions, so developer setup can unlock it without a system dialog. Any process running as the same
user can read that password and sign code that inherits the development grants; the grants belong
to the development bundle identifier only, never to the release helper.
"""
import argparse
from contextlib import contextmanager
from dataclasses import dataclass
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import subprocess
import sys
import tempfile

COMMON_NAME = "DSH Computer Use Dev (local)"
OWNER_MARKER = ".dsh-cua-macos-signing"
OWNER_VERSION = "1\n"
SECURITY = "/usr/bin/security"
OPENSSL = "/usr/bin/openssl"
SETUP_COMMAND = "python3 .agents/skills/dsh-cua-macos-signing/scripts/signing_identity.py setup"
REMOVE_COMMAND = "python3 .agents/skills/dsh-cua-macos-signing/scripts/signing_identity.py remove"
CERTIFICATE_CONFIG = f"""[req]
distinguished_name = subject
x509_extensions = extensions
prompt = no
[subject]
CN = {COMMON_NAME}
[extensions]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
"""


@dataclass(frozen=True)
class SigningIdentity:
    """An unlocked certificate identity that codesign can use without user interaction."""
    sha1: str
    keychain: Path


def private_command(command, **kwargs):
    """Run signing tools without exposing secret arguments or their echoed output in diagnostics."""
    operation = f"{Path(command[0]).name} {command[1]}"
    try:
        return subprocess.run(command, check=True, capture_output=True, text=True, timeout=60, **kwargs).stdout
    except subprocess.CalledProcessError as error:
        raise RuntimeError(f"{operation} failed (exit {error.returncode})") from None
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"{operation} timed out after 60 seconds") from None
    except OSError as error:
        raise RuntimeError(f"{operation} could not run (errno {error.errno})") from None


def security(*args):
    return private_command([SECURITY, *args])


@contextmanager
def identity_lock(directory):
    """Serialize setup and removal across worktrees; the lock inode survives identity removal."""
    directory.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with os.fdopen(os.open(directory.parent / f"{directory.name}.lock", os.O_WRONLY | os.O_CREAT, 0o600), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def user_keychains():
    """Read the user keychain search list that codesign consults for identities."""
    return [line.strip().strip('"') for line in security("list-keychains", "-d", "user").splitlines() if line.strip()]


def listed(keychain, keychains):
    """Compare canonical paths; security reports /private/var for /var and resolves other links."""
    return any(os.path.realpath(path) == os.path.realpath(keychain) for path in keychains)


def record_path(directory):
    return directory / "identity.json"


def keychain_path(directory):
    return directory / "signing.keychain-db"


def default_directory():
    """Keep developer credentials independent of DSH profiles, homes, and worktrees."""
    return Path.home() / ".cua-macos-keys" / "dev"


def owned_directory(directory, create=False):
    """Refuse unowned or mixed-content directories before changing files or keychains."""
    marker = directory / OWNER_MARKER
    if create:
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if not any(directory.iterdir()):
            directory.chmod(0o700)
            with os.fdopen(os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as file:
                file.write(OWNER_VERSION)
    if not directory.exists():
        return
    if marker.is_symlink() or not marker.is_file() or marker.read_bytes() != OWNER_VERSION.encode():
        raise RuntimeError(f"Refusing unowned signing directory: {directory}; choose a new or empty dedicated directory")
    allowed = {OWNER_MARKER, record_path(directory).name, record_path(directory).with_suffix(".tmp").name, keychain_path(directory).name}
    for entry in directory.iterdir():
        # security creates empty .flXXXXXXXX locks and removes them with delete-keychain.
        system_lock = re.fullmatch(r"\.fl[0-9A-Fa-f]{8}", entry.name) and entry.is_file() and entry.stat().st_size == 0
        if (entry.name not in allowed and not system_lock) or entry.is_symlink() or not entry.is_file():
            raise RuntimeError(f"Refusing signing directory with unrelated entries: {directory}; preserve those entries before retrying")


def load(directory):
    """Unlock the configured identity before signing.

    Returns None when setup has not run. Raises when setup ran but its keychain is missing or no
    longer on the search list, because signing would otherwise fail or prompt for a password.
    """
    directory_argument = shlex.quote(str(directory))
    setup_command = f"{SETUP_COMMAND} --directory {directory_argument}"
    remove_command = f"{REMOVE_COMMAND} --directory {directory_argument}"
    record = record_path(directory)
    if not record.exists():
        return None
    try:
        fields = json.loads(record.read_text())
        valid = isinstance(fields, dict) and isinstance(fields.get("password"), str) and isinstance(fields.get("sha1"), str) and bool(fields["password"]) and bool(fields["sha1"])
    except (ValueError, OSError):
        valid = False
    if not valid:
        raise RuntimeError(f"Computer Use development signing record is invalid; run {remove_command}, then {setup_command}")
    keychain = keychain_path(directory)
    if not keychain.is_file():
        raise RuntimeError(f"Computer Use development signing keychain is missing: {keychain}; run {remove_command}, then {setup_command}")
    if not listed(keychain, user_keychains()):
        raise RuntimeError(f"Computer Use development signing keychain is not on the user keychain search list; run {setup_command}")
    # A locked keychain makes codesign show a password dialog, so unlock it explicitly every time.
    security("unlock-keychain", "-p", fields["password"], str(keychain))
    if fields["sha1"] not in security("find-identity", str(keychain)):
        raise RuntimeError(f"Computer Use development signing certificate is missing; run {remove_command}, then {setup_command}")
    return SigningIdentity(sha1=fields["sha1"], keychain=keychain)


def create_certificate(directory, password):
    """Create the key pair inside the dedicated keychain and return the certificate SHA-1."""
    keychain = keychain_path(directory)
    with tempfile.TemporaryDirectory(prefix=".certificate-", dir=directory) as temporary:
        work = Path(temporary)
        (work / "openssl.cnf").write_text(CERTIFICATE_CONFIG)
        export_password = secrets.token_hex(16)
        for command in (
            ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "key.pem", "-out", "certificate.pem",
             "-days", "3650", "-config", "openssl.cnf"],
            ["pkcs12", "-export", "-inkey", "key.pem", "-in", "certificate.pem", "-out", "identity.p12",
             "-passout", f"pass:{export_password}"],
        ):
            private_command([OPENSSL, *command], cwd=work)
        fingerprint = private_command([OPENSSL, "x509", "-in", "certificate.pem", "-noout", "-fingerprint", "-sha1"], cwd=work)
        security("create-keychain", "-p", password, str(keychain))
        security("unlock-keychain", "-p", password, str(keychain))
        # No arguments disables the inactivity timeout and lock on sleep.
        security("set-keychain-settings", str(keychain))
        security("import", str(work / "identity.p12"), "-k", str(keychain), "-P", export_password, "-T", "/usr/bin/codesign")
        # Without a partition list, codesign asks the user to allow access to the private key.
        security("set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, str(keychain))
    match = re.search(r"=([0-9A-F:]+)", fingerprint)
    if match is None:
        raise RuntimeError("openssl returned no certificate fingerprint")
    sha1 = match.group(1).replace(":", "")
    if sha1 not in security("find-identity", str(keychain)):
        raise RuntimeError("the imported development signing identity is not usable")
    return sha1


def setup(directory):
    """Create an identity only without a record; preserve recorded identities when their keychain is missing."""
    with identity_lock(directory):
        return setup_locked(directory)


def setup_locked(directory):
    owned_directory(directory, create=True)
    keychain = keychain_path(directory)
    if record_path(directory).exists():
        if keychain.is_file():
            keychains = user_keychains()
            if not listed(keychain, keychains):
                security("list-keychains", "-d", "user", "-s", *keychains, str(keychain))
        return load(directory)
    clear_identity(directory)
    password = secrets.token_hex(32)
    sha1 = create_certificate(directory, password)
    security("list-keychains", "-d", "user", "-s", *user_keychains(), str(keychain))
    record = record_path(directory)
    with os.fdopen(os.open(record.with_suffix(".tmp"), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as file:
        json.dump({"sha1": sha1, "password": password}, file)
        file.write("\n")
    os.replace(record.with_suffix(".tmp"), record)
    return load(directory)


def remove(directory):
    """Delete the keychain, its search-list entry and the stored password."""
    with identity_lock(directory):
        remove_locked(directory)


def remove_locked(directory):
    owned_directory(directory)
    clear_identity(directory)
    if directory.exists():
        (directory / OWNER_MARKER).unlink()
        directory.rmdir()


def clear_identity(directory):
    """Remove only the identity files and its exact keychain search-list entry."""
    keychain = keychain_path(directory)
    keychains = user_keychains()
    if listed(keychain, keychains):
        security("list-keychains", "-d", "user", "-s", *[path for path in keychains if not listed(keychain, [path])])
    if keychain.exists():
        security("delete-keychain", str(keychain))
    record_path(directory).unlink(missing_ok=True)
    record_path(directory).with_suffix(".tmp").unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description="Manage the local signing identity for source-built Computer Use applications.")
    parser.add_argument("action", choices=["setup", "remove"])
    parser.add_argument("--directory", type=Path, default=default_directory(), help="identity directory; defaults to ~/.cua-macos-keys/dev")
    args = parser.parse_args()
    directory = args.directory.expanduser().resolve()
    if args.action == "setup":
        identity = setup(directory)
        print(json.dumps({"identity": identity.sha1, "keychain": str(identity.keychain)}, indent=2))
    else:
        remove(directory)
        print("Removed the development signing identity; remove its sourceSigning configuration before the next build")


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as error:
        print(error, file=sys.stderr)
        sys.exit(1)
