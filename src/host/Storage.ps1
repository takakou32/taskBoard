# ============================================================================
#  Storage.ps1  —  タスクボードのデータ層
#  役割: NAS上のJSON読み書き / 週単位のファイルロック / 週リスト / 週の締め
#  データ配置:
#     <DataRoot>\board.json           … メンバー・案件・継続目標・設定（共有・小）
#     <DataRoot>\weeks\2026-W30.json   … 週ごとの目標とタスク（1週1ファイル）
#     <DataRoot>\.locks\<name>.lock    … 書き込み調停用の排他ロック
#     <DataRoot>\backup\<date>\...     … 日次世代バックアップ
#  すべての関数は「読み込み→変更→書き込み」を週ロック下で行う。
# ============================================================================

Set-StrictMode -Version Latest

# ---- パス ------------------------------------------------------------------
# Join-Path は存在しないドライブ（切断されたNAS）で失敗し余計なエラーを出すため、
# ドライブ検証をしない [IO.Path]::Combine を使う。
function Get-BoardPath  { param($Root) [System.IO.Path]::Combine($Root, 'board.json') }
function Get-WeeksDir   { param($Root) [System.IO.Path]::Combine($Root, 'weeks') }
function Get-WeekPath   { param($Root, $WeekId) [System.IO.Path]::Combine((Get-WeeksDir $Root), ("{0}.json" -f $WeekId)) }
function Get-LocksDir   { param($Root) [System.IO.Path]::Combine($Root, '.locks') }

function Initialize-DataRoot {
    param([string]$Root)
    foreach ($d in @($Root, (Get-WeeksDir $Root), (Get-LocksDir $Root), (Join-Path $Root 'backup'))) {
        if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
    }
}

# ---- JSON 入出力 -----------------------------------------------------------
# UTF-8(BOMなし)で読み書きする。PowerShell 5.1 では Out-File -Encoding utf8 が
# BOM付きになるため、.NET の UTF8Encoding($false) を明示的に使う。
function Read-JsonFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $raw = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    return $raw | ConvertFrom-Json
}

function Write-JsonFile {
    param([string]$Path, $Object)
    $json = $Object | ConvertTo-Json -Depth 20
    $enc  = New-Object System.Text.UTF8Encoding($false)
    $tmp  = "$Path.tmp"
    # 一時ファイルに書いてから差し替える。書き込み途中のファイルを他PCに読ませない。
    # .NET Framework 4.x の File.Move には上書きオーバーロードが無いため、
    # 既存を消してから移動する（書き込みは週ロック下なので競合しない）。
    [System.IO.File]::WriteAllText($tmp, $json, $enc)
    if (Test-Path -LiteralPath $Path) { [System.IO.File]::Delete($Path) }
    [System.IO.File]::Move($tmp, $Path)
}

