# ============================================================================
#  TaskBoard.ps1  —  WebView2 ホスト
#  役割: ウィンドウ生成 / UI(HTML)の表示 / JS との postMessage ブリッジ /
#        受け取ったメッセージを Storage.ps1 の関数へ橋渡しし、状態を返す。
#  通常は start.ps1 から呼ばれる。
# ============================================================================

param(
    [string]$DataRoot,
    [string]$ConfigPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Here    = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent (Split-Path -Parent $Here)
$UiDir   = Join-Path $RepoRoot 'src\ui'
$LibDir  = Join-Path $RepoRoot 'lib'

. (Join-Path $Here 'Storage.ps1')

# ---- 設定の解決 ------------------------------------------------------------
function Resolve-Config {
    param([string]$ConfigPath, [string]$DataRootOverride)
    $cfg = $null
    if ($ConfigPath -and (Test-Path -LiteralPath $ConfigPath)) {
        $raw = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8
        try {
            $cfg = $raw | ConvertFrom-Json
        } catch {
            # JSON では \ がエスケープ記号。Windowsのパスをそのまま貼ると壊れる。
            throw @"
$ConfigPath の書式が壊れています。

JSON では「\」は特別な記号なので、Windowsのパスをそのまま貼ると読めません。
バックスラッシュを2つずつ重ねてください。

  誤: "dataRoot": "\\NAS-SERVER\share\taskboard\data"
  正: "dataRoot": "\\\\NAS-SERVER\\share\\taskboard\\data"

「/」で書く方法もあります（こちらは重ねる必要がありません）:
  "dataRoot": "//NAS-SERVER/share/taskboard/data"

元のエラー: $($_.Exception.Message)
"@
        }
    }
    $root = $DataRootOverride
    if (-not $root -and $cfg -and $cfg.dataRoot) { $root = [string]$cfg.dataRoot }
    if (-not $root) { $root = Join-Path $RepoRoot 'data\sample' }   # 既定はサンプル
    $actor = if ($cfg -and $cfg.actor) { $cfg.actor } else { $env:USERNAME }
    return [pscustomobject]@{ DataRoot = $root; Actor = $actor; ConfigPath = $ConfigPath }
}

# dataRoot が実際に使える場所を指しているかを確認し、駄目なら直し方まで示す。
function Assert-DataRoot {
    param([string]$Root, [string]$ConfigPath)
    $where = if ($ConfigPath) { $ConfigPath } else { 'コマンドラインの -DataRoot' }

    # 1) JSONのエスケープ崩れ。\b や \n が制御文字として紛れ込むと、
    #    エラーも出ないまま存在しないパスになる。見た目では気づけないので明示する。
    $ctrl = [regex]::Matches($Root, '[\x00-\x1F]')
    if ($ctrl.Count) {
        $vis = ($Root.ToCharArray() | ForEach-Object {
            $c = [int]$_
            if ($c -lt 32) { '<0x{0:X2}>' -f $c } else { $_ }
        }) -join ''
        throw @"
$where の dataRoot に制御文字が混ざっています。

  解釈されたパス: $vis

JSON では「\」が特別な記号のため、「\b」「\n」「\t」などが
別の文字に化けています。バックスラッシュを2つずつ重ねてください。

  誤: "dataRoot": "\\NAS-SERVER\board\data"
  正: "dataRoot": "\\\\NAS-SERVER\\board\\data"

「/」で書く方法もあります:
  "dataRoot": "//NAS-SERVER/board/data"
"@
    }

    # 2) board.json そのものを指してしまっている場合は、親フォルダを教える
    if ($Root -match '(?i)\.json$') {
        $parent = Split-Path -Parent $Root
        throw @"
dataRoot にはファイルではなく「フォルダ」を指定してください。

  今の指定: $Root
  正しい値: $parent

dataRoot は board.json が入っているフォルダを指します。
"@
    }

    # 3) フォルダに到達できない
    if (-not (Test-Path -LiteralPath $Root)) {
        throw @"
dataRoot のフォルダに接続できません。

  指定されたパス: $Root
  設定した場所  : $where

確認してください:
  - そのフォルダがNAS上に実在するか（エクスプローラーのアドレス欄に貼って確認）
  - ネットワークに接続できているか / 共有にアクセス権があるか
  - パスの綴り（JSONではバックスラッシュを2つずつ重ねます）
"@
    }

    # 4) フォルダはあるが board.json が無い＝置き場所を1階層間違えている可能性が高い
    if (-not (Test-Path -LiteralPath (Get-BoardPath $Root))) {
        $hint = ''
        # 一階層下に board.json があるなら、それが正解である可能性が高い
        $sub = Get-ChildItem -LiteralPath $Root -Directory -ErrorAction SilentlyContinue |
               Where-Object { Test-Path -LiteralPath ([System.IO.Path]::Combine($_.FullName, 'board.json')) } |
               Select-Object -First 1
        if ($sub) {
            $hint = "`n`nもしかして、こちらではありませんか:`n  $($sub.FullName)"
        }
        throw @"
指定されたフォルダに board.json がありません。

  指定されたパス: $Root
  探したファイル: $(Get-BoardPath $Root)

dataRoot は「board.json が直接入っているフォルダ」を指定します。

はじめて使う場合は、リポジトリの
  data\template\board.json
を そのフォルダへコピーしてください。weeks などは自動で作られます。$hint
"@
    }
}

$Config     = Resolve-Config -ConfigPath $ConfigPath -DataRootOverride $DataRoot
$DataRoot   = $Config.DataRoot
$Actor      = $Config.Actor

Assert-DataRoot -Root $DataRoot -ConfigPath $Config.ConfigPath

# 必要なサブフォルダ（weeks / .locks / backup）を毎回確認して作る。
# board.json だけを置いた状態（data\template をNASにコピーした直後など）でも
# 動くようにするため、board.json の有無にかかわらず実行する。冪等なので毎回でよい。
Initialize-DataRoot $DataRoot
Write-Host "データの場所: $DataRoot" -ForegroundColor DarkGray
try { Backup-DataDaily $DataRoot } catch { Write-Host "バックアップ警告: $($_.Exception.Message)" -ForegroundColor Yellow }

# ---- WebView2 / WinForms アセンブリ ---------------------------------------
Add-Type -Namespace TB -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern System.IntPtr LoadLibrary(string path);
'@

function Import-WebView2 {
    param([string]$LibDir)
    $core     = Join-Path $LibDir 'Microsoft.Web.WebView2.Core.dll'
    $winforms = Join-Path $LibDir 'Microsoft.Web.WebView2.WinForms.dll'
    if (-not (Test-Path -LiteralPath $core) -or -not (Test-Path -LiteralPath $winforms)) {
        throw @"
WebView2 の DLL が lib フォルダにありません。
  $core
  $winforms
setup-webview2.ps1 を実行すると自動で取得・配置できます。
手動で行う場合は lib\README.md の手順を参照してください。（配置するだけ。ビルドは不要です）
"@
    }

    # WebView2Loader.dll はネイティブDLL。.NET Framework は NuGet の
    # runtimes\<rid>\native\ を自動では解決しないため、実行中プロセスのアーキテクチャに
    # 合うものを明示的に読み込んでおく。先に読み込んでおけば、後続の P/Invoke は
    # 読み込み済みモジュールを再利用する。
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -and [Environment]::Is64BitProcess) { 'win-arm64' }
            elseif ([Environment]::Is64BitProcess) { 'win-x64' }
            else { 'win-x86' }
    $loader = Join-Path $LibDir "runtimes\$arch\native\WebView2Loader.dll"
    if (Test-Path -LiteralPath $loader) {
        if ([TB.Native]::LoadLibrary($loader) -eq [IntPtr]::Zero) {
            $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
            throw "WebView2Loader.dll を読み込めませんでした（$arch, Win32エラー $err）: $loader"
        }
    } else {
        throw @"
WebView2Loader.dll が見つかりません（$arch 用）。
  $loader
setup-webview2.ps1 を実行して取得してください。
"@
    }

    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    Add-Type -Path $core
    Add-Type -Path $winforms
}

