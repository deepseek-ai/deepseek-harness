#requires -Version 5.1
<#
.SYNOPSIS
Checks Windows DPAPI credentials, or explicitly uploads one completed Desktop target.
.DESCRIPTION
Imports encrypted SecretId and SecretKey fields from an external CLIXML file.
Only the Node child receives plaintext COS credentials. The default check starts
a keyless-code probe without contacting COS; it does not verify cloud permissions.
.PARAMETER CredentialFile
Path to the CLIXML file created by the current Windows user on this machine.
.PARAMETER Environment
Deployment that owns the credential pair; never inferred from the filename.
.PARAMETER Target
Completed Desktop target to upload when Upload is explicitly selected.
.PARAMETER Bucket
COS bucket for an explicit upload. Not needed for the local credential check.
.PARAMETER Upload
Authorize the existing target upload entry. Omit to check credentials locally.
#>
[CmdletBinding(DefaultParameterSetName = 'Check')]
param(
    [Parameter(Mandatory = $true)]
    [string]$CredentialFile,
    [Parameter(Mandatory = $true)]
    [ValidateSet('test', 'production')]
    [string]$Environment,
    [Parameter(ParameterSetName = 'Publish', Mandatory = $true)]
    [ValidateSet('win-x64', 'mac-x64', 'mac-arm64')]
    [string]$Target,
    [Parameter(ParameterSetName = 'Publish', Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [ValidatePattern('^[a-z0-9-]+$')]
    [string]$Bucket,
    [Parameter(ParameterSetName = 'Publish', Mandatory = $true)]
    [switch]$Upload
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$child = $null
$started = $false
$secretId = $null
$secretKey = $null
$credentials = $null
$startInfo = $null
$stage = 'decrypt-file'

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'Windows DPAPI is required.'
    }
    try {
        $credentials = Import-Clixml -LiteralPath $CredentialFile
        foreach ($field in @('SecretId', 'SecretKey')) {
            if ($credentials.$field -isnot [Security.SecureString] -or $credentials.$field.Length -eq 0) {
                throw 'Expected non-empty encrypted fields.'
            }
        }
    } catch {
        throw 'Cannot read encrypted COS credentials. Check the file and use its original Windows user and machine.'
    }

    $stage = 'prepare-node'
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $startInfo.WorkingDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($name in @($startInfo.EnvironmentVariables.Keys)) {
        # Node preload hooks and unrelated release secrets must not reach this credential-bearing process.
        if ($name -match 'KEY|SECRET|TOKEN|PASSWORD|^NODE_OPTIONS$|^DSH_DESKTOP_WINDOWS_|^APPLE_|^CSC_') {
            $startInfo.EnvironmentVariables.Remove($name)
        }
    }
    $stage = 'prepare-credentials'
    $prefix = if ($Environment -eq 'production') { 'DOWNLOAD_PROD_COS' } else { 'DOWNLOAD_TEST_COS' }
    $secretId = [Net.NetworkCredential]::new('', $credentials.SecretId).Password
    $secretKey = [Net.NetworkCredential]::new('', $credentials.SecretKey).Password
    if ([string]::IsNullOrWhiteSpace($secretId) -or [string]::IsNullOrWhiteSpace($secretKey)) {
        throw 'COS credential fields must not be blank.'
    }
    $startInfo.EnvironmentVariables["${prefix}_SECRET_ID"] = $secretId
    $startInfo.EnvironmentVariables["${prefix}_SECRET_KEY"] = $secretKey
    $startInfo.EnvironmentVariables['DSH_DESKTOP_AUTO_UPDATE_ENV'] = $Environment
    if ($Upload) {
        $startInfo.EnvironmentVariables["${prefix}_BUCKET"] = $Bucket
        $startInfo.Arguments = "--import tsx/esm apps/desktop/scripts/upload-target.ts $Target --credential-launcher --environment $Environment --bucket $Bucket"
        Write-Output "desktop credentials: uploading $Target to $Environment; release validation runs before network writes."
    } else {
        $probe = "const id=process.env.${prefix}_SECRET_ID;const key=process.env.${prefix}_SECRET_KEY;process.exit(id?.trim()&&key?.trim()?0:1)"
        $startInfo.Arguments = "-e `"$probe`""
    }

    $stage = 'run-node'
    $child = New-Object Diagnostics.Process
    $child.StartInfo = $startInfo
    $started = $child.Start()
    $stderr = $child.StandardError.ReadToEndAsync()
    while ($null -ne ($line = $child.StandardOutput.ReadLine())) {
        Write-Output $line.Replace($secretId, '[REDACTED]').Replace($secretKey, '[REDACTED]')
    }
    $child.WaitForExit()
    # SDK exception objects can include signed request details; do not forward raw stderr.
    $null = $stderr.GetAwaiter().GetResult()
    if ($child.ExitCode -ne 0) {
        throw "Node upload/check failed (exit $($child.ExitCode)); private diagnostics suppressed."
    }
    if (-not $Upload) {
        Write-Output 'desktop credentials: encrypted fields loaded; child environment verified; no network request made.'
    }
} catch {
    # Import and process exceptions are not safe credential diagnostics.
    Write-Output "desktop credentials: failed; stage=$stage; line=$($_.InvocationInfo.ScriptLineNumber). Verify the encrypted file, Windows account, Node, and release inputs. No secrets printed."
    exit 1
} finally {
    if ($started -and -not $child.HasExited) {
        $child.Kill()
        $child.WaitForExit()
    }
    if ($null -ne $child) { $child.Dispose() }
    if ($null -ne $startInfo) { $startInfo.EnvironmentVariables.Clear() }
    if ($null -ne $credentials) {
        foreach ($field in @('SecretId', 'SecretKey')) {
            if ($credentials.PSObject.Properties[$field] -and $credentials.$field -is [Security.SecureString]) {
                $credentials.$field.Dispose()
            }
        }
    }
    $secretId = $null
    $secretKey = $null
}
