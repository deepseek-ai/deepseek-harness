<# Per-user PATH ownership. The worker owns its mutex through registry publication. #>
function Invoke-DshCommandPath {
    param([hashtable]$Request, [string]$EnvironmentKey, [string]$OwnerKey, [string]$MachinePath, [string]$MutexName)
    $ErrorActionPreference = 'Stop'
    function Fail([string]$Code, [string]$Message) {
        $error = [InvalidOperationException]::new($Message)
        $error.Data['code'] = $Code
        throw $error
    }
    function Comparable([string]$Path) {
        $expanded = [Environment]::ExpandEnvironmentVariables($Path.Trim().Trim('"'))
        try {
            if (-not [IO.Path]::IsPathRooted($expanded)) { return $expanded }
            return [IO.Path]::GetFullPath($expanded).TrimEnd('\','/').ToUpperInvariant()
        } catch {
            # Invalid user PATH entries cannot identify the managed directory.
            return $expanded
        }
    }
    $directory = [string]$Request.directory
    if (-not [IO.Path]::IsPathRooted($directory) -or $directory.Contains(';') -or $directory.Contains([char]0)) {
        Fail 'EUNSUPPORTED' 'The command directory cannot be represented in PATH.'
    }
    $directory = [IO.Path]::GetFullPath($directory)
    if ($Request.operation -notin @('inspect','install','remove')) { Fail 'EINVAL' 'Unknown command operation.' }
    $mutex = [Threading.Mutex]::new($false, $MutexName)
    $locked = $false
    try {
        try { $locked = $mutex.WaitOne(5000) } catch [Threading.AbandonedMutexException] { $locked = $true }
        if (-not $locked) { Fail 'EBUSY' 'Another command-management operation is running.' }
        $environment = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($EnvironmentKey)
        $owner = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($OwnerKey)
        try {
            $raw = if ($environment) { $environment.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null }
            if ($null -ne $raw -and $raw -isnot [string]) { Fail 'EUNSUPPORTED' 'The user PATH value is not a string.' }
            $kind = if ($null -ne $raw) { $environment.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
            $owned = if ($owner) { $owner.GetValue('Directory', $null) } else { $null }
            $wasAbsent = if ($owner) { $owner.GetValue('PathWasAbsent', 0) -eq 1 } else { $false }
            $retained = if ($owner) { [int]$owner.GetValue('RetainedEntries', 0) } else { 0 }
        } finally {
            if ($environment) { $environment.Dispose() }
            if ($owner) { $owner.Dispose() }
        }
        $snapshot = [ordered]@{ path=$raw; kind=[string]$kind; owned=$owned; absent=$wasAbsent; retained=$retained; directory=$directory; machine=$MachinePath }
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $fingerprint = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($snapshot | ConvertTo-Json -Compress))))).Replace('-','').ToLowerInvariant() }
        finally { $sha.Dispose() }
        if ($Request.operation -ne 'inspect' -and $Request.expected -ne $fingerprint) { Fail 'ESTALE' 'PATH changed after confirmation.' }
        $parts = if ($null -eq $raw) { @() } else { @($raw.Split(';')) }
        $current = Comparable $directory
        $old = if ($owned) { Comparable ([string]$owned) } else { $null }
        $kept = $parts
        if ($old -and ($Request.operation -eq 'install' -or ($Request.operation -eq 'remove' -and $old -eq $current))) {
            $ownedMatches = @($parts | Where-Object { $_ -ceq $owned }).Count
            if ($ownedMatches -gt $retained) {
                $index = [Array]::IndexOf($parts, $owned)
                $kept = @(); for ($i = 0; $i -lt $parts.Count; $i++) { if ($i -ne $index) { $kept += $parts[$i] } }
            }
        }
        if ($Request.operation -eq 'install') {
            if (-not (Test-Path -LiteralPath (Join-Path $directory 'dsh.cmd') -PathType Leaf)) { Fail 'ENOENT' 'The installed launcher is unavailable.' }
            $next = (@($directory) + $kept) -join ';'
            $environment = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($EnvironmentKey)
            $owner = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($OwnerKey)
            try {
                $environment.SetValue('Path', $next, $kind)
                $owner.SetValue('Directory', $directory, [Microsoft.Win32.RegistryValueKind]::String)
                $absent = ($null -eq $raw) -or ($owned -and $wasAbsent)
                $owner.SetValue('PathWasAbsent', [int]$absent, [Microsoft.Win32.RegistryValueKind]::DWord)
                $owner.SetValue('RetainedEntries', @($kept | Where-Object { $_ -ceq $directory }).Count, [Microsoft.Win32.RegistryValueKind]::DWord)
            } finally { $environment.Dispose(); $owner.Dispose() }
            $raw = $next
            $owned = $directory
        } elseif ($Request.operation -eq 'remove') {
            if ($kept.Count -ne $parts.Count) {
                $environment = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($EnvironmentKey)
                try {
                    if ($kept.Count -eq 0 -and $wasAbsent) { $environment.DeleteValue('Path', $false); $raw = $null }
                    else { $raw = $kept -join ';'; $environment.SetValue('Path', $raw, $kind) }
                } finally { $environment.Dispose() }
            }
            $owner = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($OwnerKey, $true)
            if ($owner -and $old -eq $current) {
                try { $owner.DeleteValue('Directory', $false); $owner.DeleteValue('PathWasAbsent', $false); $owner.DeleteValue('RetainedEntries', $false) }
                finally { $owner.Dispose() }
                $owned = $null
            } elseif ($owner) {
                $owner.Dispose()
            }
        }
        $active = $null
        foreach ($part in (($MachinePath + ';' + [string]$raw).Split(';'))) {
            $path = [Environment]::ExpandEnvironmentVariables($part.Trim().Trim('"'))
            try { $rooted = [IO.Path]::IsPathRooted($path) } catch { continue }
            if (-not $rooted) { continue }
            $extensions = if ($env:PATHEXT) { @($env:PATHEXT.Split(';')) } else { @('.com','.exe','.bat','.cmd') }
            foreach ($extension in (@('.ps1') + $extensions)) {
                try {
                    $candidate = Join-Path $path ('dsh' + $extension)
                    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $active = $candidate; break }
                } catch {
                    # Invalid or unavailable PATH candidates do not prevent checking later entries.
                    continue
                }
            }
            if ($active) { break }
        }
        $onPath = @(([string]$raw).Split(';') | Where-Object { (Comparable $_) -eq $current }).Count -gt 0
        return [ordered]@{ fingerprint=$fingerprint; directory=$directory; ownedDirectory=$owned; managed=([bool]$owned -and (Comparable ([string]$owned)) -eq $current); activeCommand=$active; available=($onPath -and (Test-Path -LiteralPath (Join-Path $directory 'dsh.cmd') -PathType Leaf)) }
    } finally {
        if ($locked) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

function Send-DshCommandEnvironmentChange {
    try {
        if (-not ('DshCommandEnvironment' -as [type])) {
            Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class DshCommandEnvironment { [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, string l, uint f, uint t, out IntPtr r); }'
        }
        $ignored = [IntPtr]::Zero
        [void][DshCommandEnvironment]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [IntPtr]::Zero, 'Environment', 2, 2000, [ref]$ignored)
    } catch {
        # The PATH write is committed. A failed notification only delays other processes observing it.
        return
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    $ErrorActionPreference = 'Stop'
    [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    try {
        $inputValue = [Console]::In.ReadToEnd() | ConvertFrom-Json
        $request = @{ operation=$inputValue.operation; directory=$inputValue.directory; expected=$inputValue.expected }
        $machine = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment')
        try { $machinePath = [string]$machine.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
        finally { $machine.Dispose() }
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $state = Invoke-DshCommandPath -Request $request -EnvironmentKey 'Environment' -OwnerKey 'Software\DeepSeekHarness\Command' -MachinePath $machinePath -MutexName ('Global\DeepSeekHarness.Command.' + $sid)
        if ($request.operation -ne 'inspect') {
            Send-DshCommandEnvironmentChange
        }
        @{ ok=$true; state=$state } | ConvertTo-Json -Compress -Depth 5
    } catch {
        $code = if ($_.Exception.Data['code']) { $_.Exception.Data['code'] } else { 'EIO' }
        @{ ok=$false; code=$code; message=$_.Exception.Message } | ConvertTo-Json -Compress
        exit 1
    }
}