# ---- 状態のJSON化して JS へ送る -------------------------------------------
$script:Web = $null

function Send-ToUi {
    param([hashtable]$Msg)
    if (-not $script:Web -or -not $script:Web.CoreWebView2) { return }
    $json = $Msg | ConvertTo-Json -Depth 20 -Compress
    $script:Web.CoreWebView2.PostWebMessageAsJson($json)
}

function Send-State {
    param([string]$WeekId)
    $board = Get-Board $DataRoot
    $weeks = Get-WeekList $DataRoot
    if (-not $WeekId) {
        $cur = Get-IsoWeekId (Get-Date)
        $WeekId = if ($weeks | Where-Object { $_.id -eq $cur }) { $cur }
                  elseif ($weeks.Count) { $weeks[0].id } else { $cur }
    }
    $week = Get-OrCreateWeek $DataRoot $WeekId
    $today = (Get-Date).ToString('yyyy-MM-dd')
    # 締め忘れ判定: 過去週で未締めなら促す
    $needsClose = (-not $week.closed) -and ($week.range.end -lt $today)

    $access = Test-DataRootAccess $DataRoot
    $locks  = Get-EditLocks -Root $DataRoot -WeekId $WeekId -ExcludeActor $Actor

    $script:CurrentWeekId = $WeekId
    $script:LastStamp     = Get-WeekStamp $DataRoot $WeekId

    Send-ToUi @{
        type       = 'state'
        board      = $board
        week       = $week
        weeks      = $weeks
        view       = 'board'
        today      = $today
        needsClose = $needsClose
        locks      = $locks
        readOnly   = (-not $access.writable)
        connected  = $access.readable
        syncText   = if ($access.writable) { "同期済 $((Get-Date).ToString('HH:mm'))" } else { $access.message }
    }
}

