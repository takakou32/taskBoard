# lib フォルダ — WebView2 の DLL

このアプリは UI 表示に **WebView2** を使います。
必要な DLL（約1.2MB）は**このフォルダに同梱済み**です。
clone やコピーをしたらそのまま起動できます。ビルドもインターネット接続も不要です。

## 中身

```
lib\
  Microsoft.Web.WebView2.Core.dll        … マネージドAPI
  Microsoft.Web.WebView2.WinForms.dll    … WinForms用コントロール
  runtimes\win-x64\native\WebView2Loader.dll
  runtimes\win-x86\native\WebView2Loader.dll
  runtimes\win-arm64\native\WebView2Loader.dll
```

出所は NuGet の公式パッケージ
[Microsoft.Web.WebView2](https://www.nuget.org/packages/Microsoft.Web.WebView2)（v1.0.4078.44、Microsoft署名済み）。
ライセンスは `WebView2-LICENSE.txt` を参照してください。

`WebView2Loader.dll` はネイティブDLLでCPUアーキテクチャごとに別物です。
.NET Framework は NuGet の `runtimes\<rid>\native\` を自動解決しないため、
`src\host\TaskBoard.ps1` の `Import-WebView2` が実行中プロセスのアーキテクチャを見て
明示的に読み込みます。3種類とも置いてあるので環境を選びません。

## 更新するとき

```powershell
.\setup-webview2.ps1 -Force
```

最新の安定版を取得して置き換えます。差分をコミットしてください。
バージョンを固定したい場合は `-Version 1.0.4078.44` のように指定できます。

> マネージドDLLの入っているフォルダ名はバージョンによって変わります
> （v1.0.4078.44 では `net462`。以前は `net45` でした）。
> `setup-webview2.ps1` は決め打ちせず自動で探します。

## WebView2 ランタイム（Evergreen）について

DLL とは別に、実行PCに **WebView2 ランタイム** が必要です。
これは同梱できないので、無い場合は導入が要ります。

- Windows 11 は標準搭載。
- Windows 10 も Microsoft Edge の更新で入っていることがほとんどです。
- 入っているかの確認:

  ```powershell
  Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' |
    Select-Object -ExpandProperty pv
  ```

- 無い場合は Microsoft の「Evergreen ブートストラップ」を一度実行すれば入ります。
