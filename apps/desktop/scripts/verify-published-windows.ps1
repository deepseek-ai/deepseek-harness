# Verify the existing installer; never sign or access the hardware token.
param(
    [Parameter(Mandatory = $true)][string]$Installer,
    [Parameter(Mandatory = $true)][string]$Thumbprint
)
$ErrorActionPreference = 'Stop'
$signature = Get-AuthenticodeSignature -LiteralPath $Installer
if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) {
    throw 'Installer does not have a valid Authenticode signature.'
}
if ($signature.SignerCertificate.Thumbprint -ne $Thumbprint) {
    throw 'Installer signer does not match the configured release certificate.'
}
if ($null -eq $signature.TimeStamperCertificate) {
    throw 'Installer has no verified signing timestamp.'
}