function Send-Toast { param([string]$Text) Send-ToUi @{ type = 'toast'; text = $Text } }
function Send-Error { param([string]$Text) Send-ToUi @{ type = 'error'; message = $Text } }

# ---- JS からのメッセージ処理 ----------------------------------------------
$script:CurrentWeekId  = $null
$script:LastStamp      = ''
$script:HeldLockTaskId = $null

function Invoke-UiMessage {
    param($msg)
    try {
        switch ($msg.type) {
            'ready' {
                $script:CurrentWeekId = $null
                Send-State $null
            }
            'changeWeek' {
                $script:CurrentWeekId = $msg.weekId
                Send-State $msg.weekId
            }
            'gotoCurrentWeek' {
                $cur = Get-IsoWeekId (Get-Date)
                $script:CurrentWeekId = $cur
                Send-State $cur
            }
            'moveTask' {
                Move-Task -Root $DataRoot -WeekId $msg.weekId -TaskId $msg.taskId -ToStatus $msg.to -Actor $Actor
                # ドロップ位置も一緒に届いていれば続けて並び替える
                if ((Test-HasField $msg 'beforeTaskId')) {
                    Set-TaskOrder -Root $DataRoot -WeekId $msg.weekId -TaskId $msg.taskId -BeforeTaskId ([string]$msg.beforeTaskId) -Actor $Actor
                }
                Send-State $msg.weekId
            }
            'createTask' {
                $id = Add-Task -Root $DataRoot -WeekId $msg.weekId -Fields $msg.fields -Actor $Actor
                Send-State $msg.weekId
                Send-Toast "タスクを作成しました"
            }
            'updateTask' {
                Update-Task -Root $DataRoot -WeekId $msg.weekId -TaskId $msg.taskId -Fields $msg.fields -Actor $Actor
                Send-State $msg.weekId
                Send-Toast "保存しました"
            }
            'deleteTask' {
                Remove-Task -Root $DataRoot -WeekId $msg.weekId -TaskId $msg.taskId -Actor $Actor
                Send-State $msg.weekId
                Send-Toast "削除しました"
            }
            'lockTask' {
                Set-EditLock -Root $DataRoot -WeekId $msg.weekId -TaskId $msg.taskId -Actor $Actor
                $script:HeldLockTaskId = $msg.taskId
            }
            'unlockTask' {
                Remove-EditLock -Root $DataRoot -WeekId $msg.weekId -TaskId $msg.taskId
                $script:HeldLockTaskId = $null
            }
            'loadRetro' {
                $retro = Get-RetroSummary -Root $DataRoot -Limit 12
                Send-ToUi @{ type = 'retro'; weeks = $retro }
            }
            'createGoal' {
                Add-Goal -Root $DataRoot -WeekId $msg.weekId -Title $msg.title -Actor $Actor | Out-Null
                Send-State $msg.weekId
                Send-Toast "目標を追加しました"
            }
            'updateGoal' {
                Update-Goal -Root $DataRoot -WeekId $msg.weekId -GoalId $msg.goalId -Fields $msg.fields -Actor $Actor
                Send-State $msg.weekId
                Send-Toast "目標を保存しました"
            }
            'deleteGoal' {
                $n = Remove-Goal -Root $DataRoot -WeekId $msg.weekId -GoalId $msg.goalId -Actor $Actor
                Send-State $msg.weekId
                Send-Toast $(if ($n) { "目標を削除しました（タスク $n 件の紐づけを解除）" } else { "目標を削除しました" })
            }
            'createContinuingGoal' {
                Add-ContinuingGoal -Root $DataRoot -Title $msg.title -Actor $Actor | Out-Null
                Send-State $script:CurrentWeekId
                Send-Toast "継続目標を追加しました"
            }
            'updateContinuingGoal' {
                Update-ContinuingGoal -Root $DataRoot -GoalId $msg.goalId -Fields $msg.fields -Actor $Actor
                Send-State $script:CurrentWeekId
                Send-Toast "継続目標を保存しました"
            }
            'deleteContinuingGoal' {
                Remove-ContinuingGoal -Root $DataRoot -GoalId $msg.goalId -Actor $Actor
                Send-State $script:CurrentWeekId
                Send-Toast "継続目標を削除しました"
            }
            'createMember' {
                Add-BoardMember -Root $DataRoot -Fields $msg.fields -Actor $Actor | Out-Null
                Send-State $script:CurrentWeekId
                Send-Toast "メンバーを追加しました"
            }
            'updateMember' {
                Update-BoardMember -Root $DataRoot -MemberId $msg.memberId -Fields $msg.fields -Actor $Actor
                Send-State $script:CurrentWeekId
                Send-Toast "メンバーを保存しました"
            }
            'deleteMember' {
                $n = Remove-BoardMember -Root $DataRoot -MemberId $msg.memberId -Actor $Actor
                Send-State $script:CurrentWeekId
                Send-Toast $(if ($n) { "メンバーを削除しました（タスク $n 件の担当を解除）" } else { "メンバーを削除しました" })
            }
            'createProject' {
                Add-Project -Root $DataRoot -Name $msg.name -Actor $Actor | Out-Null
                Send-State $script:CurrentWeekId
                Send-Toast "案件を追加しました"
            }
            'updateProject' {
                Update-Project -Root $DataRoot -ProjectId $msg.projectId -Fields $msg.fields -Actor $Actor
                Send-State $script:CurrentWeekId
                Send-Toast "案件を保存しました"
            }
            'deleteProject' {
                $n = Remove-Project -Root $DataRoot -ProjectId $msg.projectId -Actor $Actor
                Send-State $script:CurrentWeekId
                Send-Toast $(if ($n) { "案件を削除しました（タスク $n 件の紐づけを解除）" } else { "案件を削除しました" })
            }
            'loadUsage' {
                $u = Get-UsageCount -Root $DataRoot -Kind $msg.kind -Id $msg.id
                Send-ToUi @{ type = 'usage'; kind = $msg.kind; id = $msg.id; total = $u.total; unclosed = $u.unclosed }
            }
            'reorderTask' {
                Set-TaskOrder -Root $DataRoot -WeekId $msg.weekId -TaskId $msg.taskId -BeforeTaskId $msg.beforeTaskId -Actor $Actor
                Send-State $msg.weekId
            }
            'closeWeek' {
                # JS の judgements は PSCustomObject で届くのでハッシュに詰め替える
                $judge = @{}
                if ($msg.judgements) {
                    foreach ($p in $msg.judgements.PSObject.Properties) { $judge[$p.Name] = [string]$p.Value }
                }
                $carry = @()
                if ($msg.carryTaskIds) { $carry = @($msg.carryTaskIds) }
                $nextId = Close-Week -Root $DataRoot -WeekId $msg.weekId -Judgements $judge -CarryTaskIds $carry -Actor $Actor
                $script:CurrentWeekId = $nextId
                Send-State $nextId
                Send-Toast "$($msg.weekId) を締めました。$nextId を開いています。"
            }
            default     { Send-Toast "未対応の操作: $($msg.type)" }
        }
    } catch {
        Send-Error $_.Exception.Message
    }
}

