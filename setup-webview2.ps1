# ============================================================================
#  setup-webview2.ps1  —  WebView2 の DLL を lib フォルダに用意する
#
#  NuGet の公式パッケージ Microsoft.Web.WebView2 をダウンロードし、
#  必要なDLLだけを lib\ に展開する。ビルドは不要。ネット接続が必要。
#
#  ネットにつながらないPCへ配る場合は、つながるPCで一度これを実行し、
#  lib フォルダごとコピーしてください（DLLだけあれば動きます）。
# ============================================================================

param(
    [string]$Version = '',        # 省略時は最新の安定版
    [switch]$Force                # 既に配置済みでも取り直す
)

$ErrorActionPreference = 'Stop'
$Here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$LibDir = Join-Path $Here 'lib'

$core     = Join-Path $LibDir 'Microsoft.Web.WebView2.Core.dll'
$winforms = Join-Path $LibDir 'Microsoft.Web.WebView2.WinForms.dll'

if (-not $Force -and (Test-Path -LiteralPath $core) -and (Test-Path -LiteralPath $winforms)) {
    $v = [System.Reflection.AssemblyName]::GetAssemblyName($core).Version
    Write-Host "配置済みです（v$v）。取り直すには -Force を付けてください。" -ForegroundColor Green
    return
}

# nuget.org は TLS 1.2 以上を要求する。PowerShell 5.1 の既定は古いので明示する。
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (-not $Version) {
    Write-Host "最新版を確認しています..." -ForegroundColor Cyan
    $idx = Invoke-RestMethod -Uri 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/index.json' -TimeoutSec 30
    # プレリリース（1.0.xxx-prerelease 等）は除く
    $Version = @($idx.versions | Where-Object { $_ -notmatch '-' })[-1]
}
Write-Host "取得するバージョン: $Version" -ForegroundColor Cyan

$tmp = Join-Path $env:TEMP ("wv2_" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
    $nupkg = Join-Path $tmp 'webview2.nupkg'
    $url = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$Version/microsoft.web.webview2.$Version.nupkg"
    Write-Host "ダウンロード中..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $url -OutFile $nupkg -TimeoutSec 180
    Write-Host ("  {0:N1} MB" -f ((Get-Item $nupkg).Length / 1MB))

    $ext = Join-Path $tmp 'x'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($nupkg, $ext)

    # マネージドアセンブリの場所はバージョンによって変わる（net45 → net462 等）ので探す
    $coreSrc = Get-ChildItem (Join-Path $ext 'lib') -Recurse -Filter 'Microsoft.Web.WebView2.Core.dll' |
               Sort-Object { $_.Directory.Name } -Descending | Select-Object -First 1
    $wfSrc   = Get-ChildItem (Join-Path $ext 'lib') -Recurse -Filter 'Microsoft.Web.WebView2.WinForms.dll' |
               Sort-Object { $_.Directory.Name } -Descending | Select-Object -First 1
    if (-not $coreSrc -or -not $wfSrc) {
        throw "パッケージ内にマネージドDLLが見つかりませんでした。パッケージ構成が変わった可能性があります。"
    }

    New-Item -ItemType Directory -Path $LibDir -Force | Out-Null
    Copy-Item $coreSrc.FullName $LibDir -Force
    Copy-Item $wfSrc.FullName   $LibDir -Force
    Write-Host "配置: $($coreSrc.Directory.Name)\$($coreSrc.Name), $($wfSrc.Name)" -ForegroundColor Green

    # WebView2Loader.dll はアーキテクチャ別。あるものは全部置いて環境依存を無くす。
    foreach ($arch in @('win-x64', 'win-x86', 'win-arm64')) {
        $src = Join-Path $ext "runtimes\$arch\native\WebView2Loader.dll"
        if (-not (Test-Path -LiteralPath $src)) { continue }
        $dest = Join-Path $LibDir "runtimes\$arch\native"
        New-Item -ItemType Directory -Path $dest -Force | Out-Null
        Copy-Item $src $dest -Force
        Write-Host "配置: runtimes\$arch\native\WebView2Loader.dll" -ForegroundColor Green
    }

    $lic = Join-Path $ext 'LICENSE.txt'
    if (Test-Path -LiteralPath $lic) { Copy-Item $lic (Join-Path $LibDir 'WebView2-LICENSE.txt') -Force }

    Write-Host "`n完了しました。タスクボード.bat から起動できます。" -ForegroundColor Green
} finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
