# ============================================================================
#  start.ps1  —  タスクボード起動スクリプト（これを実行する）
#  - WinForms/WebView2 は STA スレッドを要求するため、MTA で起動された場合は
#    自分自身を -STA で起動し直す。
#  - config.local.json があれば使う。無ければ data\sample を見に行く。
# ============================================================================

param(
    [string]$DataRoot,          # 明示指定（省略時は config → sample の順）
    [switch]$Preview            # UIのみ既定ブラウザでプレビュー（WebView2不要）
)

$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

# --- UIだけを確認したいとき（ホスト不要のスタンドアロン表示） ---------------
if ($Preview) {
    Start-Process (Join-Path $Here 'src\ui\index.html')
    Write-Host "UIをスタンドアロン（プレビュー）で開きました。データ保存は行われません。" -ForegroundColor Cyan
    return
}

# --- STA 保証 ---------------------------------------------------------------
if ([System.Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA') {
    Write-Host "STA で再起動します…" -ForegroundColor DarkGray
    $psExe = (Get-Process -Id $PID).Path      # 現在のホスト（powershell.exe 等）
    $argList = @('-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', $MyInvocation.MyCommand.Path)
    if ($DataRoot) { $argList += @('-DataRoot', $DataRoot) }
    & $psExe @argList
    return
}

# --- 設定ファイルの解決 -----------------------------------------------------
$configLocal  = Join-Path $Here 'config.local.json'
$configPath   = if (Test-Path -LiteralPath $configLocal) { $configLocal } else { $null }

if (-not $DataRoot -and -not $configPath) {
    Write-Host "config.local.json が無いため data\sample を使います（お試しモード）。" -ForegroundColor Yellow
    Write-Host "本番運用では config.sample.json をコピーして config.local.json を作り、NASパスを設定してください。" -ForegroundColor Yellow
}

& (Join-Path $Here 'src\host\TaskBoard.ps1') -DataRoot $DataRoot -ConfigPath $configPath