# ---- ウィンドウ生成 --------------------------------------------------------
function Start-App {
    Import-WebView2 -LibDir $LibDir

    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'タスクボード'
    $form.Width = 1280
    $form.Height = 820
    $form.StartPosition = 'CenterScreen'

    $web = New-Object Microsoft.Web.WebView2.WinForms.WebView2
    $web.Dock = [System.Windows.Forms.DockStyle]::Fill
    $form.Controls.Add($web)
    $script:Web = $web

    # ユーザーデータ(キャッシュ)はローカルに置く。NASには置かない。
    $udf = Join-Path $env:LOCALAPPDATA 'TaskBoard\WebView2'
    if (-not (Test-Path -LiteralPath $udf)) { New-Item -ItemType Directory -Path $udf -Force | Out-Null }
    $envTask = [Microsoft.Web.WebView2.Core.CoreWebView2Environment]::CreateAsync($null, $udf, $null)

    $web.add_CoreWebView2InitializationCompleted({
        param($src, $e)
        if (-not $e.IsSuccess) {
            [System.Windows.Forms.MessageBox]::Show("WebView2 の初期化に失敗しました。`nEvergreen ランタイムが導入されているか確認してください。", "タスクボード") | Out-Null
            return
        }
        $cw = $src.CoreWebView2
        # UIフォルダを仮想ホストにマッピング（file:// を使わず https 相当で動かす）
        $cw.SetVirtualHostNameToFolderMapping('taskboard.local', $UiDir,
            [Microsoft.Web.WebView2.Core.CoreWebView2HostResourceAccessKind]::Allow)
        $cw.add_WebMessageReceived({
            param($s2, $e2)
            try {
                $obj = $e2.WebMessageAsJson | ConvertFrom-Json
                Invoke-UiMessage $obj
            } catch {
                Send-Error "メッセージ処理エラー: $($_.Exception.Message)"
            }
        })
        $src.Source = [uri]'https://taskboard.local/index.html'
    })

    # 環境生成の完了を待って EnsureCoreWebView2Async に渡す
    $envTask.Wait()
    $web.EnsureCoreWebView2Async($envTask.Result) | Out-Null

    # 数秒おきに週ファイルの更新時刻とNAS到達性を確認する。
    # 他PCが書き換えていたら読み直し、切断されていたら読み取り専用に落とす。
    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 5000
    $timer.add_Tick({
        try {
            if (-not $script:CurrentWeekId) { return }
            $access = Test-DataRootAccess $DataRoot
            if (-not $access.readable) {
                Send-ToUi @{ type = 'sync'; connected = $false; text = $access.message }
                return
            }
            $stamp = Get-WeekStamp $DataRoot $script:CurrentWeekId
            if ($stamp -ne $script:LastStamp) {
                Send-State $script:CurrentWeekId      # 他PCの更新を取り込む
            } else {
                Send-ToUi @{
                    type = 'sync'; connected = $true
                    text = if ($access.writable) { "同期済 $((Get-Date).ToString('HH:mm'))" } else { $access.message }
                    readOnly = (-not $access.writable)
                    locks = (Get-EditLocks -Root $DataRoot -WeekId $script:CurrentWeekId -ExcludeActor $Actor)
                }
            }
        } catch {
            Send-ToUi @{ type = 'sync'; connected = $false; text = '接続を確認しています…' }
        }
    })
    $timer.Start()

    # 終了時に自分の編集ロックを片付ける
    $form.add_FormClosing({
        try {
            $timer.Stop()
            if ($script:CurrentWeekId -and $script:HeldLockTaskId) {
                Remove-EditLock -Root $DataRoot -WeekId $script:CurrentWeekId -TaskId $script:HeldLockTaskId
            }
        } catch { }
    })

    [System.Windows.Forms.Application]::EnableVisualStyles()
    [System.Windows.Forms.Application]::Run($form)
}

Start-App
