"""Own the per-user signing identity that keeps source-built Computer Use permissions across rebuilds.

macOS keeps Accessibility and Screen Recording grants for a bundle identifier together with the
designated requirement of the signature that was granted. An ad-hoc signature's requirement is the
code hash, so every changed build loses the grant. A certificate signature's requirement names the
bundle identifier and the certificate, so every build signed by the identity created here keeps it.

The identity lives in a dedicated keychain whose password is stored beside it with owner-only
permissions, so builds unlock it and sign without a system dialog. Any process running as the same
user can read that password and sign code that inherits the development grants; the grants belong
to the development bundle identifier only, never to the release helper.
"""
import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tempfile

DEFAULT_DIRECTORY = Path.home() / "Library/Application Support/DeepSeek Harness/computer-use-dev-signing"
COMMON_NAME = "DSH Computer Use Dev (local)"
SECURITY = "/usr/bin/security"
OPENSSL = "/usr/bin/openssl"
SETUP_COMMAND = "pnpm --dir packages/experimental/cua-macos run dev-signing:setup"
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


def security(*args):
    """Run security without echoing arguments, which can contain keychain passwords."""
    try:
        return subprocess.run([SECURITY, *args], check=True, capture_output=True, text=True, timeout=60).stdout
    except subprocess.CalledProcessError as error:
        raise RuntimeError(f"security {args[0]} failed: {error.stderr.strip()}") from None


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


def load(directory=DEFAULT_DIRECTORY):
    """Unlock the configured identity before signing.

    Returns None when setup has not run. Raises when setup ran but its keychain is missing or no
    longer on the search list, because signing would otherwise fail or prompt for a password.
    """
    record = record_path(directory)
    if not record.exists():
        return None
    fields = json.loads(record.read_text())
    keychain = keychain_path(directory)
    if not keychain.is_file():
        raise RuntimeError(f"Computer Use development signing keychain is missing: {keychain}; run {SETUP_COMMAND}")
    if not listed(keychain, user_keychains()):
        raise RuntimeError(f"Computer Use development signing keychain is not on the user keychain search list; run {SETUP_COMMAND}")
    # A locked keychain makes codesign show a password dialog, so unlock it explicitly every time.
    security("unlock-keychain", "-p", fields["password"], str(keychain))
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
            subprocess.run([OPENSSL, *command], cwd=work, check=True, capture_output=True, timeout=60)
        fingerprint = subprocess.run([OPENSSL, "x509", "-in", "certificate.pem", "-noout", "-fingerprint", "-sha1"],
                                     cwd=work, check=True, capture_output=True, text=True, timeout=60).stdout
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


def setup(directory=DEFAULT_DIRECTORY):
    """Create the identity once and keep its keychain on the user search list."""
    keychain = keychain_path(directory)
    if record_path(directory).exists() and keychain.is_file():
        keychains = user_keychains()
        if not listed(keychain, keychains):
            security("list-keychains", "-d", "user", "-s", *keychains, str(keychain))
        return load(directory)
    remove(directory)
    directory.mkdir(mode=0o700, parents=True)
    password = secrets.token_hex(32)
    sha1 = create_certificate(directory, password)
    security("list-keychains", "-d", "user", "-s", *user_keychains(), str(keychain))
    record = record_path(directory)
    with os.fdopen(os.open(record.with_suffix(".tmp"), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as file:
        json.dump({"sha1": sha1, "password": password}, file)
        file.write("\n")
    os.replace(record.with_suffix(".tmp"), record)
    return load(directory)


def remove(directory=DEFAULT_DIRECTORY):
    """Delete the keychain, its search-list entry and the stored password."""
    keychain = keychain_path(directory)
    keychains = user_keychains()
    if listed(keychain, keychains):
        security("list-keychains", "-d", "user", "-s", *[path for path in keychains if not listed(keychain, [path])])
    if keychain.exists():
        security("delete-keychain", str(keychain))
    if directory.exists():
        shutil.rmtree(directory)


def main():
    parser = argparse.ArgumentParser(description="Manage the local signing identity for source-built Computer Use applications.")
    parser.add_argument("action", choices=["setup", "remove", "status"])
    parser.add_argument("--directory", type=Path, default=DEFAULT_DIRECTORY, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.action == "setup":
        identity = setup(args.directory)
        print(f"Source builds sign as \"{COMMON_NAME}\" ({identity.sha1}) from {identity.keychain}")
    elif args.action == "remove":
        remove(args.directory)
        print("Removed the development signing identity; source builds return to ad-hoc signatures")
    else:
        identity = load(args.directory)
        print("not configured" if identity is None else f"{identity.sha1} {identity.keychain}")


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as error:
        print(error, file=sys.stderr)
        sys.exit(1)
