# lib フォルダ — WebView2 の DLL を置く場所

このアプリは UI 表示に **WebView2** を使います。ビルドは不要ですが、
WebView2 の SDK DLL をこのフォルダに置く必要があります。

## いちばん簡単な方法

リポジトリ直下の **setup-webview2.ps1** を実行してください。
NuGet の公式パッケージから必要なDLLだけを自動で配置します。

```powershell
.\setup-webview2.ps1
```

ネットにつながらないPCへ配る場合は、つながるPCで一度実行し、
**この lib フォルダごとコピー**してください。それだけで動きます。

## 配置後の構成

```
lib\
  Microsoft.Web.WebView2.Core.dll        … マネージドAPI
  Microsoft.Web.WebView2.WinForms.dll    … WinForms用コントロール
  runtimes\win-x64\native\WebView2Loader.dll
  runtimes\win-x86\native\WebView2Loader.dll
  runtimes\win-arm64\native\WebView2Loader.dll
```

`WebView2Loader.dll` はネイティブDLLでCPUアーキテクチャごとに別物です。
.NET Framework は NuGet の `runtimes\<rid>\native\` を自動解決しないため、
アプリ側（`src\host\TaskBoard.ps1` の `Import-WebView2`）が実行中プロセスの
アーキテクチャを見て明示的に読み込みます。3種類とも置いておけば環境を選びません。

## 手動で配置する場合

1. https://www.nuget.org/packages/Microsoft.Web.WebView2 から `.nupkg` をダウンロード
2. 拡張子を `.zip` に変えて展開
3. `lib\net462\`（バージョンによっては `net45\` など）から
   `Microsoft.Web.WebView2.Core.dll` と `Microsoft.Web.WebView2.WinForms.dll` をこのフォルダへ
4. `runtimes\win-*\native\WebView2Loader.dll` を上記の構成どおりにコピー

> マネージドDLLの入っているフォルダ名はバージョンによって変わります
> （例: 1.0.4078.44 では `net462`）。`setup-webview2.ps1` は自動で探します。

## WebView2 ランタイム（Evergreen）について

DLL とは別に、実行PCに **WebView2 ランタイム** が必要です。

- Windows 11 は標準搭載。
- Windows 10 も Microsoft Edge の更新で入っていることがほとんどです。
- 入っているかの確認:

  ```powershell
  Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' |
    Select-Object -ExpandProperty pv
  ```

- 無い場合は Microsoft の「Evergreen ブートストラップ」を一度実行すれば入ります。

---

**DLL が無くても UI だけは確認できます**:
`タスクボード_UI確認.bat` をダブルクリック（データ保存はされません）。

なお、このフォルダの `*.dll` と `runtimes\` は `.gitignore` で除外しています
（バイナリはリポジトリに入れず、各環境で取得する方針）。
