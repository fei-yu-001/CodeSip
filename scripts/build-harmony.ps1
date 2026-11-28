param(
    [string]$DevEcoRoot = 'D:\qiqi_me\HarmonyOS\tools\DevEcoStudio'
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$env:JAVA_HOME = Join-Path $DevEcoRoot 'jbr'
$env:DEVECO_SDK_HOME = Join-Path $DevEcoRoot 'sdk'
$env:HVIGOR_USER_HOME = Join-Path $projectRoot '.local\hvigor'
$env:PATH = (Join-Path $DevEcoRoot 'tools\node') + ';' + (Join-Path $DevEcoRoot 'tools\ohpm\bin') + ';' + $env:PATH
Push-Location (Join-Path $projectRoot 'harmony')
try {
    $sdkPath = (Join-Path $DevEcoRoot 'sdk\default').Replace('\', '/')
    Set-Content -LiteralPath 'local.properties' -Value "sdk.dir=$sdkPath" -Encoding utf8
    & (Join-Path $DevEcoRoot 'tools\hvigor\bin\hvigorw.bat') --mode module -p product=default -p module=entry@default assembleHap --no-daemon
    if ($LASTEXITCODE -ne 0) { throw 'HarmonyOS build failed.' }
    $signedHap = Join-Path $projectRoot 'harmony\entry\build\default\outputs\default\entry-default-signed.hap'
    $unsignedHap = Join-Path $projectRoot 'harmony\entry\build\default\outputs\default\entry-default-unsigned.hap'
    if (Test-Path -LiteralPath $signedHap) {
        Copy-Item -LiteralPath $signedHap -Destination (Join-Path $projectRoot '.local\codesip-signed.hap') -Force
        Write-Output 'Signed HAP copied to .local/codesip-signed.hap.'
    } elseif (Test-Path -LiteralPath $unsignedHap) {
        Copy-Item -LiteralPath $unsignedHap -Destination (Join-Path $projectRoot '.local\codesip-unsigned.hap') -Force
        Write-Output 'Unsigned HAP copied to .local/codesip-unsigned.hap. Device signing is still required.'
    }
} finally {
    Pop-Location
}
