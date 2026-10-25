# Only the container name is needed; the caller removes inherited signing credentials.
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'windows-token-public-key.cs')
[DshTokenPublicKey]::Read([DshTokenPublicKey+NativeApi]::new(), $env:DSH_TOKEN_PUBLIC_CONTAINER) | ConvertTo-Json -Compress
