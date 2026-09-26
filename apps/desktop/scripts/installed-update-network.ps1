# Operator-owned test-application fault. Status is read-only; Block and Restore require typed confirmation.
param(
    [Parameter(Mandatory = $true)][string]$Plan,
    [ValidateSet('Status', 'Block', 'Restore')][string]$Action = 'Status'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$planPath = (Resolve-Path -LiteralPath $Plan).Path
$spec = Get-Content -LiteralPath $planPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($spec.schemaVersion -ne 1 -or $spec.runId -cnotmatch '^[a-f0-9]{24}$' -or
    $spec.ruleName -cne "DSH-Update-Qualification-$($spec.runId)" -or
    $spec.sha512Hex -cnotmatch '^[A-F0-9]{128}$' -or
    $spec.executable -notmatch '^[A-Za-z]:\\' -or
    [IO.Path]::GetFileName($spec.executable) -cne "DSH Update Test $($spec.runId).exe" -or
    [IO.Path]::GetFullPath($spec.executable) -cne $spec.executable) {
    throw 'Invalid test-only network plan; no network changes were made.'
}
$owner = "dsh-update-qualification:$($spec.runId):$($spec.sha512Hex)"
$recordParent = Join-Path (Split-Path -Parent $planPath) 'records'
[IO.Directory]::CreateDirectory($recordParent) | Out-Null
$record = Join-Path $recordParent ([Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $record | Out-Null
$events = Join-Path $record 'events.jsonl'
function Save-Event([string]$Stage, [object]$Data) {
    $line = @{ time = [DateTime]::UtcNow.ToString('o'); action = $Action; stage = $Stage; data = $Data } | ConvertTo-Json -Depth 6 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($line + "`n")
    $stream = [IO.File]::Open($events, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}
function Find-OwnedRule {
    $rules = @(Get-NetFirewallRule -PolicyStore PersistentStore | Where-Object { $_.Name -ceq $spec.ruleName })
    if ($rules.Count -gt 1) { throw 'Multiple rules match this run; manual inspection is required.' }
    if ($rules.Count -eq 0) { return $null }
    $rule = $rules[0]
    $filters = @($rule | Get-NetFirewallApplicationFilter)
    if ($rule.Description -cne $owner -or [string]$rule.Direction -ne 'Outbound' -or [string]$rule.Action -ne 'Block' -or
        $filters.Count -ne 1 -or $filters[0].Program -ine $spec.executable) {
        throw 'The existing rule is not owned by this exact test plan; it was not modified.'
    }
    return $rule
}
$success = $false
Write-Output "NETWORK_FAULT_RECORD $record"
try {
    Save-Event 'started' @{ runId = $spec.runId; executable = $spec.executable; ruleName = $spec.ruleName }
    $existing = Find-OwnedRule
    Save-Event 'before' @{ present = ($null -ne $existing) }
    if ($Action -eq 'Block') {
        if ($null -ne $existing) { throw 'A test rule already exists. Restore it before starting another fault.' }
        if ((Get-FileHash -LiteralPath $spec.executable -Algorithm SHA512).Hash -cne $spec.sha512Hex) {
            throw 'The test executable changed. No rule was created.'
        }
        Write-Output "Only this executable will be blocked: $($spec.executable)"
        Write-Output 'Keep a second administrator terminal ready to run Restore. Do not disable the adapter, VPN, or proxy.'
        if ((Read-Host "Type BLOCK $($spec.runId) after download progress begins") -cne "BLOCK $($spec.runId)") {
            throw 'Confirmation declined; no rule was created.'
        }
        if ($null -ne (Find-OwnedRule)) { throw 'A rule appeared during confirmation. No rule was created.' }
        if ((Get-FileHash -LiteralPath $spec.executable -Algorithm SHA512).Hash -cne $spec.sha512Hex) {
            throw 'The test executable changed during confirmation. No rule was created.'
        }
        Save-Event 'creating-rule' @{ name = $spec.ruleName }
        New-NetFirewallRule -Name $spec.ruleName -DisplayName $spec.ruleName -Description $owner `
            -Direction Outbound -Program $spec.executable -Action Block -Profile Any -Enabled True -PolicyStore PersistentStore | Out-Null
        $created = Find-OwnedRule
        if ($null -eq $created -or [string]$created.Enabled -ne 'True') { throw 'The rule was not confirmed enabled. Use Restore.' }
        Save-Event 'blocked-rule-present' @{ trafficInterruptionVerified = $false }
    } elseif ($Action -eq 'Restore') {
        if ($null -ne $existing) {
            if ((Read-Host "Type RESTORE $($spec.runId)") -cne "RESTORE $($spec.runId)") { throw 'Restoration declined.' }
            $existing = Find-OwnedRule
            if ($null -ne $existing) {
                Save-Event 'removing-rule' @{ name = $spec.ruleName }
                $existing | Remove-NetFirewallRule
            }
        }
        if ($null -ne (Find-OwnedRule)) { throw 'The test rule still exists; restoration is incomplete.' }
        Save-Event 'rule-absent' @{ downloadRecoveryVerified = $false }
    } else {
        Save-Event 'status' @{ present = ($null -ne $existing); enabled = $(if ($null -ne $existing) { [string]$existing.Enabled } else { $null }) }
        Write-Output "Test rule present: $($null -ne $existing)"
    }
    $success = $true
} catch {
    Save-Event 'failed' @{ message = $_.Exception.Message; automaticRetry = $false }
    throw
} finally {
    Save-Event 'finished' @{ success = $success; rulePresenceIsNotTrafficEvidence = $true }
}
