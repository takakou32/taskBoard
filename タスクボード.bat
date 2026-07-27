@echo off
rem ============================================================
rem  タスクボード 起動用
rem   このファイルをダブルクリックすると起動します。
rem   デスクトップにショートカットを作って使うのが便利です。
rem
rem   引数はそのまま start.ps1 に渡されます。
rem     例) タスクボード.bat -DataRoot \\NAS\share\taskboard\data
rem ============================================================
setlocal

rem NAS上(\\サーバ名\共有名\...)から実行された場合、cd はUNCパスを扱えない。
rem pushd は一時的にドライブ文字を割り当てるのでUNCでも動く。
pushd "%~dp0"

rem -STA        : WebView2 / WinForms が要求するスレッドモデル
rem -NoProfile  : 各PCのプロファイル設定に影響されないようにする
rem -ExecutionPolicy Bypass : スクリプト実行が既定で禁止されていても起動できるように
powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
set "RC=%ERRORLEVEL%"

popd

if not "%RC%"=="0" (
  echo.
  echo ------------------------------------------------------------
  echo  起動に失敗しました。上に出ているメッセージを確認してください。
  echo.
  echo  よくある原因:
  echo    1^) lib フォルダに WebView2 の DLL が置かれていない
  echo       -^> lib\README.md の手順で配置してください
  echo    2^) config.local.json の dataRoot が間違っている / NASに接続できない
  echo    3^) WebView2 ランタイムが入っていない
  echo.
  echo  UIだけ確認したいときは「タスクボード_UI確認.bat」を実行してください。
  echo ------------------------------------------------------------
  echo.
  pause
)

endlocal & exit /b %RC%
