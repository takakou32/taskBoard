/*
 * check-ui.js — 画面側スクリプトの簡易チェック
 *
 *   node tools\check-ui.js
 *
 * node --check は「構文が正しいか」しか見ないため、存在しない関数を呼んでいても
 * 素通りする。実際に `new Set(...)` が `new SetasArray(...)` に化けた不具合を
 * 見逃したことがあるので、呼び出し名がどこにも定義されていない場合に落とす。
 *
 * あわせて、app.js が参照する DOM の id が index.html に存在するかも確認する。
 */
"use strict";
const fs = require("fs");
const path = require("path");

const uiDir = path.join(__dirname, "..", "src", "ui");
const js = fs.readFileSync(path.join(uiDir, "app.js"), "utf8");
const html = fs.readFileSync(path.join(uiDir, "index.html"), "utf8");

let ng = 0;
const fail = (msg) => { console.log("  NG " + msg); ng++; };

// ---- 1) 呼び出しているのに定義が見当たらない名前 --------------------------
const declared = new Set();
for (const re of [
  /\bfunction\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[,;]/g,
]) {
  let m;
  while ((m = re.exec(js)) !== null) declared.add(m[1]);
}
// 関数の引数名も定義済みとして扱う（雑だが誤検出を減らすため）
let pm;
const paramRe = /(?:function\s*[\w$]*\s*|\)\s*=>|\()\s*\(([^)]*)\)/g;
while ((pm = paramRe.exec(js)) !== null) {
  for (const p of pm[1].split(",")) {
    const name = p.trim().replace(/^\.\.\./, "").split("=")[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
  }
}
// アロー関数の単一引数 `x =>`
let am;
const arrowRe = /\b([A-Za-z_$][\w$]*)\s*=>/g;
while ((am = arrowRe.exec(js)) !== null) declared.add(am[1]);

const GLOBALS = new Set([
  "Array","Object","String","Number","Boolean","Date","JSON","Math","RegExp","Error","TypeError",
  "Promise","Set","Map","WeakMap","WeakSet","Symbol","Intl","BigInt","Proxy","Reflect",
  "console","document","window","navigator","location","localStorage","sessionStorage",
  "alert","confirm","prompt","fetch","setTimeout","clearTimeout","setInterval","clearInterval",
  "requestAnimationFrame","cancelAnimationFrame","queueMicrotask","structuredClone",
  "parseInt","parseFloat","isNaN","isFinite","encodeURIComponent","decodeURIComponent",
  "encodeURI","decodeURI","CustomEvent","Event","URL","URLSearchParams","DOMParser",
  // 制御構文（呼び出しに見えるだけ）
  "if","for","while","switch","catch","return","typeof","function","new","do","else","await","of","in",
  // 文字列に埋め込んだCSS（var(--accent) など）
  "var","calc","rgba","rgb","translate","rotate","url",
]);

const callRe = /(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
const unknown = new Map();
let cm;
while ((cm = callRe.exec(js)) !== null) {
  const name = cm[2];
  if (GLOBALS.has(name) || declared.has(name)) continue;
  const line = js.slice(0, cm.index).split("\n").length;
  if (!unknown.has(name)) unknown.set(name, line);
}

console.log("=== 未定義の呼び出し ===");
if (unknown.size === 0) console.log("  OK なし");
else for (const [name, line] of unknown) fail(`app.js:${line} 定義が見当たりません: ${name}(`);

// ---- 2) getElementById が指す id が HTML にあるか --------------------------
const htmlIds = new Set();
let hm;
const idRe = /id="([^"]+)"/g;
while ((hm = idRe.exec(html)) !== null) htmlIds.add(hm[1]);

console.log("=== 参照している id ===");
const idCallRe = /getElementById\("([^"]+)"\)/g;
const missing = new Set();
let im;
while ((im = idCallRe.exec(js)) !== null) if (!htmlIds.has(im[1])) missing.add(im[1]);
if (missing.size === 0) console.log(`  OK ${htmlIds.size} 個の id を確認`);
else for (const id of missing) fail(`index.html に id="${id}" がありません`);

console.log(ng === 0 ? "\n問題なし" : `\n${ng} 件の問題`);
process.exit(ng === 0 ? 0 : 1);
