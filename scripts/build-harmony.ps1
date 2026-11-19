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
    $sdkPath = (Join-Path $DevEcoRoot 'sdk').Replace('\', '/')
    Set-Content -LiteralPath 'local.properties' -Value "sdk.dir=$sdkPath" -Encoding utf8
    & (Join-Path $DevEcoRoot 'tools\hvigor\bin\hvigorw.bat') --mode module -p product=default -p module=entry@default assembleHap --no-daemon
    if ($LASTEXITCODE -ne 0) { throw 'HarmonyOS build failed.' }
    $hapPath = Join-Path $projectRoot 'harmony\entry\build\default\outputs\default\entry-default-unsigned.hap'
    if (Test-Path -LiteralPath $hapPath) {
        Copy-Item -LiteralPath $hapPath -Destination (Join-Path $projectRoot '.local\codesip-unsigned.hap') -Force
        Write-Output 'Unsigned HAP copied to .local/codesip-unsigned.hap. Device signing is still required.'
    }
} finally {
    Pop-Location
}
