param(
    [ValidateSet('encrypt', 'decrypt')]
    [string]$Action = 'encrypt'
)

# DPAPI-encrypt (CurrentUser scope) a plaintext token, or decrypt a base64
# DPAPI blob. The token travels ONLY via environment variable so it never
# appears on the command line. Base64 <-> binary mapping is done by the Node
# wrapper so no temp files are needed.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

if ($Action -eq 'encrypt') {
    $plain = $env:TOKEN_CRYPT_PLAINTEXT
    if (-not $plain) { throw 'TOKEN_CRYPT_PLAINTEXT is empty' }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($plain)
    $protected = [System.Security.Cryptography.ProtectedData]::Protect(
        $bytes,
        $null,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    [System.Convert]::ToBase64String($protected)
} else {
    $b64 = $env:TOKEN_CRYPT_BASE64
    if (-not $b64) { throw 'TOKEN_CRYPT_BASE64 is empty' }
    $protected = [System.Convert]::FromBase64String($b64)
    $bytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $protected,
        $null,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    [System.Text.Encoding]::UTF8.GetString($bytes)
}