# ---- 排他ロック ------------------------------------------------------------
# NAS(SMB)共有上でも効く排他制御として、FileShare.None で開いたロックファイルを
# ハンドルとして掴む。掴めなければ他PCが処理中。取得できたらスクリプトブロックを
# 実行し、必ず解放する。
# 注意: $Action は & で実行するため、PowerShell の動的スコープにより
# この関数のローカル変数が呼び出し側スクリプトブロック内の同名変数を隠す。
# 変数名の照合は大文字小文字を区別しないので、パラメータ名は呼び出し側が
# 使いそうにない名前（LockName / LockTimeoutMs）にしてある。ここを $Name に
# 戻すと、スクリプトブロック内の $name がロック名にすり替わる。
function Invoke-WithLock {
    param(
        [string]$Root,
        [string]$LockName,      # ロック名（週ID や 'board'）
        [scriptblock]$Action,
        [int]$LockTimeoutMs = 4000
    )
    $TimeoutMs = $LockTimeoutMs
    $lockPath = [System.IO.Path]::Combine((Get-LocksDir $Root), ("{0}.lock" -f ($LockName -replace '[^\w\-]', '_')))
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    $stream = $null
    while ($true) {
        try {
            $stream = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate,
                        [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
            break
        } catch [System.IO.IOException] {
            if ([DateTime]::UtcNow -gt $deadline) {
                throw "ロックを取得できませんでした（$LockName）。他のPCが処理中の可能性があります。"
            }
            Start-Sleep -Milliseconds 120
        }
    }
    try {
        return & $Action
    } finally {
        if ($stream) { $stream.Close(); $stream.Dispose() }
    }
}

# ---- 週ID ユーティリティ（ISO 8601週・月曜始まり） -------------------------
function Get-IsoWeekId {
    param([datetime]$Date = (Get-Date))
    $cal  = [System.Globalization.CultureInfo]::InvariantCulture.Calendar
    $day  = $cal.GetDayOfWeek($Date)
    # ISO: 木曜日を含む週がその年の週。木曜へ寄せてから年と週番号を取る。
    $delta = 3 - (([int]$day + 6) % 7)   # 月=0..日=6 に直して木曜(3)との差
    $thu = $Date.AddDays($delta)
    $week = $cal.GetWeekOfYear($thu, [System.Globalization.CalendarWeekRule]::FirstFourDayWeek, [DayOfWeek]::Monday)
    return "{0:D4}-W{1:D2}" -f $thu.Year, $week
}

function Get-WeekRange {
    param([string]$WeekId)
    # "2026-W30" → 月曜〜日曜の日付。ISO週の月曜を求める。
    if ($WeekId -notmatch '^(\d{4})-W(\d{2})$') { throw "週IDが不正です: $WeekId" }
    $year = [int]$Matches[1]; $week = [int]$Matches[2]
    $jan4 = Get-Date -Year $year -Month 1 -Day 4 -Hour 0 -Minute 0 -Second 0
    $jan4Dow = (([int]$jan4.DayOfWeek + 6) % 7)      # 月=0
    $week1Mon = $jan4.AddDays(-$jan4Dow)
    $mon = $week1Mon.AddDays(7 * ($week - 1))
    $sun = $mon.AddDays(6)
    return [ordered]@{ start = $mon.ToString('yyyy-MM-dd'); end = $sun.ToString('yyyy-MM-dd') }
}

# ---- 週リスト --------------------------------------------------------------
# 戻り値は常に配列。PowerShell は return で配列を展開してしまうため、
# 空なら $null に、1件なら単体オブジェクトになってしまう。
# 呼び出し側が .Count や [0] を使えるよう、先頭のカンマで配列のまま返す。
function Get-WeekList {
    param([string]$Root)
    $dir = Get-WeeksDir $Root
    if (-not (Test-Path -LiteralPath $dir)) { return ,@() }
    $list = @()
    Get-ChildItem -LiteralPath $dir -Filter '*.json' -File | ForEach-Object {
        $id = [System.IO.Path]::GetFileNameWithoutExtension($_.Name)
        if ($id -match '^\d{4}-W\d{2}$') {
            $w = Read-JsonFile $_.FullName
            $list += [ordered]@{
                id     = $id
                range  = if ($w -and $w.range) { $w.range } else { Get-WeekRange $id }
                closed = if ($w -and ($w.PSObject.Properties.Name -contains 'closed')) { [bool]$w.closed } else { $false }
            }
        }
    }
    # 新しい順
    return ,@($list | Sort-Object { $_.id } -Descending)
}

# ---- board / week の取得 ---------------------------------------------------
function Get-Board {
    param([string]$Root)
    $b = Read-JsonFile (Get-BoardPath $Root)
    if (-not $b) { throw "board.json が見つかりません: $(Get-BoardPath $Root)" }
    return $b
}

function Get-Week {
    param([string]$Root, [string]$WeekId)
    return Read-JsonFile (Get-WeekPath $Root $WeekId)
}

# 週が無ければ空の週を作って返す（新しい週を初めて開いたとき）
function Get-OrCreateWeek {
    param([string]$Root, [string]$WeekId)
    $path = Get-WeekPath $Root $WeekId
    if (Test-Path -LiteralPath $path) { return Read-JsonFile $path }
    $range = Get-WeekRange $WeekId
    $week = [ordered]@{
        schemaVersion = 1
        id     = $WeekId
        range  = $range
        closed = $false
        goals  = @()
        tasks  = @()
    }
    Invoke-WithLock -Root $Root -LockName $WeekId -Action { Write-JsonFile $path $week }
    return (Read-JsonFile $path)
}

# ---- タスク操作 ------------------------------------------------------------
function Move-Task {
    param([string]$Root, [string]$WeekId, [string]$TaskId, [string]$ToStatus, [string]$Actor = 'unknown')
    $valid = @('todo','doing','review','done')
    if ($ToStatus -notin $valid) { throw "不正なステータス: $ToStatus" }
    Invoke-WithLock -Root $Root -LockName $WeekId -Action {
        $path = Get-WeekPath $Root $WeekId
        $week = Read-JsonFile $path
        if (-not $week) { throw "週が見つかりません: $WeekId" }
        if ($week.closed) { throw "締め済みの週は編集できません: $WeekId" }
        $task = $week.tasks | Where-Object { $_.id -eq $TaskId } | Select-Object -First 1
        if (-not $task) { throw "タスクが見つかりません: $TaskId" }
        $from = $task.status
        if ($from -ne $ToStatus) {
            $task.status = $ToStatus
            Add-ItemHistory -Item $task -Text ("{0}: {1} → {2}" -f $Actor, $from, $ToStatus)
            Write-JsonFile $path $week
        }
    }
}

# 新規タスクを追加して、生成したIDを返す。
# $Fields は JS から来た任意項目（title/goalId/continuingGoalId/assignees/due/priority/projectId/description/subtasks/status）。
function Add-Task {
    param([string]$Root, [string]$WeekId, $Fields, [string]$Actor = 'unknown')
    Invoke-WithLock -Root $Root -LockName $WeekId -Action {
        $path = Get-WeekPath $Root $WeekId
        $week = Read-JsonFile $path
        if (-not $week) { throw "週が見つかりません: $WeekId" }
        if ($week.closed) { throw "締め済みの週にはタスクを追加できません: $WeekId" }

        $title = [string](Get-FieldOrDefault $Fields 'title' '')
        if ([string]::IsNullOrWhiteSpace($title)) { throw "タイトルを入力してください。" }

        $status = [string](Get-FieldOrDefault $Fields 'status' 'todo')
        if ($status -notin @('todo','doing','review','done')) { $status = 'todo' }

        $task = [ordered]@{
            id               = New-Id 't'
            title            = $title.Trim()
            status           = $status
            goalId           = Get-FieldOrDefault $Fields 'goalId' $null
            continuingGoalId = Get-FieldOrDefault $Fields 'continuingGoalId' $null
            assignees        = @(Get-FieldOrDefault $Fields 'assignees' @())
            due              = Get-FieldOrDefault $Fields 'due' $week.range.end
            priority         = Get-FieldOrDefault $Fields 'priority' 'normal'
            projectId        = Get-FieldOrDefault $Fields 'projectId' $null
            description      = Get-FieldOrDefault $Fields 'description' ''
            subtasks         = ConvertTo-Subtasks (Get-FieldOrDefault $Fields 'subtasks' @())
            carriedFrom      = $null
            history          = @()
        }
        Add-ItemHistory -Item $task -Text ("{0}: 作成" -f $Actor)
        $week.tasks = @($week.tasks) + $task
        Write-JsonFile $path $week
        return $task.id
    }
}

# 既存タスクを部分更新する。$Fields に含まれる項目だけを書き換える。
function Update-Task {
    param([string]$Root, [string]$WeekId, [string]$TaskId, $Fields, [string]$Actor = 'unknown')
    Invoke-WithLock -Root $Root -LockName $WeekId -Action {
        $path = Get-WeekPath $Root $WeekId
        $week = Read-JsonFile $path
        if (-not $week) { throw "週が見つかりません: $WeekId" }
        if ($week.closed) { throw "締め済みの週は編集できません: $WeekId" }
        $task = $week.tasks | Where-Object { $_.id -eq $TaskId } | Select-Object -First 1
        if (-not $task) { throw "タスクが見つかりません: $TaskId" }

        $changed = @()
        foreach ($name in @('title','status','goalId','continuingGoalId','assignees','due','priority','projectId','description','subtasks')) {
            if (-not (Test-HasField $Fields $name)) { continue }
            $new = $Fields.$name
            if ($name -eq 'title' -and [string]::IsNullOrWhiteSpace([string]$new)) { throw "タイトルは空にできません。" }
            if ($name -eq 'status' -and ([string]$new) -notin @('todo','doing','review','done')) { throw "不正なステータス: $new" }
            if ($name -eq 'assignees') { $new = @($new) }
            if ($name -eq 'subtasks') { $new = ConvertTo-Subtasks $new }
            if ($task.PSObject.Properties.Name -contains $name) { $task.$name = $new }
            else { $task | Add-Member -NotePropertyName $name -NotePropertyValue $new -Force }
            $changed += $name
        }
        if ($changed.Count) {
            Add-ItemHistory -Item $task -Text ("{0}: 更新 ({1})" -f $Actor, ($changed -join ', '))
            Write-JsonFile $path $week
        }
    }
}

# タスクを複製する。元のすぐ後ろに置くので、列の中で隣り合って見える。
# 履歴は引き継がず、複製した記録だけを持たせる。
# 持ち越し印（carriedFrom）も引き継がない。新しく作った作業なので。
function Copy-Task {
    param([string]$Root, [string]$WeekId, [string]$TaskId, [string]$Actor = 'unknown')
    Invoke-WithLock -Root $Root -Name $WeekId -Action {
        $path = Get-WeekPath $Root $WeekId
        $week = Read-JsonFile $path
        if (-not $week) { throw "週が見つかりません: $WeekId" }
        if ($week.closed) { throw "締め済みの週は編集できません: $WeekId" }

        $src = $week.tasks | Where-Object { $_.id -eq $TaskId } | Select-Object -First 1
        if (-not $src) { throw "タスクが見つかりません: $TaskId" }

        $copy = [ordered]@{
            id               = New-Id 't'
            title            = "{0}（コピー）" -f $src.title
            status           = $src.status
            goalId           = $src.goalId
            continuingGoalId = $src.continuingGoalId
            assignees        = @($src.assignees)
            due              = $src.due
            priority         = $src.priority
            projectId        = $src.projectId
            description      = if ($src.PSObject.Properties.Name -contains 'description') { $src.description } else { '' }
            # 子タスクは同じ手順をもう一度やる前提で、すべて未チェックに戻す
            subtasks         = ConvertTo-Subtasks (Get-FieldOrDefault $src 'subtasks' @()) -Reset
            carriedFrom      = $null
            history          = @()
        }
        Add-ItemHistory -Item $copy -Text ("{0}: 「{1}」から複製" -f $Actor, $src.title)

        # 元の直後に差し込む
        $out = New-Object System.Collections.ArrayList
        foreach ($t in @($week.tasks)) {
            [void]$out.Add($t)
            if ($t.id -eq $TaskId) { [void]$out.Add($copy) }
        }
        $week.tasks = @($out.ToArray())
        Write-JsonFile $path $week
        return $copy.id
    }
}

function Remove-Task {
    param([string]$Root, [string]$WeekId, [string]$TaskId, [string]$Actor = 'unknown')
    Invoke-WithLock -Root $Root -LockName $WeekId -Action {
        $path = Get-WeekPath $Root $WeekId
        $week = Read-JsonFile $path
        if (-not $week) { throw "週が見つかりません: $WeekId" }
        if ($week.closed) { throw "締め済みの週は編集できません: $WeekId" }
        $before = @($week.tasks).Count
        $week.tasks = @($week.tasks | Where-Object { $_.id -ne $TaskId })
        if (@($week.tasks).Count -eq $before) { throw "タスクが見つかりません: $TaskId" }
        Write-JsonFile $path $week
    }
}

# ---- 目標の操作 ------------------------------------------------------------
function Add-Goal {
    param([string]$Root, [string]$WeekId, [string]$Title, [string]$Actor = 'unknown', $ScheduleIds = @(), [string]$ScheduleId = '')
    if ([string]::IsNullOrWhiteSpace($Title)) { throw "目標のタイトルを入力してください。" }
    # 旧形式の単数 ScheduleId も配列に混ぜる（重複は除く）
    $sids = ConvertTo-StringArray (@($ScheduleIds) + @($ScheduleId))
    # 週ファイルが無ければ作る（スケジュール画面から未来の週へ目標を作る場合）
    Get-OrCreateWeek $Root $WeekId | Out-Null
    Invoke-WithLock -Root $Root -LockName $WeekId -Action {
        $path = Get-WeekPath $Root $WeekId
        $week = Read-JsonFile $path
        if (-not $week) { throw "週が見つかりません: $WeekId" }
        if ($week.closed) { throw "締め済みの週は編集できません: $WeekId" }
        # 記号は A, B, C... と順に振る
        $used = @($week.goals | ForEach-Object { $_.key })
        $key = 'A'
        foreach ($c in [char[]]([char]'A'..[char]'Z')) { if ($used -notcontains [string]$c) { $key = [string]$c; break } }
        $goal = [ordered]@{
            id = New-Id 'g'; key = $key; title = $Title.Trim(); status = 'running'
            carriedFrom = $null; carryStreak = 0
            scheduleIds = @($sids)
        }
        $week.goals = @($week.goals) + $goal
        Write-JsonFile $path $week
        return $goal.id
    }
}

function Update-Goal {
    param([string]$Root, [string]$WeekId, [string]$GoalId, $Fields, [string]$Actor = 'unknown')
    Invoke-WithLock -Root $Root -LockName $WeekId -Action {
        $path = Get-WeekPath $Root $WeekId
        $week = Read-JsonFile $path
        if (-not $week) { throw "週が見つかりません: $WeekId" }
        if ($week.closed) { throw "締め済みの週は編集できません: $WeekId" }
        $goal = $week.goals | Where-Object { $_.id -eq $GoalId } | Select-Object -First 1
        if (-not $goal) { throw "目標が見つかりません: $GoalId" }

        if (Test-HasField $Fields 'title') {
            if ([string]::IsNullOrWhiteSpace([string]$Fields.title)) { throw "目標のタイトルは空にできません。" }
            $goal.title = ([string]$Fields.title).Trim()
        }
        if (Test-HasField $Fields 'status') {
            $s = [string]$Fields.status
            if ($s -notin @('running','achieved','carried')) { throw "不正な目標ステータス: $s" }
            $goal.status = $s
        }
        if ((Test-HasField $Fields 'scheduleIds') -or (Test-HasField $Fields 'scheduleId')) {
            # 紐づけは丸ごと差し替える。旧 scheduleId だけ渡された場合は1件の配列として扱う
            $raw = if (Test-HasField $Fields 'scheduleIds') { $Fields.scheduleIds } else { $Fields.scheduleId }
            $sids = ConvertTo-StringArray $raw
            if ($goal -is [System.Collections.IDictionary]) {
                $goal['scheduleIds'] = @($sids)
                if ($goal.Contains('scheduleId')) { $goal.Remove('scheduleId') }
            } else {
                $goal | Add-Member -NotePropertyName scheduleIds -NotePropertyValue @($sids) -Force
                # 旧形式の単数フィールドは消す（読み取り側は scheduleIds を優先するが、混乱を避ける）
                [void]$goal.PSObject.Properties.Remove('scheduleId')
            }
        }
        Write-JsonFile $path $week
    }
}

# 目標を削除する。配下のタスクは消さず、紐づけだけ外す（作業自体は残す）。
function Remove-Goal {
    param([string]$Root, [string]$WeekId, [string]$GoalId, [string]$Actor = 'unknown')
    Invoke-WithLock -Root $Root -LockName $WeekId -Action {
        $path = Get-WeekPath $Root $WeekId
        $week = Read-JsonFile $path
        if (-not $week) { throw "週が見つかりません: $WeekId" }
        if ($week.closed) { throw "締め済みの週は編集できません: $WeekId" }
        $before = @($week.goals).Count
        $week.goals = @($week.goals | Where-Object { $_.id -ne $GoalId })
        if (@($week.goals).Count -eq $before) { throw "目標が見つかりません: $GoalId" }

        $unlinked = 0
        foreach ($t in @($week.tasks)) {
            if ($t.goalId -eq $GoalId) {
                $t.goalId = $null
                Add-ItemHistory -Item $t -Text ("{0}: 目標の削除により紐づけを解除" -f $Actor)
                $unlinked++
            }
        }
        Write-JsonFile $path $week
        return $unlinked
    }
}

# ---- 継続目標（board.json 側・週に属さない） -------------------------------
function Add-ContinuingGoal {
    param([string]$Root, [string]$Title, [string]$Actor = 'unknown')
    if ([string]::IsNullOrWhiteSpace($Title)) { throw "継続目標のタイトルを入力してください。" }
    Invoke-WithLock -Root $Root -LockName 'board' -Action {
        $path  = Get-BoardPath $Root
        $board = Read-JsonFile $path
        if (-not $board) { throw "board.json が読めません。" }
        if (-not (Test-HasField $board 'continuingGoals') -or -not $board.continuingGoals) {
            $board | Add-Member -NotePropertyName continuingGoals -NotePropertyValue @() -Force
        }
        # 週目標が A から順に使うので、継続目標は Z から遡って割り当てて衝突を避ける
        $used = @($board.continuingGoals | ForEach-Object { $_.key })
        $key = '*'
        foreach ($c in [char[]]([char]'Z'..[char]'A')) { if ($used -notcontains [string]$c) { $key = [string]$c; break } }
        $goal = [ordered]@{
            id = New-Id 'cg'; key = $key; title = $Title.Trim(); active = $true; totalDone = 0
        }
        $board.continuingGoals = @($board.continuingGoals) + $goal
        Write-JsonFile $path $board
        return $goal.id
    }
}

function Update-ContinuingGoal {
    param([string]$Root, [string]$GoalId, $Fields, [string]$Actor = 'unknown')
    Invoke-WithLock -Root $Root -LockName 'board' -Action {
        $path  = Get-BoardPath $Root
        $board = Read-JsonFile $path
        if (-not $board) { throw "board.json が読めません。" }
        $goal = $board.continuingGoals | Where-Object { $_.id -eq $GoalId } | Select-Object -First 1
        if (-not $goal) { throw "継続目標が見つかりません: $GoalId" }

        if (Test-HasField $Fields 'title') {
            if ([string]::IsNullOrWhiteSpace([string]$Fields.title)) { throw "タイトルは空にできません。" }
            $goal.title = ([string]$Fields.title).Trim()
        }
        if (Test-HasField $Fields 'active') { $goal.active = [bool]$Fields.active }
        Write-JsonFile $path $board
    }
}

# 継続目標の削除。過去週のタスクからも紐づけが外れるため、休止(active=false)を勧める。
function Remove-ContinuingGoal {
    param([string]$Root, [string]$GoalId, [string]$Actor = 'unknown')
    Invoke-WithLock -Root $Root -LockName 'board' -Action {
        $path  = Get-BoardPath $Root
        $board = Read-JsonFile $path
        if (-not $board) { throw "board.json が読めません。" }
        $before = @($board.continuingGoals).Count
        $board.continuingGoals = @($board.continuingGoals | Where-Object { $_.id -ne $GoalId })
        if (@($board.continuingGoals).Count -eq $before) { throw "継続目標が見つかりません: $GoalId" }
        Write-JsonFile $path $board
    }

    # 未締めの週からだけ紐づけを外す。締めた週は記録なので触らない。
    foreach ($w in (Get-WeekList $Root)) {
        if ($w.closed) { continue }
        Invoke-WithLock -Root $Root -LockName $w.id -Action {
            $wp = Get-WeekPath $Root $w.id
            $week = Read-JsonFile $wp
            if (-not $week) { return }
            $touched = $false
            foreach ($t in @($week.tasks)) {
                if ($t.continuingGoalId -eq $GoalId) { $t.continuingGoalId = $null; $touched = $true }
            }
            if ($touched) { Write-JsonFile $wp $week }
        }
    }
}

# ---- メモ・連絡事項（board.json 側・週に属さない） -------------------------
# 週をまたいで覚えておきたいことや、チームへの連絡を置く場所。
# 週の締めでも消えず、常に画面上部に出る。
function Add-Note {
    param([string]$Root, [string]$Text, [string]$Actor = 'unknown')
    if ([string]::IsNullOrWhiteSpace($Text)) { throw "メモの内容を入力してください。" }
    Invoke-WithLock -Root $Root -Name 'board' -Action {
        $path  = Get-BoardPath $Root
        $board = Read-JsonFile $path
        if (-not $board) { throw "board.json が読めません。" }
        if (-not (Test-HasField $board 'notes')) {
            $board | Add-Member -NotePropertyName notes -NotePropertyValue @() -Force
        }
        $note = [ordered]@{
            id        = New-Id 'n'
            text      = $Text.Trim()
            author    = $Actor
            createdAt = (Get-Date).ToString('yyyy-MM-dd')
            pinned    = $false
        }
        # 新しいものを上に積む
        $board.notes = @($note) + @($board.notes)
        Write-JsonFile $path $board
        return $note.id
    }
}

function Update-Note {
    param([string]$Root, [string]$NoteId, $Fields, [string]$Actor = 'unknown')
    Invoke-WithLock -Root $Root -Name 'board' -Action {
        $path  = Get-BoardPath $Root
        $board = Read-JsonFile $path
        if (-not $board) { throw "board.json が読めません。" }
        $note = $board.notes | Where-Object { $_.id -eq $NoteId } | Select-Object -First 1
        if (-not $note) { throw "メモが見つかりません: $NoteId" }

        if (Test-HasField $Fields 'text') {
            if ([string]::IsNullOrWhiteSpace([string]$Fields.text)) { throw "メモは空にできません。" }
            $note.text = ([string]$Fields.text).Trim()
        }
        if (Test-HasField $Fields 'pinned') {
            if (-not ($note.PSObject.Properties.Name -contains 'pinned')) {
                $note | Add-Member -NotePropertyName pinned -NotePropertyValue $false -Force
            }
            $note.pinned = [bool]$Fields.pinned
        }
        Write-JsonFile $path $board
    }
}

function Remove-Note {
    param([string]$Root, [string]$NoteId, [string]$Actor = 'unknown')
    Invoke-WithLock -Root $Root -Name 'board' -Action {
        $path  = Get-BoardPath $Root
        $board = Read-JsonFile $path
        if (-not $board) { throw "board.json が読めません。" }
        $before = @($board.notes).Count
        $board.notes = @($board.notes | Where-Object { $_.id -ne $NoteId })
        if (@($board.notes).Count -eq $before) { throw "メモが見つかりません: $NoteId" }
        Write-JsonFile $path $board
    }
}

# ---- メンバー（board.json 側） ---------------------------------------------
# 退職・異動したメンバーは削除ではなく active=false（休止）を基本にする。
# 削除すると過去の担当記録との対応が取れなくなるため。
$script:MemberPalette = @(
    '#2F6E86', '#8A5A2B', '#5B6E33', '#7A4A6E', '#43607F', '#8C4A45',
    '#3F6B57', '#7B5AA6', '#A05252', '#4A6B8A', '#6B7A3A', '#87543F'
)

# 関数名は Add-BoardMember。PowerShell 組み込みの Add-Member を隠さないため。
function Add-BoardMember {
    param([string]$Root, $Fields, [string]$Actor = 'unknown')
    $name = [string](Get-FieldOrDefault $Fields 'name' '')
    if ([string]::IsNullOrWhiteSpace($name)) { throw "メンバー名を入力してください。" }
    $name = $name.Trim()

    Invoke-WithLock -Root $Root -LockName 'board' -Action {
        $path  = Get-BoardPath $Root
        $board = Read-JsonFile $path
        if (-not $board) { throw "board.json が読めません。" }
        if (-not (Test-HasField $board 'members') -or -not $board.members) {
            $board | Add-Member -NotePropertyName members -NotePropertyValue @() -Force
        }
        if (@($board.members | Where-Object { $_.name -eq $name }).Count) {
            throw "「$name」は既に登録されています。"
        }

        # 表示用の1文字。指定が無ければ名前の先頭文字を使う。
        $initial = [string](Get-FieldOrDefault $Fields 'initial' '')
        if ([string]::IsNullOrWhiteSpace($initial)) { $initial = $name.Substring(0, 1) }
        $initial = $initial.Trim().Substring(0, 1)

        # 色は未使用のものを順に割り当てる
        $color = [string](Get-FieldOrDefault $Fields 'color' '')
        if ([string]::IsNullOrWhiteSpace($color)) {
            $used = @($board.members | ForEach-Object { $_.color })
            $color = $script:MemberPalette | Where-Object { $used -notcontains $_ } | Select-Object -First 1
            if (-not $color) { $color = $script:MemberPalette[@($board.members).Count % $script:MemberPalette.Count] }
        }

        $member = [ordered]@{
            id = New-Id 'm'; name = $name; initial = $initial; color = $color; active = $true
        }
        $board.members = @($board.members) + $member
        Write-JsonFile $path $board
        return $member.id
    }
}

function Update-BoardMember {
    param([string]$Root, [string]$MemberId, $Fields, [string]$Actor = 'unknown')
    Invoke-WithLock -Root $Root -LockName 'board' -Action {
        $path  = Get-BoardPath $Root
        $board = Read-JsonFile $path
        if (-not $board) { throw "board.json が読めません。" }
        $m = $board.members | Where-Object { $_.id -eq $MemberId } | Select-Object -First 1
        if (-not $m) { throw "メンバーが見つかりません: $MemberId" }

        if (Test-HasField $Fields 'name') {
            $n = ([string]$Fields.name).Trim()
            if ([string]::IsNullOrWhiteSpace($n)) { throw "メンバー名は空にできません。" }
            if (@($board.members | Where-Object { $_.name -eq $n -and $_.id -ne $MemberId }).Count) {
                throw "「$n」は既に登録されています。"
            }
            $m.name = $n
        }
        if (Test-HasField $Fields 'initial') {
            $i = ([string]$Fields.initial).Trim()
            if ($i) { $m.initial = $i.Substring(0, 1) }
        }
        if (Test-HasField $Fields 'color') {
            $c = [string]$Fields.color
            if ($c -notmatch '^#[0-9A-Fa-f]{6}$') { throw "色の指定が不正です: $c" }
            $m.color = $c
        }
        if (Test-HasField $Fields 'active') {
            if (-not ($m.PSObject.Properties.Name -contains 'active')) {
                $m | Add-Member -NotePropertyName active -NotePropertyValue $true -Force
            }
            $m.active = [bool]$Fields.active
        }
        Write-JsonFile $path $board
    }
}

# メンバーを削除し、未締めの週のタスクから担当を外す。締めた週の記録は変えない。
function Remove-BoardMember {
    param([string]$Root, [string]$MemberId, [string]$Actor = 'unknown')
    Invoke-WithLock -Root $Root -LockName 'board' -Action {
        $path  = Get-BoardPath $Root
        $board = Read-JsonFile $path
        if (-not $board) { throw "board.json が読めません。" }
        $before = @($board.members).Count
        $board.members = @($board.members | Where-Object { $_.id -ne $MemberId })
        if (@($board.members).Count -eq $before) { throw "メンバーが見つかりません: $MemberId" }
        Write-JsonFile $path $board
    }

    $affected = 0
    foreach ($w in (Get-WeekList $Root)) {
        if ($w.closed) { continue }
        $n = Invoke-WithLock -Root $Root -LockName $w.id -Action {
            $wp = Get-WeekPath $Root $w.id
            $week = Read-JsonFile $wp
            if (-not $week) { return 0 }
            $count = 0
            foreach ($t in @($week.tasks)) {
                if (@($t.assignees) -contains $MemberId) {
                    $t.assignees = @($t.assignees | Where-Object { $_ -ne $MemberId })
                    Add-ItemHistory -Item $t -Text ("{0}: メンバー削除により担当を解除" -f $Actor)
                    $count++
                }
            }
            if ($count) { Write-JsonFile $wp $week }
            return $count
        }
        $affected += $n
    }
    return $affected
}

# ---- 案件（board.json 側） -------------------------------------------------
function Add-Project {
    param([string]$Root, [string]$Name, [string]$Actor = 'unknown')
    if ([string]::IsNullOrWhiteSpace($Name)) { throw "案件名を入力してください。" }
    $Name = $Name.Trim()
    Invoke-WithLock -Root $Root -LockName 'board' -Action {
        $path  = Get-BoardPath $Root
        $board = Read-JsonFile $path
        if (-not $board) { throw "board.json が読めません。" }
        if (-not (Test-HasField $board 'projects') -or -not $board.projects) {
            $board | Add-Member -NotePropertyName projects -NotePropertyValue @() -Force
        }
        if (@($board.projects | Where-Object { $_.name -eq $Name }).Count) {
            throw "「$Name」は既に登録されています。"
        }
        $proj = [ordered]@{ id = New-Id 'p'; name = $Name; active = $true }
        $board.projects = @($board.projects) + $proj
        Write-JsonFile $path $board
        return $proj.id
    }
}

function Update-Project {
    param([string]$Root, [string]$ProjectId, $Fields, [string]$Actor = 'unknown')
    Invoke-WithLock -Root $Root -LockName 'board' -Action {
        $path  = Get-BoardPath $Root
        $board = Read-JsonFile $path
        if (-not $board) { throw "board.json が読めません。" }
        $p = $board.projects | Where-Object { $_.id -eq $ProjectId } | Select-Object -First 1
        if (-not $p) { throw "案件が見つかりません: $ProjectId" }

        if (Test-HasField $Fields 'name') {
            $n = ([string]$Fields.name).Trim()
            if ([string]::IsNullOrWhiteSpace($n)) { throw "案件名は空にできません。" }
            if (@($board.projects | Where-Object { $_.name -eq $n -and $_.id -ne $ProjectId }).Count) {
                throw "「$n」は既に登録されています。"
            }
            $p.name = $n
        }
        if (Test-HasField $Fields 'active') {
            if (-not ($p.PSObject.Properties.Name -contains 'active')) {
                $p | Add-Member -NotePropertyName active -NotePropertyValue $true -Force
            }
            $p.active = [bool]$Fields.active
        }
        Write-JsonFile $path $board
    }
}

function Remove-Project {
    param([string]$Root, [string]$ProjectId, [string]$Actor = 'unknown')
    Invoke-WithLock -Root $Root -LockName 'board' -Action {
        $path  = Get-BoardPath $Root
        $board = Read-JsonFile $path
        if (-not $board) { throw "board.json が読めません。" }
        $before = @($board.projects).Count
        $board.projects = @($board.projects | Where-Object { $_.id -ne $ProjectId })
        if (@($board.projects).Count -eq $before) { throw "案件が見つかりません: $ProjectId" }
        Write-JsonFile $path $board
    }

    $affected = 0
    foreach ($w in (Get-WeekList $Root)) {
        if ($w.closed) { continue }
        $n = Invoke-WithLock -Root $Root -LockName $w.id -Action {
            $wp = Get-WeekPath $Root $w.id
            $week = Read-JsonFile $wp
            if (-not $week) { return 0 }
            $count = 0
            foreach ($t in @($week.tasks)) {
                if ($t.projectId -eq $ProjectId) { $t.projectId = $null; $count++ }
            }
            if ($count) { Write-JsonFile $wp $week }
            return $count
        }
        $affected += $n
    }
    return $affected
}

# ある対象が使われているタスク件数を数える（削除前の確認表示用）
function Get-UsageCount {
    param([string]$Root, [ValidateSet('member','project','continuingGoal')][string]$Kind, [string]$Id)
    $total = 0; $openWeeks = 0
    foreach ($w in (Get-WeekList $Root)) {
        $week = Get-Week $Root $w.id
        if (-not $week) { continue }
        $n = 0
        foreach ($t in @($week.tasks)) {
            switch ($Kind) {
                'member'         { if (@($t.assignees) -contains $Id) { $n++ } }
                'project'        { if ($t.projectId -eq $Id) { $n++ } }
                'continuingGoal' { if ($t.continuingGoalId -eq $Id) { $n++ } }
            }
        }
        $total += $n
        if ($n -and -not $week.closed) { $openWeeks += $n }
    }
    return [ordered]@{ total = $total; unclosed = $openWeeks }
}

# ---- 並び替え --------------------------------------------------------------
# 同じ列（ステータス）の中で、$TaskId を $BeforeTaskId の直前へ移す。
# $BeforeTaskId が空なら列の末尾へ。tasks 配列の順序がそのまま表示順になる。
function Set-TaskOrder {
    param([string]$Root, [string]$WeekId, [string]$TaskId, [string]$BeforeTaskId, [string]$Actor = 'unknown')
    Invoke-WithLock -Root $Root -LockName $WeekId -Action {
        $path = Get-WeekPath $Root $WeekId
        $week = Read-JsonFile $path
        if (-not $week) { throw "週が見つかりません: $WeekId" }
        if ($week.closed) { throw "締め済みの週は編集できません: $WeekId" }

        $all = @($week.tasks)
        $moving = $all | Where-Object { $_.id -eq $TaskId } | Select-Object -First 1
        if (-not $moving) { throw "タスクが見つかりません: $TaskId" }

        $rest = @($all | Where-Object { $_.id -ne $TaskId })
        $out  = New-Object System.Collections.ArrayList
        $placed = $false
        foreach ($t in $rest) {
            if ($BeforeTaskId -and $t.id -eq $BeforeTaskId) {
                [void]$out.Add($moving); $placed = $true
            }
            [void]$out.Add($t)
        }
        if (-not $placed) { [void]$out.Add($moving) }

        $week.tasks = @($out.ToArray())
        Write-JsonFile $path $week
    }
}

# ---- スケジュール（schedule.json・週に属さない） ---------------------------
# 案件 → 工程(phase) → 作業(task)/マイルストーン(milestone) の3段。
# 週ファイルとは独立して編集でき、週の締めとは無関係。
function Get-SchedulePath { param($Root) [System.IO.Path]::Combine($Root, 'schedule.json') }

# 戻り値は @{ schemaVersion; items = 配列 }。ファイルが無ければ items は空。
function Get-Schedule {
    param([string]$Root)
    $s = Read-JsonFile (Get-SchedulePath $Root)
    if (-not $s) { $s = [pscustomobject]@{ schemaVersion = 1; items = @() } }
    if (-not (Test-HasField $s 'items') -or $null -eq $s.items) {
        $s | Add-Member -NotePropertyName items -NotePropertyValue @() -Force
    }
    $s.items = @($s.items)
    return $s
}

# 他PCの更新検知用
function Get-ScheduleStamp {
    param([string]$Root)
    $path = Get-SchedulePath $Root
    if (-not (Test-Path -LiteralPath $path)) { return '' }
    return (Get-Item -LiteralPath $path).LastWriteTimeUtc.ToString('o')
}

function ConvertTo-ScheduleDate {
    param($Value, [string]$Label)
    $s = [string]$Value
    $d = [datetime]::MinValue
    if ($s -notmatch '^\d{4}-\d{2}-\d{2}$' -or
        -not [datetime]::TryParseExact($s, 'yyyy-MM-dd', [System.Globalization.CultureInfo]::InvariantCulture,
                                       [System.Globalization.DateTimeStyles]::None, [ref]$d)) {
        throw "${Label}は yyyy-MM-dd 形式の日付で指定してください: $s"
    }
    return $s
}

function ConvertTo-StringArray {
    param($Value)
    $out = New-Object System.Collections.ArrayList
    foreach ($v in @($Value)) {
        if ($null -eq $v) { continue }
        $t = [string]$v
        if ([string]::IsNullOrWhiteSpace($t)) { continue }
        if ($out -notcontains $t) { [void]$out.Add($t) }
    }
    return ,@($out.ToArray())
}

# 項目を検証して保存用の値に確定する（$Vals は kind/projectId/parentId/title/start/end/assignees を持つ辞書）。
# $Items は全項目、$SelfId は更新時の自分のID。子があるかは $Items から判定する。
function Test-ScheduleValues {
    param($Vals, $Items, [string]$SelfId)
    if ($Vals.kind -notin @('phase','task','milestone','goal')) { throw "不正な種類です: $($Vals.kind)" }
    # 長期目標と予定は性質が違う（案件・親を持たず状態を持つ）ので、相互の変更は認めない
    if ($SelfId) {
        $self = $Items | Where-Object { $_.id -eq $SelfId } | Select-Object -First 1
        if ($self -and (($self.kind -eq 'goal') -ne ($Vals.kind -eq 'goal'))) {
            throw "長期目標と予定の間では種類を変更できません。"
        }
    }
    if ([string]::IsNullOrWhiteSpace([string]$Vals.title)) { throw "タイトルを入力してください。" }
    $Vals.title = ([string]$Vals.title).Trim()
    $Vals.start = ConvertTo-ScheduleDate $Vals.start '開始日'
    if ($Vals.kind -eq 'milestone') { $Vals.end = $Vals.start }
    $Vals.end = ConvertTo-ScheduleDate $Vals.end '終了日'
    if ([datetime]::ParseExact($Vals.start, 'yyyy-MM-dd', $null) -gt [datetime]::ParseExact($Vals.end, 'yyyy-MM-dd', $null)) {
        throw "開始日が終了日より後になっています。"
    }
    $Vals.assignees = ConvertTo-StringArray $Vals.assignees
    if ([string]::IsNullOrWhiteSpace([string]$Vals.projectId)) { $Vals.projectId = $null } else { $Vals.projectId = [string]$Vals.projectId }
    if ([string]::IsNullOrWhiteSpace([string]$Vals.parentId))  { $Vals.parentId  = $null } else { $Vals.parentId  = [string]$Vals.parentId }

    if ($Vals.kind -eq 'goal') {
        # 長期目標は案件にも工程にも属さない。状態は人が付ける
        $Vals.projectId = $null
        $Vals.parentId = $null
        if (-not $Vals.ContainsKey('status') -or [string]::IsNullOrWhiteSpace([string]$Vals.status)) { $Vals.status = 'running' }
        $Vals.status = [string]$Vals.status
        if ($Vals.status -notin @('running','achieved','missed','dropped')) { throw "不正な状態です: $($Vals.status)" }
    } elseif ($Vals.kind -eq 'phase') {
        if ($Vals.parentId) { throw "工程の下に工程は置けません。" }
    } elseif ($Vals.parentId) {
        if ($Vals.parentId -eq $SelfId) { throw "自分自身を親にはできません。" }
        $parent = $Items | Where-Object { $_.id -eq $Vals.parentId } | Select-Object -First 1
        if (-not $parent) { throw "親の工程が見つかりません: $($Vals.parentId)" }
        if ($parent.kind -ne 'phase') { throw "親にできるのは工程だけです。" }
        $Vals.projectId = $parent.projectId   # 子の案件は親にそろえる
    }
    if ($SelfId -and $Vals.kind -ne 'phase') {
        if (@($Items | Where-Object { $_.parentId -eq $SelfId }).Count) {
            throw "子の項目がある工程は、作業やマイルストーンに変更できません。"
        }
    }
}

function Add-ScheduleItem {
    param([string]$Root, $Fields, [string]$Actor = 'unknown')
    Invoke-WithLock -Root $Root -LockName 'schedule' -Action {
        $sched = Get-Schedule $Root
        $vals = @{
            kind      = [string](Get-FieldOrDefault $Fields 'kind' 'task')
            projectId = Get-FieldOrDefault $Fields 'projectId' $null
            parentId  = Get-FieldOrDefault $Fields 'parentId' $null
            title     = Get-FieldOrDefault $Fields 'title' ''
            start     = Get-FieldOrDefault $Fields 'start' ''
            end       = Get-FieldOrDefault $Fields 'end' ''
            assignees = Get-FieldOrDefault $Fields 'assignees' @()
            status    = Get-FieldOrDefault $Fields 'status' 'running'
        }
        if ($vals.kind -eq 'milestone' -and -not $vals.end) { $vals.end = $vals.start }
        Test-ScheduleValues -Vals $vals -Items $sched.items -SelfId ''
        $item = [ordered]@{
            id = New-Id 'sc'; kind = $vals.kind; projectId = $vals.projectId; parentId = $vals.parentId
            title = $vals.title; start = $vals.start; end = $vals.end
            assignees = $vals.assignees; history = @()
        }
        if ($vals.kind -eq 'goal') { $item['status'] = $vals.status }
        Add-ItemHistory -Item $item -Text ("{0}: 作成" -f $Actor)
        $sched.items = @($sched.items) + $item
        Write-JsonFile (Get-SchedulePath $Root) ([ordered]@{ schemaVersion = 1; items = @($sched.items) })
        return $item.id
    }
}

function Update-ScheduleItem {
    param([string]$Root, [string]$ItemId, $Fields, [string]$Actor = 'unknown')
    Invoke-WithLock -Root $Root -LockName 'schedule' -Action {
        $sched = Get-Schedule $Root
        $item = $sched.items | Where-Object { $_.id -eq $ItemId } | Select-Object -First 1
        if (-not $item) { throw "スケジュール項目が見つかりません: $ItemId" }
        $oldProject = $item.projectId
        $vals = @{}
        foreach ($k in @('kind','projectId','parentId','title','start','end','assignees','status')) {
            $vals[$k] = if (Test-HasField $Fields $k) { $Fields.$k } else { Get-FieldOrDefault $item $k $null }
        }
        $vals.kind = [string]$vals.kind
        # マイルストーンは終了日を開始日にそろえる（開始日だけ変えた場合も追従）
        if ($vals.kind -eq 'milestone') { $vals.end = $vals.start }
        Test-ScheduleValues -Vals $vals -Items $sched.items -SelfId $ItemId

        $changed = @()
        foreach ($k in @('kind','projectId','parentId','title','start','end')) {
            if ([string](Get-FieldOrDefault $item $k '') -ne [string]$vals[$k]) { $changed += $k }
        }
        $oldAs = (@(Get-FieldOrDefault $item 'assignees' @()) -join ',')
        if ($oldAs -ne (@($vals.assignees) -join ',')) { $changed += 'assignees' }

        if ($item.kind -eq 'goal' -or $vals.kind -eq 'goal') {
            $oldSt = [string](Get-FieldOrDefault $item 'status' 'running')
            if ($oldSt -ne [string]$vals.status) {
                Add-ItemHistory -Item $item -Text ("{0}: 状態を変更（{1} → {2}）" -f $Actor, $oldSt, $vals.status)
            }
            if (Test-HasField $item 'status') { $item.status = $vals.status }
            else { $item | Add-Member -NotePropertyName status -NotePropertyValue $vals.status -Force }
        }
        foreach ($k in @('kind','projectId','parentId','title','start','end')) { $item.$k = $vals[$k] }
        $item.assignees = @($vals.assignees)

        # 工程の案件を変えたら子もそろえる
        if ($item.kind -eq 'phase' -and [string]$oldProject -ne [string]$item.projectId) {
            foreach ($c in @($sched.items | Where-Object { $_.parentId -eq $ItemId })) { $c.projectId = $item.projectId }
        }
        if ($changed.Count) {
            Add-ItemHistory -Item $item -Text ("{0}: 更新（{1}）" -f $Actor, ($changed -join ', '))
        }
        Write-JsonFile (Get-SchedulePath $Root) ([ordered]@{ schemaVersion = 1; items = @($sched.items) })
    }
}

# 期間だけを複数項目まとめて動かす（ドラッグ移動用）。$Moves は @{ itemId; start; end } の並び。
# 1件でも検証に落ちたら何も保存しない（途中まで動いた状態を残さないため、先に全件検証してから反映する）。
function Move-ScheduleItems {
    param([string]$Root, $Moves, [string]$Actor = 'unknown')
    Invoke-WithLock -Root $Root -LockName 'schedule' -Action {
        $sched = Get-Schedule $Root
        $plan = @()
        $seen = @{}
        foreach ($m in @($Moves)) {
            $id = [string](Get-FieldOrDefault $m 'itemId' '')
            $item = $sched.items | Where-Object { $_.id -eq $id } | Select-Object -First 1
            if (-not $item) { throw "スケジュール項目が見つかりません: $id" }
            if ($seen.ContainsKey($id)) { throw "同じ項目が複数指定されています: $id" }
            $seen[$id] = $true
            $vals = @{}
            foreach ($k in @('kind','projectId','parentId','title','start','end','assignees')) {
                $vals[$k] = Get-FieldOrDefault $item $k $null
            }
            $vals.kind = [string]$vals.kind
            $vals.start = Get-FieldOrDefault $m 'start' ''
            $vals.end = Get-FieldOrDefault $m 'end' ''
            if ($vals.kind -eq 'milestone') { $vals.end = $vals.start }
            Test-ScheduleValues -Vals $vals -Items $sched.items -SelfId $id
            $plan += ,@($item, $vals)
        }
        if (-not $plan.Count) { return 0 }
        foreach ($p in $plan) {
            $item = $p[0]; $vals = $p[1]
            if ([string]$item.start -ne $vals.start -or [string]$item.end -ne $vals.end) {
                $item.start = $vals.start; $item.end = $vals.end
                Add-ItemHistory -Item $item -Text ("{0}: 移動（{1} 〜 {2}）" -f $Actor, $vals.start, $vals.end)
            }
        }
        Write-JsonFile (Get-SchedulePath $Root) ([ordered]@{ schemaVersion = 1; items = @($sched.items) })
        return $plan.Count
    }
}

# 削除する。工程なら子も消す。戻り値は消した件数（本人を含む）。
function Remove-ScheduleItem {
    param([string]$Root, [string]$ItemId, [string]$Actor = 'unknown')
    Invoke-WithLock -Root $Root -LockName 'schedule' -Action {
        $sched = Get-Schedule $Root
        $item = $sched.items | Where-Object { $_.id -eq $ItemId } | Select-Object -First 1
        if (-not $item) { throw "スケジュール項目が見つかりません: $ItemId" }
        $before = @($sched.items).Count
        $keep = @($sched.items | Where-Object { $_.id -ne $ItemId -and $_.parentId -ne $ItemId })
        Write-JsonFile (Get-SchedulePath $Root) ([ordered]@{ schemaVersion = 1; items = @($keep) })
        return ($before - $keep.Count)
    }
}

# 週の目標が紐づけているスケジュール項目IDの配列。
# scheduleIds が無く旧形式の scheduleId だけある目標は、その1件とみなす。
function Get-GoalScheduleIds {
    param($Goal)
    # ConvertTo-StringArray は既に配列を包んで返すので、ここで @() を重ねると入れ子になる
    if (Test-HasField $Goal 'scheduleIds') { $ids = ConvertTo-StringArray $Goal.scheduleIds }
    else { $ids = ConvertTo-StringArray (Get-FieldOrDefault $Goal 'scheduleId' $null) }
    return ,$ids
}

# 全週を走査し、スケジュール項目（長期目標を含む）に結びついた目標を返す。
function Get-ScheduleLinks {
    param([string]$Root)
    $out = @()
    foreach ($w in (Get-WeekList $Root)) {
        $week = Get-Week $Root $w.id
        if (-not $week) { continue }
        foreach ($g in @($week.goals)) {
            # 紐づけ先ごとに1件。UI は scheduleId 単位で集計する
            $sids = Get-GoalScheduleIds $g
            foreach ($sid in $sids) {
                $out += [ordered]@{
                    weekId = $w.id; goalId = $g.id; key = $g.key; title = $g.title
                    status = $g.status; scheduleId = [string]$sid
                }
            }
        }
    }
    return ,@($out)
}

# ---- 小物 ------------------------------------------------------------------
function Test-HasField {
    param($Obj, [string]$Name)
    if ($null -eq $Obj) { return $false }
    return ($Obj.PSObject.Properties.Name -contains $Name)
}

function Get-FieldOrDefault {
    param($Obj, [string]$Name, $Default)
    if ((Test-HasField $Obj $Name) -and ($null -ne $Obj.$Name)) { return $Obj.$Name }
    return $Default
}

# 子タスク（チェックリスト）を保存用の形 [{ id, title, done }] にそろえる。
# 空のタイトルは捨てる。-OpenOnly は未チェックだけ残す（週の持ち越し用）。
# -Reset は全部未チェックにして新しいIDを振る（複製用）。
function ConvertTo-Subtasks {
    param($Items, [switch]$OpenOnly, [switch]$Reset)
    $out = New-Object System.Collections.ArrayList
    foreach ($s in @($Items)) {
        if ($null -eq $s) { continue }
        $title = [string](Get-FieldOrDefault $s 'title' '')
        if ([string]::IsNullOrWhiteSpace($title)) { continue }
        $done = [bool](Get-FieldOrDefault $s 'done' $false)
        if ($OpenOnly -and $done) { continue }
        $id = [string](Get-FieldOrDefault $s 'id' '')
        if ($Reset -or $OpenOnly -or -not $id) { $id = New-Id 's' }
        [void]$out.Add([ordered]@{ id = $id; title = $title.Trim(); done = ($done -and -not $Reset) })
    }
    # 1件のときも配列のまま保存されるよう、カンマで包んで返す
    return ,@($out.ToArray())
}

function Add-ItemHistory {
    param($Item, [string]$Text)
    $line = "{0} {1}" -f (Get-Date).ToString('yyyy-MM-dd HH:mm'), $Text

    # 新規作成時の [ordered]@{} は辞書。Add-Member を使うとキーを覆い隠す
    # NoteProperty ができてしまい、JSON にはキー側（空のまま）が出力される。
    # 辞書はキーとして直接扱う。
    if ($Item -is [System.Collections.IDictionary]) {
        $cur = @()
        if ($Item.Contains('history')) { $cur = @($Item['history']) }
        # 必ず配列で入れる。@() を付けないと1件目のとき文字列になる（下の注記参照）
        $Item['history'] = @($cur + $line)
        return
    }
    # JSON から読んだ PSCustomObject 側
    if (-not ($Item.PSObject.Properties.Name -contains 'history')) {
        $Item | Add-Member -NotePropertyName history -NotePropertyValue @() -Force
    }
    $Item.history = @(@($Item.history) + $line)
}

# 注記:
#   ここは以前 `$cur = if (...) { @(...) } else { @() }` と書いていて不具合になった。
#   PowerShell は if ブロックが空配列を返すと、それを $null に潰してしまう。
#   その結果 $cur が $null になり、`$null + "文字列"` が配列の連結ではなく
#   文字列連結として評価され、history が配列でなく文字列として保存されていた。
#   すると UI 側の history.join() が例外になり、そのカードを開けなくなる。
#   同じ理由で、配列を作る箇所では最後に @() で包んでおくこと。

# 既に文字列として保存されてしまった history を配列に直す。
# 不具合修正前に作られたタスクを開けるようにするための後始末。
function Repair-TaskHistory {
    param([string]$Root)
    $fixed = 0
    foreach ($w in (Get-WeekList $Root)) {
        $path = Get-WeekPath $Root $w.id
        $week = Read-JsonFile $path
        if (-not $week) { continue }
        $touched = $false
        foreach ($t in @($week.tasks)) {
            if (-not ($t.PSObject.Properties.Name -contains 'history')) { continue }
            if ($null -eq $t.history) { continue }
            if ($t.history -is [string]) {
                $t.history = @($t.history)
                $touched = $true
                $fixed++
            }
        }
        if ($touched) {
            Invoke-WithLock -Root $Root -Name $w.id -Action { Write-JsonFile $path $week }
        }
    }
    return $fixed
}

# ---- 週の締め --------------------------------------------------------------
# judgements: @{ goalId = 'achieved'|'carried' } のハッシュ
# carryTaskIds: 次週へ運ぶ未完了タスクIDの配列（既定は持ち越し目標配下の未完了＋任意の紐づけなし）
function Close-Week {
    param(
        [string]$Root, [string]$WeekId,
        [hashtable]$Judgements,
        [string[]]$CarryTaskIds = @(),
        [string]$Actor = 'unknown'
    )
    Invoke-WithLock -Root $Root -LockName $WeekId -Action {
        $path = Get-WeekPath $Root $WeekId
        $week = Read-JsonFile $path
        if (-not $week) { throw "週が見つかりません: $WeekId" }
        if ($week.closed) { throw "$WeekId は既に締め済みです。" }

        $nextId    = Get-NextWeekId $WeekId
        $nextRange = Get-WeekRange $nextId
        $nextPath  = Get-WeekPath $Root $nextId

        # 目標ごとに達成/持ち越しを確定
        $carriedGoals = @()
        foreach ($g in $week.goals) {
            $verdict = if ($Judgements.ContainsKey($g.id)) { $Judgements[$g.id] } else { 'carried' }
            $g.status = $verdict
            if ($verdict -eq 'carried') { $carriedGoals += $g }
        }
        $week.closed = $true
        Add-ItemHistory -Item $week -Text ("{0}: {1} を締め" -f $Actor, $WeekId)
        # 書き込みは次週の作成が終わってから（作った物を記録に残すため）

        # 次週を用意（既存なら読み込み、無ければ生成）
        $next = if (Test-Path -LiteralPath $nextPath) { Read-JsonFile $nextPath } else {
            [ordered]@{ schemaVersion = 1; id = $nextId; range = $nextRange; closed = $false; goals = @(); tasks = @() }
        }
        $nextGoals = New-Object System.Collections.ArrayList
        foreach ($g in @($next.goals)) { [void]$nextGoals.Add($g) }
        $nextTasks = New-Object System.Collections.ArrayList
        foreach ($t in @($next.tasks)) { [void]$nextTasks.Add($t) }

        # 締めを解除できるよう、次週に作ったものを控えておく
        $madeGoalIds = New-Object System.Collections.ArrayList
        $madeTaskIds = New-Object System.Collections.ArrayList

        # 持ち越し目標を次週へ複製（新IDを振り、carryStreak を積む）
        $goalIdMap = @{}
        foreach ($g in $carriedGoals) {
            $newGoalId = New-Id 'g'
            [void]$madeGoalIds.Add($newGoalId)
            $goalIdMap[$g.id] = $newGoalId
            $streak = 1
            if ($g.PSObject.Properties.Name -contains 'carryStreak' -and $g.carryStreak) { $streak = [int]$g.carryStreak + 1 }
            # 紐づけ（長期目標・予定とも）は全部引き継ぐ。旧形式の scheduleId は配列に直す
            $carrySids = Get-GoalScheduleIds $g
            [void]$nextGoals.Add([ordered]@{
                id = $newGoalId; key = $g.key; title = $g.title; status = 'running'
                carriedFrom = $WeekId; carryStreak = $streak
                scheduleIds = $carrySids
            })
        }

        # 運ぶタスク: 指定IDのうち未完了のものを次週へコピー
        $carrySet = @{}; foreach ($id in $CarryTaskIds) { $carrySet[$id] = $true }
        foreach ($t in $week.tasks) {
            if ($t.status -eq 'done') { continue }
            if (-not $carrySet.ContainsKey($t.id)) { continue }
            $newGoalId = if ($t.goalId -and $goalIdMap.ContainsKey($t.goalId)) { $goalIdMap[$t.goalId] } else { $null }
            $newTaskId = New-Id 't'
            [void]$madeTaskIds.Add($newTaskId)
            [void]$nextTasks.Add([ordered]@{
                id = $newTaskId; title = $t.title; status = 'todo'
                goalId = $newGoalId
                continuingGoalId = $t.continuingGoalId
                assignees = @($t.assignees); due = $nextRange.end
                priority = $t.priority; projectId = $t.projectId
                # 子タスクは週の中の手順。済んだものはこの週の実績として残し、未チェックだけ運ぶ
                subtasks = ConvertTo-Subtasks (Get-FieldOrDefault $t 'subtasks' @()) -OpenOnly
                carriedFrom = $WeekId; history = @()
            })
        }

        $next.goals = @($nextGoals.ToArray())
        $next.tasks = @($nextTasks.ToArray())
        Invoke-WithLock -Root $Root -LockName $nextId -Action { Write-JsonFile $nextPath $next }

        # 何を作ったかを週ファイルに残す。締めの解除はこれを見て元に戻す。
        $record = [ordered]@{
            nextWeekId     = $nextId
            createdGoalIds = @($madeGoalIds.ToArray())
            createdTaskIds = @($madeTaskIds.ToArray())
            closedAt       = (Get-Date).ToString('yyyy-MM-dd HH:mm')
            closedBy       = $Actor
        }
        if ($week.PSObject.Properties.Name -contains 'closeRecord') { $week.closeRecord = $record }
        else { $week | Add-Member -NotePropertyName closeRecord -NotePropertyValue $record -Force }
        Write-JsonFile $path $week

        return $nextId
    }
}

# ---- 締めの解除 ------------------------------------------------------------
# 締めたときに次週へ作ったもののうち、まだ誰も手を付けていないものだけを撤去し、
# その週を編集できる状態に戻す。着手済みのものは消さずに残す。
#
# 「手つかず」の判定: 履歴が空で、かつ未着手のままであること。
# 移動も編集も履歴を残すので、これで実作業の有無を判別できる。
# （並び替えだけは履歴を残さないが、作業ではないので手つかず扱いでよい）
function Test-TaskUntouched {
    param($Task)
    if ($Task.status -ne 'todo') { return $false }
    $h = @()
    if ($Task.PSObject.Properties.Name -contains 'history') { $h = @($Task.history) }
    return ($h.Count -eq 0)
}

# 解除したら何が起きるかを先に調べる（確認画面に出すため。データは変更しない）
function Test-WeekReopen {
    param([string]$Root, [string]$WeekId)
    $result = [ordered]@{
        canReopen = $false; reason = ''
        nextWeekId = ''; removeTasks = @(); keepTasks = @(); removeGoals = 0
        closedAt = ''; closedBy = ''
    }
    $week = Get-Week $Root $WeekId
    if (-not $week) { $result.reason = "週が見つかりません: $WeekId"; return $result }
    if (-not $week.closed) { $result.reason = "$WeekId はまだ締められていません。"; return $result }

    # 記録が無い（この機能より前に締められた週）
    if (-not ($week.PSObject.Properties.Name -contains 'closeRecord') -or -not $week.closeRecord) {
        $result.canReopen = $true
        $result.reason = 'この週には締めの記録がありません。解除はできますが、次週に作られた目標やタスクは自動では戻せないため、手作業で整理してください。'
        return $result
    }

    $rec = $week.closeRecord
    $result.nextWeekId = [string]$rec.nextWeekId
    $result.closedAt   = [string]$rec.closedAt
    $result.closedBy   = [string]$rec.closedBy

    $next = Get-Week $Root $rec.nextWeekId
    if ($next -and $next.closed) {
        $result.reason = "$($rec.nextWeekId) が既に締められています。先にそちらの締めを解除してください。"
        return $result
    }

    if ($next) {
        $madeTasks = @($rec.createdTaskIds)
        foreach ($id in $madeTasks) {
            $t = $next.tasks | Where-Object { $_.id -eq $id } | Select-Object -First 1
            if (-not $t) { continue }   # 既に消されている
            if (Test-TaskUntouched $t) { $result.removeTasks = @($result.removeTasks) + $t.title }
            else { $result.keepTasks = @($result.keepTasks) + $t.title }
        }
        $result.removeGoals = @($rec.createdGoalIds).Count
    }
    $result.canReopen = $true
    return $result
}

# 関数名は Resume-Week。Reopen は PowerShell の承認済み動詞ではないため。
function Resume-Week {
    param([string]$Root, [string]$WeekId, [string]$Actor = 'unknown')

    $check = Test-WeekReopen -Root $Root -WeekId $WeekId
    if (-not $check.canReopen) { throw $check.reason }

    $removed = 0; $kept = 0
    $week = Get-Week $Root $WeekId
    $rec  = if ($week.PSObject.Properties.Name -contains 'closeRecord') { $week.closeRecord } else { $null }

    # 先に次週から、手つかずの持ち越し分を撤去する
    if ($rec -and $rec.nextWeekId) {
        $nextId = [string]$rec.nextWeekId
        $r = Invoke-WithLock -Root $Root -LockName $nextId -Action {
            $np = Get-WeekPath $Root $nextId
            $next = Read-JsonFile $np
            if (-not $next) { return @(0, 0) }

            $keepIds = @{}   # 残すことにしたタスクの目標は消さない
            $delIds  = @{}
            foreach ($id in @($rec.createdTaskIds)) {
                $t = $next.tasks | Where-Object { $_.id -eq $id } | Select-Object -First 1
                if (-not $t) { continue }
                if (Test-TaskUntouched $t) { $delIds[$id] = $true }
                else { $keepIds[$id] = $true }
            }
            $next.tasks = @($next.tasks | Where-Object { -not $delIds.ContainsKey($_.id) })

            # 目標は、残ったタスクから参照されていなければ撤去する
            $stillUsed = @{}
            foreach ($t in @($next.tasks)) { if ($t.goalId) { $stillUsed[$t.goalId] = $true } }
            $next.goals = @($next.goals | Where-Object {
                -not ((@($rec.createdGoalIds) -contains $_.id) -and (-not $stillUsed.ContainsKey($_.id)))
            })

            Write-JsonFile $np $next
            return @($delIds.Count, $keepIds.Count)
        }
        $removed = $r[0]; $kept = $r[1]
    }

    # 週を編集できる状態に戻す
    Invoke-WithLock -Root $Root -LockName $WeekId -Action {
        $path = Get-WeekPath $Root $WeekId
        $w = Read-JsonFile $path
        if (-not $w) { throw "週が見つかりません: $WeekId" }
        $w.closed = $false
        foreach ($g in @($w.goals)) { $g.status = 'running' }
        if ($w.PSObject.Properties.Name -contains 'closeRecord') { $w.closeRecord = $null }
        Add-ItemHistory -Item $w -Text ("{0}: {1} の締めを解除" -f $Actor, $WeekId)
        Write-JsonFile $path $w
    }

    return [ordered]@{ removed = $removed; kept = $kept; nextWeekId = $(if ($rec) { [string]$rec.nextWeekId } else { '' }) }
}

function Get-NextWeekId {
    param([string]$WeekId)
    $r = Get-WeekRange $WeekId
    $mon = [datetime]::ParseExact($r.start, 'yyyy-MM-dd', $null).AddDays(7)
    return Get-IsoWeekId $mon
}

function New-Id {
    param([string]$Prefix = 'x')
    return "{0}-{1}" -f $Prefix, ([guid]::NewGuid().ToString('N').Substring(0, 10))
}

# ---- カード単位の編集ロック（advisory） ------------------------------------
# 誰かがカードを開いている間だけ立てる目印。Invoke-WithLock の排他ロックとは別物で、
# 「他PCに編集中と見せる」ためのもの。閲覧は誰でもできる。
# アプリが異常終了しても残り続けないよう、有効期限つきにする。
$script:LockTtlMinutes = 10

function Get-EditLockPath {
    param([string]$Root, [string]$WeekId, [string]$TaskId)
    return [System.IO.Path]::Combine((Get-LocksDir $Root), ("edit_{0}_{1}.json" -f $WeekId, ($TaskId -replace '[^\w\-]', '_')))
}

function Set-EditLock {
    param([string]$Root, [string]$WeekId, [string]$TaskId, [string]$Actor)
    $path = Get-EditLockPath $Root $WeekId $TaskId
    $info = [ordered]@{ taskId = $TaskId; actor = $Actor; at = (Get-Date).ToString('s') }
    try { Write-JsonFile $path $info } catch { }
}

function Remove-EditLock {
    param([string]$Root, [string]$WeekId, [string]$TaskId)
    $path = Get-EditLockPath $Root $WeekId $TaskId
    try { if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force } } catch { }
}

