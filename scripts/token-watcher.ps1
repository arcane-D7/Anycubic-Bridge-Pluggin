param(
    [ValidateSet('scan', 'watch')]
    [string]$Mode = 'scan',
    [int]$MaxSeconds = 120,
    [string]$Filter = 'access_token'
)

# Memory scraper for the Anycubic cloud access_token (JWT).
#
# The 1.4.1.2 app stores the token encrypted on disk, but while the user is
# logged in the JWT (eyJ...<payload>...<sig>) is held in process memory — either
# in the main process or in the EBWebView (WebView2) child that renders the
# account UI. We scan the readable private memory of every AnycubicSlicerNext
# process for JWT-shaped strings and emit the best candidate as JSON.
#
# Modes:
#   scan  -> one pass, print result, exit.
#   watch -> poll until a JWT is found or MaxSeconds expires (stays silent
#            until then; the caller shows the "you will be logged out" notice).
#
# Output JSON: { ok, found, token?, sub?, email?, expires_at?, source?, error? }

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class TokenMemApi {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ReadProcessMemory(IntPtr hProcess, IntPtr lpBaseAddress, byte[] lpBuffer, int dwSize, out int lpNumberOfBytesRead);
    [DllImport("kernel32.dll")]
    public static extern bool VirtualQueryEx(IntPtr hProcess, IntPtr lpAddress, out MEMORY_BASIC_INFORMATION lpBuffer, int dwLength);
    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr hObject);
    [StructLayout(LayoutKind.Sequential)]
    public struct MEMORY_BASIC_INFORMATION {
        public IntPtr BaseAddress;
        public IntPtr AllocationBase;
        public uint AllocationProtect;
        public IntPtr RegionSize;
        public uint State;
        public uint Protect;
        public uint Type;
    }
}
'@

function Get-ReadableRegions([IntPtr]$hProcess) {
    $regions = @()
    $address = [IntPtr]::Zero
    $chunk = 0x10000
    while ($true) {
        $mbi = New-Object TokenMemApi+MEMORY_BASIC_INFORMATION
        $ok = [TokenMemApi]::VirtualQueryEx($hProcess, $address, [ref]$mbi, [Runtime.InteropServices.Marshal]::SizeOf($mbi))
        if (-not $ok) { break }
        $size = $mbi.RegionSize.ToInt64()
        $isReadable = ($mbi.State -eq 0x1000) -and (($mbi.Protect -band 0xFE) -in (0x02, 0x04, 0x20, 0x40, 0x80))
        $notImage = $mbi.Type -ne 0x1000000   # skip exe/dll image mappings (dumb scanner, faster)
        if ($isReadable -and $notImage -and $size -gt 0 -and $size -le 0x4000000) {
            $regions += [pscustomobject]@{ Base = $mbi.BaseAddress; Size = $size }
        }
        $next = $mbi.BaseAddress.ToInt64() + $size
        if ($next -le $address.ToInt64()) { $next = $address.ToInt64() + $chunk }
        $address = [IntPtr]$next
    }
    return , $regions
}

function Get-JwtCandidates([IntPtr]$hProcess) {
    $candidates = @()
    foreach ($region in (Get-ReadableRegions $hProcess)) {
        $size = [Math]::Min([int]$region.Size, 0x200000)  # read in <=2MB chunks
        $buf = New-Object byte[] $size
        $read = 0
        $ok = [TokenMemApi]::ReadProcessMemory($hProcess, $region.Base, $buf, $size, [ref]$read)
        if (-not $ok -or $read -le 0) { continue }
        $script:ScanCounter += $read
        $chunk = [System.Text.Encoding]::ASCII.GetString($buf, 0, $read)
        $matches = [regex]::Matches($chunk, 'eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}')
        foreach ($m in $matches) {
            $candidates += $m.Value
        }
    }
    return , ($candidates | Select-Object -Unique -First 20)
}

function Test-JwtLike([string]$token) {
    # JWT has 3 dot-separated, base64url segments; payload decodes to JSON.
    $parts = $token.Split('.')
    if ($parts.Count -ne 3) { return $false }
    if ($parts[0].Length -lt 10 -or $parts[2].Length -lt 10) { return $false }
    try {
        $payload = $parts[1].Replace('-', '+').Replace('_', '/')
        switch ($payload.Length % 4) { 2 { $payload += '==' }; 3 { $payload += '=' } }
        $json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($payload))
        $null = $json | ConvertFrom-Json
        return $json
    } catch {
        return $false
    }
}

