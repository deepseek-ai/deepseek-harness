# Agent Note: Python public publication workflow

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-11-python-publication-workflow.zh.md)

## Problem

The Python SDK comprises one platform-independent client wheel and five native runtime wheels that must carry one version and become installable as a set. Public PyPI uploads expose package metadata and files immediately, cannot replace an uploaded filename, and create a temporarily unusable SDK if its exact runtime dependency has not arrived. The private repository needs to exercise the complete native build and validation sequence without publishing any artifact externally.

## Decision

The `Release (Python)` GitHub workflow exposes credential-free validation to manual runs with `publish=false`. The run calls the native wheel builder for all five targets, installs the Linux release set on Python 3.10 and 3.14, downloads the six resulting artifacts, verifies their exact filenames and package metadata, enforces PyPI's default per-file size limit, records SHA-256 hashes, and retains one aggregate release candidate. These jobs have only repository read permission and no registry credential or OIDC permission, and a dry run cannot enter either publication job.

A run with `publish=true` must use the `python-v<repository-version>` tag in the private automation repository, match that repository's `github.repository` to its repository-scoped `PYPI_PUBLISHER_REPOSITORY` variable, find `PUBLIC_PYPI_RELEASE_ENABLED=true`, and receive approval from the `pypi-runtime` and `pypi` GitHub environments for runtime and SDK publication, respectively. The read-only public mirror supplies the package metadata URLs but does not run release Actions. Only the two publication jobs receive `id-token: write`; PyPI Trusted Publishing exchanges the private repository identity for short-lived project credentials, so the repository stores no PyPI token.

Publication consumes the aggregate artifact produced and checked in the same workflow run. Each publication job verifies the retained `SHA256SUMS` before selecting its upload set. A runtime job uploads all five platform wheels before a dependent job uploads the SDK wheel because PyPI uploads are not atomic and the SDK pins the runtime distribution at the exact same version. Neither job checks out source or rebuilds a wheel. Separating them lets GitHub's failed-job retry resume an SDK failure without attempting to replace immutable runtime files.

Both publication actions disable public attestations. The action still uses Trusted Publishing for authentication, while omitting provenance that would disclose the private publisher repository instead of the public source mirror.

Repository versions may be stable or use the supported prerelease spellings. Tags retain the repository spelling, while wheel filenames, metadata, dependency pins, and artifact lookup use the normalized PEP 440 spelling.

The runtime package's `platforms.json` is the source of truth for native wheel tags and executable names. The repository release builder and the isolated Hatch build hook validate and load that file independently. GitHub Actions and GitLab CI call one repository-owned macOS deployment-target check for both the runtime executable and its required spawn helper, so every Mach-O file in the wheel must fit the declared platform tag.

Both Python build-system requirements pin Hatchling 1.30.1. The next available Hatchling release emits Core Metadata 2.5, which the pinned Twine 6.2.0 validator rejects; keeping the builder exact makes local, GitHub, and GitLab output agree until the validation toolchain supports that metadata version.

## Alternatives considered

**TestPyPI rehearsal.** TestPyPI is a public index, so uploading there would expose package names, metadata, and wheel contents before the repository opens. The credential-free aggregate artifact and the existing private GitLab package registry cover validation and upload-protocol rehearsal without that disclosure.

**A long-lived PyPI API token.** A stored token gives unrelated workflow steps a reusable secret and needs manual rotation. Trusted Publishing limits the credential to the registered repository, workflow, and environment and mints it only for each protected publication job.

**Building again inside the publication job.** A second build can differ from the candidate that passed native smoke tests. Publication downloads the same retained bytes and checks no source out.

**Uploading the SDK before its runtime carriers.** The SDK would become visible while its exact dependency remained unavailable if a later upload failed. Runtime-first ordering leaves partial failures without an installable client that points at missing files.

**Publishing from the public mirror.** The public mirror is a read-only source projection and does not run release Actions. Binding the PyPI publisher to it would leave no workload capable of presenting the registered OIDC identity.

**Publishing public attestations.** The default action behavior makes the Trusted Publisher repository identity publicly verifiable. That provenance identifies the private automation repository rather than the package's public source mirror, so the publication jobs disable it.

## Consequences

The complete release candidate and the public release both run from the private automation repository. Selecting `publish=true` fails before the protected publication jobs unless the publisher-repository variable, release switch, and tag identify an intentional public release. Mirroring code does not copy those private repository settings, so the read-only public mirror cannot satisfy the authorization checks.

The private automation repository owner and name, workflow filename, and each job's environment (`pypi-runtime` for runtime and `pypi` for SDK) are part of the Trusted Publisher identity. A source-repository transfer, workflow rename, or environment rename requires updating the affected PyPI publishers and the publisher-repository variable when the repository identity changes. Changing the read-only public mirror changes package metadata URLs instead, not the publishing identity.

PyPI publication remains non-atomic across the two distribution projects. Runtime-first ordering narrows the visible failure mode, while separate publication jobs and checksum verification let a failed SDK upload resume with the exact checked bytes; an uploaded filename is never replaced.

Disabling public attestations gives up public cryptographic provenance for the upload identity. Trusted Publishing still authenticates each upload, and the retained aggregate artifact keeps the checked wheel hashes inside the private release workflow.

Upgrading Hatchling now requires validating the emitted Core Metadata version with the release pipeline's pinned Twine version before changing both package build requirements together.
