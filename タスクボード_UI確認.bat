@echo off
rem ============================================================
rem  タスクボード UI確認（プレビュー）
rem   既定のブラウザで画面だけを開きます。
rem   WebView2 の DLL は不要ですが、操作しても保存はされません。
rem   レイアウトや操作感を見てもらうとき用。
rem ============================================================
setlocal
pushd "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" -Preview
set "RC=%ERRORLEVEL%"

popd

if not "%RC%"=="0" (
  echo.
  echo プレビューの起動に失敗しました。
  echo.
  pause
)

endlocal & exit /b %RC%