# その週で今たっている編集ロックを taskId -> actor の形で返す
function Get-EditLocks {
    param([string]$Root, [string]$WeekId, [string]$ExcludeActor)
    $result = @{}
    $dir = Get-LocksDir $Root
    if (-not (Test-Path -LiteralPath $dir)) { return $result }
    $cutoff = (Get-Date).AddMinutes(-$script:LockTtlMinutes)
    Get-ChildItem -LiteralPath $dir -Filter ("edit_{0}_*.json" -f $WeekId) -File -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            $info = Read-JsonFile $_.FullName
            if (-not $info) { return }
            $at = [datetime]::Parse($info.at)
            if ($at -lt $cutoff) { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue; return }
            if ($ExcludeActor -and $info.actor -eq $ExcludeActor) { return }
            $result[[string]$info.taskId] = [string]$info.actor
        } catch { }
    }
    return $result
}

# ---- NAS 到達性の確認 ------------------------------------------------------
# 読めるか / 書けるかを分けて返す。書けない場合はUIを読み取り専用にする。
function Test-DataRootAccess {
    param([string]$Root)
    $res = [ordered]@{ readable = $false; writable = $false; message = '' }
    try {
        if (-not (Test-Path -LiteralPath (Get-BoardPath $Root))) {
            $res.message = 'データが見つかりません'
            return $res
        }
        $res.readable = $true
        # 書き込みテスト。.locks が未作成なら作る（これ自体が書き込みの確認になる）
        $locks = Get-LocksDir $Root
        if (-not (Test-Path -LiteralPath $locks)) { New-Item -ItemType Directory -Path $locks -Force | Out-Null }
        $probe = [System.IO.Path]::Combine($locks, ('.probe_' + [guid]::NewGuid().ToString('N').Substring(0,6)))
        [System.IO.File]::WriteAllText($probe, 'x')
        Remove-Item -LiteralPath $probe -Force
        $res.writable = $true
    } catch {
        if (-not $res.readable) { $res.message = '共有フォルダに接続できません' }
        else { $res.message = '読み取り専用（書き込めません）' }
    }
    return $res
}

