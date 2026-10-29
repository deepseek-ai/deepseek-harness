# Isolated proxy fixture; no external requests, runner registration or signing hardware.
param([switch]$CheckStartup)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../scripts/windows-runner-network.ps1')
$root = Join-Path ([IO.Path]::GetTempPath()) ('dsh-network-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $root
$null = New-Item -ItemType Directory -Path (Join-Path $root 'tools')
$pwshLink = Join-Path $root 'tools/pwsh-7.6.6'
if ($CheckStartup) { $null = New-Item -ItemType Junction -Path $pwshLink -Target $PSHOME }
$server = $null
$saved = @{}
foreach ($name in @('HTTP_PROXY','HTTPS_PROXY','NO_PROXY','NODE_USE_ENV_PROXY')) { $saved[$name] = [Environment]::GetEnvironmentVariable($name,'Process') }
try {
    if ($null -ne (Read-RunnerNetwork $root)) { throw 'Absent configuration changed behavior.' }
    $fixture = Join-Path $root 'proxy.cjs'
    @'
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const server = http.createServer((req, res) => {
  fs.appendFileSync(path.join(root, 'requests'), req.method + ' ' + req.url + '\n');
  if (req.url.includes('/hang')) return;
  res.writeHead(req.url.includes('/fail') ? 503 : 200);
  res.end();
});
server.on('connect', (req, socket) => {
  socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  server.emit('connection', socket);
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(path.join(root, 'port'), String(server.address().port)));
'@ | Set-Content -LiteralPath $fixture
    $info = [Diagnostics.ProcessStartInfo]::new((Get-Command node).Source)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.ArgumentList.Add($fixture)
    $info.ArgumentList.Add($root)
    $server = [Diagnostics.Process]::Start($info)
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while (-not (Test-Path (Join-Path $root 'port'))) {
        if ($server.HasExited -or [DateTime]::UtcNow -gt $deadline) { throw 'Proxy fixture did not become ready.' }
        Start-Sleep -Milliseconds 50
    }
    $port = Get-Content (Join-Path $root 'port') -Raw
    $config = @{proxyUrl="http://127.0.0.1:$port";noProxy='';serviceName='';probeUrl='http://runner-probe.invalid/ready';attempts=2;timeoutSeconds=2;retrySeconds=1}
    function Write-Config { $config | ConvertTo-Json | Set-Content (Join-Path $root 'runner-network.json') }
    Write-Config
    $parsed = Read-RunnerNetwork $root
    Set-RunnerNetwork $parsed
    Wait-RunnerNetwork $parsed
    if ($env:NODE_USE_ENV_PROXY -ne '1' -or $env:HTTP_PROXY -ne $config.proxyUrl -or $env:HTTPS_PROXY -ne $config.proxyUrl) { throw 'Proxy environment was not applied.' }
    # Full startup requires the operator's installed packaging toolchain and persistent PATH.
    if ($CheckStartup) {
        $output = & (Join-Path $PSHOME 'pwsh.exe') -NoProfile -File (Join-Path $PSScriptRoot '../scripts/start-windows-packaging-runner.ps1') -RunnerRoot $root -ConfigRoot $root -CheckOnly 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0 -or -not $output.Contains('Runner network dependency ready')) { throw "Startup integration failed: $output" }
        if ((Get-Content (Join-Path $root 'requests')).Count -ne 2) { throw 'Startup did not reach the configured proxy.' }
        Clear-Content (Join-Path $root 'requests')
        Wait-RunnerNetwork $parsed
    }
    $config.probeUrl = 'http://runner-probe.invalid/fail'
    Write-Config
    $failed = $false
    try { Wait-RunnerNetwork (Read-RunnerNetwork $root) } catch { $failed = $_.Exception.Message.StartsWith('Runner network dependency unavailable;') }
    if (-not $failed -or (Get-Content (Join-Path $root 'requests')).Count -ne 3) { throw 'Failed readiness did not stop at its budget.' }
    $config.serviceName = 'fixture-service'
    $config.probeUrl = 'http://runner-probe.invalid/ready'
    $script:serviceChecks = 0
    function Get-Service {
        param($Name)
        $script:serviceChecks++
        [pscustomobject]@{ Status = if ($script:serviceChecks -eq 1) { 'Stopped' } else { 'Running' } }
    }
    try {
        Wait-RunnerNetwork $config
        if ($script:serviceChecks -ne 2 -or (Get-Content (Join-Path $root 'requests')).Count -ne 4) { throw 'Service readiness did not contain probes.' }
        function Get-Service { throw 'fake-secret' }
        $failure = $null
        try { Wait-RunnerNetwork $config } catch { $failure = $_ }
        if (-not $failure -or $failure.ToString().Contains('fake-secret') -or (Get-Content (Join-Path $root 'requests')).Count -ne 4) { throw 'Missing service was not contained.' }
    } finally { Remove-Item Function:Get-Service }
    $config.serviceName = ''
    $config.proxyUrl = 'http://127.0.0.1:1'
    $config.noProxy = '127.0.0.1'
    $config.probeUrl = "http://127.0.0.1:$port/ready"
    Set-RunnerNetwork $config
    Wait-RunnerNetwork $config
    if ((Get-Content (Join-Path $root 'requests')).Count -ne 5) { throw 'NO_PROXY did not bypass the unavailable proxy.' }
    $config.probeUrl = "http://127.0.0.1:$port/hang"
    $config.attempts = 1
    $config.timeoutSeconds = 1
    $failure = $null
    try { Wait-RunnerNetwork $config } catch { $failure = $_ }
    if (-not $failure -or (Get-Content (Join-Path $root 'requests')).Count -ne 6) { throw 'Unresponsive endpoint did not terminate its probe.' }
    foreach ($invalid in @('extra','credential','budget','type','wildcard','malformed')) {
        $bad = $config.Clone()
        switch ($invalid) {
            'extra' { $bad.unknown = 'invalid' }
            'credential' { $bad.proxyUrl = 'http://fake-secret:fake-secret@localhost:1' }
            'budget' { $bad.attempts = 0 }
            'type' { $bad.retrySeconds = '2' }
            'wildcard' { $bad.serviceName = '*' }
        }
        $json = if ($invalid -eq 'malformed') { '{fake-secret' } else { $bad | ConvertTo-Json }
        $json | Set-Content (Join-Path $root 'runner-network.json')
        $failure = $null
        try { $null = Read-RunnerNetwork $root } catch { $failure = $_ }
        if (-not $failure -or $failure.ToString().Contains('fake-secret')) { throw 'Invalid configuration accepted or disclosed.' }
    }
    Write-Output "PASS: absent config, proxy routing, Node proxy opt-in, service readiness, bounded failure and redacted invalid config; startup integration=$CheckStartup."
} finally {
    foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name,$saved[$name],'Process') }
    if ($server) { if (-not $server.HasExited) { $server.Kill($true); $server.WaitForExit() }; $server.Dispose() }
    if ($CheckStartup) { [IO.Directory]::Delete($pwshLink) }
    if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($root)).TrimEnd('\') -ne [IO.Path]::GetTempPath().TrimEnd('\')) { throw 'Fixture cleanup escaped the temporary directory.' }
    Remove-Item -LiteralPath $root -Recurse -Force
}
exit 0