function Get-ProcessIdsByName([string]$name) {
    , @(Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
}

$script:ScanCounter = 0

# Score a JWT candidate. The app's Casdoor JWT normally has sub + exp (+email);
# some responses embed the token as {"access_token":"eyJ..."}. Higher is better.
function Get-JwtScore([string]$jwt, [string]$payloadJson) {
    try {
        $payload = $payloadJson | ConvertFrom-Json -ErrorAction SilentlyContinue
    } catch {
        return 0
    }
    if (-not $payload) { return 0 }
    $score = 0
    if ($payload.access_token -or $payload.accessToken) { $score += 100 }
    $iss = [string]$payload.iss
    if ($iss -match 'anycubic|makeronline|casdoor') { $score += 60 }
    if ($payload.sub) { $score += 30 }
    if ($payload.exp -and [int64]$payload.exp -gt 0) { $score += 20 }
    if ($payload.email -or $payload.user_email) { $score += 10 }
    return $score
}

function Read-BestToken {
    $PROCESS_VM_READ = 0x0010
    $PROCESS_QUERY_INFORMATION = 0x0400
    $best = $null
    $bestSource = ''
    $bestScore = 0
    # App + its WebView2 children first (high confidence), plain browser last.
    $appNames = @('AnycubicSlicerNext', 'msedgewebview2', 'msedge')
    foreach ($name in $appNames) {
        foreach ($procId in (Get-ProcessIdsByName $name)) {
            $h = [TokenMemApi]::OpenProcess(($PROCESS_VM_READ -bor $PROCESS_QUERY_INFORMATION), $false, $procId)
            if ($h -eq [IntPtr]::Zero) { continue }
            try {
                foreach ($candidate in (Get-JwtCandidates $h)) {
                    $payloadJson = Test-JwtLike $candidate
                    if ($payloadJson -eq $false) { continue }
                    $score = Get-JwtScore $candidate $payloadJson
                    if ($score -ge 50 -and $score -gt $bestScore) {
                        $best = $candidate
                        $bestSource = $name
                        $bestScore = $score
                        # A token with access_token/accessToken field is definitive.
                        if ($score -ge 100) { break }
                    }
                }
            } finally {
                [TokenMemApi]::CloseHandle($h)
            }
            if ($bestScore -ge 100) { break }
        }
        if ($bestScore -ge 100) { break }
    }
    $payloadJson = $null
    if ($best) { $payloadJson = Test-JwtLike $best }
    if (-not $best) {
        return [pscustomobject]@{
            found = $false
            token = $null
            sub = $null
            email = $null
            expires_at = $null
            source = $null
            bytes_scanned = $script:ScanCounter
        }
    }
    $obj = $payloadJson | ConvertFrom-Json -ErrorAction SilentlyContinue
    $sub = $obj.sub
    $email = if ($obj.email) { $obj.email } elseif ($obj.user_email) { $obj.user_email } else { $null }
    $exp = if ($obj.exp) { ([DateTimeOffset]::FromUnixTimeSeconds([int64]$obj.exp)).UtcDateTime.ToString('s') + 'Z' } else { $null }
    return [pscustomobject]@{
        found = $true
        token = $best
        sub = $sub
        email = $email
        expires_at = $exp
        source = $bestSource
        bytes_scanned = $script:ScanCounter
    }
}

$result = $null
if ($Mode -eq 'scan') {
    $found = Read-BestToken
    $result = [ordered]@{
        ok = $true
        found = [bool]$found.found
        token = $found.token
        sub = $found.sub
        email = $found.email
        expires_at = $found.expires_at
        source = $found.source
        bytes_scanned = $found.bytes_scanned
    }
} else {
    $deadline = [DateTime]::UtcNow.AddSeconds($MaxSeconds)
    $lastReport = [DateTime]::UtcNow.AddSeconds(-5)
    while ([DateTime]::UtcNow -lt $deadline) {
        $found = Read-BestToken
        if ($found.found) {
            $result = [ordered]@{
                ok = $true
                found = $true
                token = $found.token
                sub = $found.sub
                email = $found.email
                expires_at = $found.expires_at
                source = $found.source
                bytes_scanned = $found.bytes_scanned
            }
            break
        }
        # Report every 5s so a long-running caller can render progress.
        if (([DateTime]::UtcNow - $lastReport).TotalSeconds -ge 5) {
            Write-Output (([ordered]@{ ok = $true; found = $false; bytes_scanned = $found.bytes_scanned } | ConvertTo-Json -Compress))
            $lastReport = [DateTime]::UtcNow
        }
        Start-Sleep -Seconds 1
    }
    if (-not $result) {
        $result = [ordered]@{ ok = $true; found = $false; error = "No JWT found within ${MaxSeconds}s. Make sure the account is logged in (or re-login first)." }
    }
}

$result | ConvertTo-Json -Compress
