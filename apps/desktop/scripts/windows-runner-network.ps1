# Load operator-owned network settings without evaluating code or logging their values.
function Read-RunnerNetwork([string]$ConfigRoot) {
    $path = Join-Path $ConfigRoot 'runner-network.json'
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try { $config = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -AsHashtable -ErrorAction Stop }
    catch { throw 'Cannot read runner-network.json; inspect its JSON locally.' }
    $keys = @('proxyUrl','noProxy','serviceName','probeUrl','attempts','timeoutSeconds','retrySeconds')
    if ($config -isnot [Collections.IDictionary] -or $config.Count -ne $keys.Count -or @($config.Keys | Where-Object { $_ -cnotin $keys }).Count) {
        throw 'runner-network.json requires exactly proxyUrl, noProxy, serviceName, probeUrl, attempts, timeoutSeconds and retrySeconds.'
    }
    foreach ($key in @('proxyUrl','noProxy','serviceName','probeUrl')) {
        if ($config[$key] -isnot [string] -or $config[$key] -match '[\r\n\x00]') { throw 'Invalid network string setting; inspect runner-network.json locally.' }
    }
    if ([Management.Automation.WildcardPattern]::ContainsWildcardCharacters($config.serviceName)) { throw 'Network service must be an exact name.' }
    foreach ($key in @('attempts','timeoutSeconds','retrySeconds')) {
        if ($config[$key] -isnot [long] -and $config[$key] -isnot [int]) { throw 'Network budgets must be integers.' }
        if ($config[$key] -lt 1 -or $config[$key] -gt 60) { throw 'Network budgets must be between 1 and 60.' }
    }
    foreach ($key in @('proxyUrl','probeUrl')) {
        if ($key -eq 'proxyUrl' -and $config[$key] -eq '') { continue }
        $uri = $null
        if (-not [Uri]::TryCreate($config[$key], [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -notin @('http','https') -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) {
            throw 'Network URLs must be absolute HTTP(S) URLs without credentials, queries or fragments.'
        }
        if ($key -eq 'proxyUrl' -and $uri.AbsolutePath -ne '/') { throw 'Proxy URL must not contain a path.' }
    }
    return $config
}

# Called after the runner environment is scrubbed; only declared network values reach child jobs.
function Set-RunnerNetwork($Config) {
    if ($null -eq $Config) { return }
    [Environment]::SetEnvironmentVariable('HTTP_PROXY', $Config.proxyUrl, 'Process')
    [Environment]::SetEnvironmentVariable('HTTPS_PROXY', $Config.proxyUrl, 'Process')
    [Environment]::SetEnvironmentVariable('NO_PROXY', $Config.noProxy, 'Process')
    [Environment]::SetEnvironmentVariable('NODE_USE_ENV_PROXY', '1', 'Process')
}

# Only probe retries are allowed here. Service recovery belongs to its installed Windows service.
function Wait-RunnerNetwork($Config) {
    if ($null -eq $Config) { return }
    $info = [Diagnostics.ProcessStartInfo]::new((Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.Environment['DSH_NETWORK_PROBE_URL'] = $Config.probeUrl
    $info.Environment['DSH_NETWORK_PROBE_TIMEOUT'] = [string]($Config.timeoutSeconds * 1000)
    $info.ArgumentList.Add('--input-type=module')
    $info.ArgumentList.Add('-e')
    $info.ArgumentList.Add('try { const r = await fetch(process.env.DSH_NETWORK_PROBE_URL, { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(Number(process.env.DSH_NETWORK_PROBE_TIMEOUT)) }); await r.body?.cancel(); process.exit(r.ok ? 0 : 1); } catch { process.exit(1); }')
    for ($attempt = 1; $attempt -le $Config.attempts; $attempt++) {
        $ready = $true
        if ($Config.serviceName) {
            try { $service = Get-Service -Name $Config.serviceName -ErrorAction Stop }
            catch { throw 'Configured network service is unavailable; inspect its installation locally.' }
            $ready = $service.Status -eq 'Running'
        }
        if ($ready) {
            $process = [Diagnostics.Process]::new()
            $process.StartInfo = $info
            try {
                if (-not $process.Start()) { throw 'Cannot launch network probe.' }
                $out = $process.StandardOutput.ReadToEndAsync()
                $err = $process.StandardError.ReadToEndAsync()
                if (-not $process.WaitForExit(($Config.timeoutSeconds + 5) * 1000)) {
                    $process.Kill($true)
                    $process.WaitForExit()
                    $ready = $false
                } else { $ready = $process.ExitCode -eq 0 }
                $null = $out.GetAwaiter().GetResult()
                $null = $err.GetAwaiter().GetResult()
            } finally { $process.Dispose() }
        }
        if ($ready) { Write-Output 'Runner network dependency ready (Node HEAD probe).'; return }
        Write-Output "Runner network dependency not ready (probe $attempt/$($Config.attempts))."
        if ($attempt -lt $Config.attempts) { Start-Sleep -Seconds $Config.retrySeconds }
    }
    throw 'Runner network dependency unavailable; runner was not started. Inspect local service and network configuration. No job or signing retry was requested.'
}