# 週ファイルの最終更新時刻。他PCの更新検知に使う。
function Get-WeekStamp {
    param([string]$Root, [string]$WeekId)
    $path = Get-WeekPath $Root $WeekId
    if (-not (Test-Path -LiteralPath $path)) { return '' }
    return (Get-Item -LiteralPath $path).LastWriteTimeUtc.ToString('o')
}

# ---- 振り返り用のサマリ ----------------------------------------------------
# 週ごとに「何を狙って、どうだったか」だけを集めて返す（カード一覧は含めない）。
function Get-RetroSummary {
    param([string]$Root, [int]$Limit = 12)
    $out = @()
    foreach ($w in (Get-WeekList $Root | Select-Object -First $Limit)) {
        $week = Get-Week $Root $w.id
        if (-not $week) { continue }
        $tasks = @($week.tasks)
        $goals = @()
        foreach ($g in @($week.goals)) {
            $linked = @($tasks | Where-Object { $_.goalId -eq $g.id })
            $goals += [ordered]@{
                key         = $g.key
                title       = $g.title
                status      = $g.status
                carryStreak = if ($g.PSObject.Properties.Name -contains 'carryStreak') { [int]$g.carryStreak } else { 0 }
                done        = @($linked | Where-Object { $_.status -eq 'done' }).Count
                total       = $linked.Count
            }
        }
        $out += [ordered]@{
            id        = $week.id
            range     = $week.range
            closed    = [bool]$week.closed
            goals     = $goals
            taskDone  = @($tasks | Where-Object { $_.status -eq 'done' }).Count
            taskTotal = $tasks.Count
            achieved  = @($goals | Where-Object { $_.status -eq 'achieved' }).Count
            carried   = @($goals | Where-Object { $_.status -eq 'carried' }).Count
        }
    }
    # Get-WeekList と同じ理由で配列のまま返す（0件や1件でも UI が配列として扱えるように）
    return ,@($out)
}

# ---- バックアップ ----------------------------------------------------------
function Backup-DataDaily {
    param([string]$Root)
    $today = (Get-Date).ToString('yyyy-MM-dd')
    $dest  = Join-Path (Join-Path $Root 'backup') $today
    if (Test-Path -LiteralPath $dest) { return }   # 今日は取得済み
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    Copy-Item -LiteralPath (Get-BoardPath $Root) -Destination $dest -ErrorAction SilentlyContinue
    Copy-Item -LiteralPath (Get-SchedulePath $Root) -Destination $dest -ErrorAction SilentlyContinue
    $wd = Get-WeeksDir $Root
    if (Test-Path -LiteralPath $wd) {
        Copy-Item -Path (Join-Path $wd '*.json') -Destination $dest -ErrorAction SilentlyContinue
    }
}
