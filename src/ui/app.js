"use strict";
/*
 * タスクボード UI ロジック
 * - PowerShell + WebView2 ホストと postMessage で通信する（ブリッジモード）
 * - ホストが無い場合（index.html を直接開いた場合）は組み込みのデモデータで描画する（スタンドアロンモード）
 * すべてのデータ読み書きはホスト側が担当し、UI はファイルに直接触れない。
 */

const STATUSES = [
  { key: "todo",   label: "未着手",     cls: "c-todo" },
  { key: "doing",  label: "着手中",     cls: "c-doing" },
  { key: "review", label: "レビュー中", cls: "c-review" },
  { key: "done",   label: "完了",       cls: "c-done" },
];

const bridge = window.chrome && window.chrome.webview ? window.chrome.webview : null;

/* 画面側で例外が起きても WebView2 の中では何も見えず、
   「ボタンを押しても無反応」としか分からない。
   握りつぶさずホストへ送り、利用者にも知らせる。 */
function reportError(where, err) {
  const msg = (err && (err.stack || err.message)) ? String(err.stack || err.message) : String(err);
  try { if (bridge) bridge.postMessage({ type: "clientError", where: where, message: msg }); } catch (e) { /* 送信自体が失敗しても落とさない */ }
  try { toast("エラーが発生しました（" + where + "）"); } catch (e) { /* toast前の失敗は無視 */ }
}

window.addEventListener("error", (e) => reportError("script", e.error || e.message));
window.addEventListener("unhandledrejection", (e) => reportError("promise", e.reason));

// 画面が丸ごと固まらないよう、操作ごとに包んで報告する
function guard(where, fn) {
  return function (...args) {
    try { return fn.apply(this, args); }
    catch (err) { reportError(where, err); }
  };
}

let state = null;         // { board, week, weeks, view, connected }
let filterGoalId = null;  // 目標レーンでの絞り込み（"__unlinked__" で紐づけなしのみ）
let searchText = "";

/* ---------------- ホスト通信 ---------------- */
function send(msg) {
  if (bridge) bridge.postMessage(msg);
}

if (bridge) {
  bridge.addEventListener("message", (e) => handleHostMessage(e.data));
}

function handleHostMessage(msg) {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case "state": {
      // ビューと絞り込みは状態更新をまたいで保つ（保存のたびに看板へ戻らないように）
      const view = state ? state.view : "board";
      const retro = state ? state.retro : null;
      const sameWeek = state && state.week && state.week.id === msg.week.id;
      state = msg;
      state.view = view;
      state.retro = sameWeek ? retro : null;   // 週が変わったら振り返りは取り直す
      if (!sameWeek) { filterGoalId = null; memoCollapsed = null; }   // 週が変わったらメモの開閉も決め直す
      render();
      if (state.view === "schedule") schedRequestLinks();
      break;
    }
    case "scheduleLinks":
      schedLinks = asArray(msg.links);
      if (state && state.view === "schedule") render();
      break;
    case "retro":
      if (state) { state.retro = msg.weeks || []; render(); }
      break;
    case "reopenCheck":
      showReopenDialog(msg);
      break;
    case "toast":
      toast(msg.text);
      break;
    case "sync":
      setSync(msg.connected, msg.text);
      if (state) {
        const before = JSON.stringify(state.locks || {});
        if (msg.locks !== undefined) state.locks = msg.locks;
        if (msg.readOnly !== undefined) state.readOnly = msg.readOnly;
        if (!msg.connected) state.readOnly = true;
        // ロックの増減があったときだけ描き直す（毎回描くとドラッグが中断される）
        if (JSON.stringify(state.locks || {}) !== before) render();
      }
      break;
    case "error":
      toast("⚠ " + msg.message);
      break;
  }
}

/* ---------------- 起動 ---------------- */
window.addEventListener("DOMContentLoaded", () => {
  wireToolbar();
  if (bridge) {
    setSync(true, "接続中…");
    send({ type: "ready" });
  } else {
    // スタンドアロン: デモデータで描画（UI確認用）
    state = buildStandaloneState();
    setSync(true, "スタンドアロン（プレビュー）");
    render();
  }
});

/* ---------------- ツールバー ---------------- */
function wireToolbar() {
  document.getElementById("btnPrev").onclick = () => changeWeekBy(-1);
  document.getElementById("btnNext").onclick = () => changeWeekBy(1);
  document.getElementById("btnThisWeek").onclick = () => {
    if (bridge) send({ type: "gotoCurrentWeek" });
    else toast("スタンドアロンでは今週固定です");
  };
  document.getElementById("btnNewTask").onclick = guard("新規タスク", () => openDrawer(null));
  document.getElementById("drawerClose").onclick = closeDrawer;
  document.getElementById("btnCancel").onclick = closeDrawer;
  // 背景の暗幕は3つのドロワーで共用。開いているものを閉じる。
  document.getElementById("scrim").onclick = () => {
    if (!document.getElementById("drawer").hidden) closeDrawer();
    else if (!document.getElementById("goalDrawer").hidden) closeGoalDrawer();
    else if (!document.getElementById("schedDrawer").hidden) closeSchedDrawer();
    else if (!document.getElementById("contDrawer").hidden) closeContDrawer();
    else if (!document.getElementById("setDrawer").hidden) closeSettings();
  };
  document.getElementById("btnSave").onclick = saveDrawer;
  document.getElementById("btnDelete").onclick = guard("削除", deleteDrawer);
  document.getElementById("btnDuplicate").onclick = guard("複製", duplicateDrawer);
  document.getElementById("fSubAdd").onclick = addSub;
  document.getElementById("fSubNew").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); addSub(); }
  });
  document.getElementById("filterClear").onclick = clearFilter;
  document.getElementById("memoToggle").onclick = toggleMemo;
  document.getElementById("viewRoot").addEventListener("scroll", autoCollapseMemo, { passive: true });
  document.getElementById("memoAdd").onclick = addNote;
  document.getElementById("memoNew").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addNote(); }
  });

  wireScheduleDrawer();
  document.getElementById("goalClose").onclick = closeGoalDrawer;
  document.getElementById("gCancel").onclick = closeGoalDrawer;
  document.getElementById("gSave").onclick = saveGoalDrawer;
  document.getElementById("gDelete").onclick = deleteGoalDrawer;

  document.getElementById("btnSettings").onclick = openSettings;
  document.getElementById("setClose").onclick = closeSettings;
  document.getElementById("setDone").onclick = closeSettings;
  document.getElementById("memberAdd").onclick = addMember;
  document.getElementById("projectAdd").onclick = addProject;
  document.getElementById("memberNew").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addMember(); }
  });
  document.getElementById("projectNew").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addProject(); }
  });

  document.getElementById("contClose").onclick = closeContDrawer;
  document.getElementById("contDone").onclick = closeContDrawer;
  document.getElementById("contAdd").onclick = addContGoal;
  document.getElementById("contNew").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addContGoal(); }
  });

  document.getElementById("btnCloseWeek").onclick = guard("週を締める", openCloseDialog);
  document.getElementById("reopenCancel").onclick = closeReopenDialog;
  document.getElementById("reopenScrim").onclick = closeReopenDialog;
  document.getElementById("reopenConfirm").onclick = guard("締めの解除", confirmReopen);
  document.getElementById("closeCancel").onclick = closeCloseDialog;
  document.getElementById("closeScrim").onclick = closeCloseDialog;
  document.getElementById("closeConfirm").onclick = confirmClose;
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!document.getElementById("drawer").hidden) closeDrawer();
    else if (!document.getElementById("goalDrawer").hidden) closeGoalDrawer();
    else if (!document.getElementById("schedDrawer").hidden) closeSchedDrawer();
    else if (!document.getElementById("contDrawer").hidden) closeContDrawer();
    else if (!document.getElementById("setDrawer").hidden) closeSettings();
    else if (!document.getElementById("closeModal").hidden) closeCloseDialog();
    else if (!document.getElementById("reopenModal").hidden) closeReopenDialog();
  });
  document.getElementById("search").addEventListener("input", (e) => {
    searchText = e.target.value.trim();
    render();
  });
  document.querySelectorAll(".toolbar .btn[data-view]").forEach((b) => {
    b.onclick = () => setView(b.dataset.view);
  });
}

function setView(view) {
  document.querySelectorAll(".toolbar .btn[data-view]").forEach((b) => {
    b.classList.toggle("on", b.dataset.view === view);
  });
  state.view = view;
  render();
  if (view === "schedule") schedRequestLinks();
}

function changeWeekBy(delta) {
  // ホストは新しい週が先頭の降順で weeks を返すため、古い順に並べ直してから移動する。
  // （delta = -1 が「前の週」、+1 が「次の週」）
  const list = (state.weeks || []).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const idx = list.findIndex((w) => w.id === state.week.id);
  if (idx < 0) { toast("週の一覧に現在の週が見つかりません"); return; }
  const next = list[idx + delta];
  if (!next) { toast(delta < 0 ? "これ以上前の週はありません" : "これ以上先の週はありません"); return; }
  if (bridge) send({ type: "changeWeek", weekId: next.id });
  else { toast("スタンドアロンでは週切替は無効です"); }
}

/* ---------------- 描画 ---------------- */
const render = guard("画面描画", function () {
  renderInner();
});

function renderInner() {
  if (!state) return;
  renderToolbarState();
  renderMemo();
  renderFilterBar();
  const root = document.getElementById("viewRoot");
  if (state.view === "assignee") root.replaceChildren(renderAssigneeView());
  else if (state.view === "retro") root.replaceChildren(renderRetroView());
  else if (state.view === "schedule") root.replaceChildren(renderScheduleView());
  else root.replaceChildren(renderBoard());

  // ドロワーを開いたまま更新が届いたら、一覧も追随させる
  if (!document.getElementById("contDrawer").hidden) renderContList();
  if (!document.getElementById("setDrawer").hidden) renderSettings();
}

function renderToolbarState() {
  const b = state.board, w = state.week;
  document.getElementById("boardName").textContent = b.boardName ? " — " + b.boardName : "";
  document.getElementById("weekLabel").innerHTML =
    esc(w.id) + " <small>" + fmtRange(w.range) + "</small>";
  document.getElementById("daysLeft").textContent = w.closed ? "締め済" : daysLeftText(w.range.end);

  const av = document.getElementById("avatars");
  av.replaceChildren(...activeMembers().map((m) => avatar(m)));

  // 書き込めないときは編集系の操作を止める
  const ro = !!state.readOnly;
  document.getElementById("btnNewTask").disabled = ro;
  document.getElementById("btnCloseWeek").disabled = ro || w.closed;

  const banner = document.getElementById("banner");
  if (ro) {
    banner.classList.add("show", "warn");
    document.getElementById("bannerText").textContent =
      "共有フォルダに書き込めないため、閲覧のみになっています。ネットワーク接続を確認してください。";
    const act = document.getElementById("bannerAction");
    act.textContent = "再確認";
    act.onclick = () => send({ type: "changeWeek", weekId: state.week.id });
    return;
  }
  banner.classList.remove("warn");

  // 締め済みの週は編集できないので、その旨と解除の導線を出す
  if (w.closed) {
    banner.classList.add("show");
    document.getElementById("bannerText").textContent =
      w.id + " は締め済みです。記録として固定されているため編集できません。";
    const act = document.getElementById("bannerAction");
    act.textContent = "締めを解除";
    act.onclick = guard("締めの解除", askReopen);
    return;
  }

  // 締め忘れバナー
  if (state.needsClose) {
    banner.classList.add("show");
    document.getElementById("bannerText").textContent = w.id + " が未締めです。達成／持ち越しを判定してください。";
    const act = document.getElementById("bannerAction");
    act.textContent = "週を締める";
    act.onclick = guard("週を締める", openCloseDialog);
  } else {
    banner.classList.remove("show");
  }
}

function renderBoard() {
  const board = el("div", "board");
  board.appendChild(renderGoalLane());
  const tasks = visibleTasks();
  for (const st of STATUSES) {
    const col = el("div", "col " + st.cls);
    const head = el("div", "col-head");
    const colTasks = tasks.filter((t) => t.status === st.key);
    head.innerHTML = '<span class="t">' + st.label + '</span><span class="n">' + colTasks.length + "</span>";
    col.appendChild(head);

    const zone = el("div", "dropzone");
    zone.dataset.status = st.key;
    wireDropzone(zone);
    for (const t of colTasks) zone.appendChild(renderCard(t));
    // 絞り込みで0件になった列は、空なのか隠れているのかを区別できるようにする
    if (!colTasks.length && (filterGoalId || searchText)) {
      const em = el("div", "col-empty");
      em.textContent = "絞り込みに該当なし";
      zone.appendChild(em);
    }
    if (st.key === "todo" && !state.week.closed) {
      const add = el("button", "ghost-add");
      add.textContent = "＋ カードを追加";
      add.onclick = () => openDrawer(null);
      zone.appendChild(add);
    }
    col.appendChild(zone);
    board.appendChild(col);
  }
  return board;
}

// ---- 目標レーン: 予定（スケジュール）との結びつけ ----
// 予定の参照（schedItems / schedById）と目標化（schedMakeGoal）はスケジュール画面の区画と共用する
let laneSchedExpanded = false;  // 「ほか N 件」を開いているか
// 予定 → 「案件名 › 工程名 › 作業名」（無い段は省く）
function lanePathParts(it) {
  const parts = [];
  const proj = it.projectId && asArray(state.board.projects).find((p) => p.id === it.projectId);
  if (proj) parts.push(proj.name);
  const par = it.parentId ? schedById(it.parentId) : null;
  if (par && par.kind === "phase") parts.push(par.title);
  parts.push(it.title);
  return parts;
}
function laneSchedCandidates() {
  const r = state.week && state.week.range;
  if (!r) return [];
  const items = schedItems();
  const used = new Set(asArray(state.week.goals).map((g) => g.scheduleId).filter(Boolean));
  const hasChild = new Set(items.map((x) => x.parentId).filter(Boolean));
  return items.filter((it) => {
    if (used.has(it.id)) return false;
    if (it.kind === "phase" && hasChild.has(it.id)) return false;
    return it.start <= r.end && it.end >= r.start;
  });
}
function laneSchedRow(it) {
  const row = el("div", "sched-row");
  const txt = el("div", "st");
  const ms = it.kind === "milestone";
  txt.textContent = (ms ? "◆ " : "") + lanePathParts(it).join(" › ") + (ms ? "（" + it.start.slice(5).replace("-", "/") + "）" : "");
  txt.title = txt.textContent;
  row.appendChild(txt);
  const btn = el("button", "btn sm");
  btn.textContent = "目標にする";
  btn.onclick = () => schedMakeGoal(it, state.week.id);
  row.appendChild(btn);
  return row;
}
function renderLaneSchedule() {
  if (state.week.closed || state.readOnly) return null;
  const cands = laneSchedCandidates();
  if (!cands.length) return null;
  const box = el("div", "lane-sched");
  const sep = el("div", "lane-sep");
  sep.textContent = "今週の予定";
  box.appendChild(sep);
  const LIMIT = 5;
  const shown = laneSchedExpanded ? cands : cands.slice(0, LIMIT);
  for (const it of shown) box.appendChild(laneSchedRow(it));
  if (cands.length > LIMIT) {
    const more = el("button", "sched-more");
    more.textContent = laneSchedExpanded ? "たたむ" : "ほか " + (cands.length - LIMIT) + " 件";
    more.onclick = () => { laneSchedExpanded = !laneSchedExpanded; render(); };
    box.appendChild(more);
  }
  return box;
}

function renderGoalLane() {
  const lane = el("aside", "goal-lane");
  const title = el("div", "lane-title");
  title.innerHTML = '<span class="t">今週の目標</span><span class="s">' + esc(shortWeek(state.week.id)) + "</span>";
  lane.appendChild(title);

  const weekGoals = asArray(state.week.goals);
  const tasks = asArray(state.week.tasks);
  for (const g of weekGoals) {
    const linked = tasks.filter((t) => t.goalId === g.id);
    const done = linked.filter((t) => t.status === "done").length;
    const pct = linked.length ? Math.round((done / linked.length) * 100) : 0;
    const node = el("div", "goal" + (filterGoalId === g.id ? " sel" : ""));
    let html = '<div class="top"><span class="gkey">' + esc(g.key) + '</span>'
      + '<span class="gt">' + esc(g.title) + "</span>"
      + '<span class="gstat ' + g.status + '">' + statusJa(g.status) + "</span></div>";
    if (g.carriedFrom) html += '<div class="carry-from">↻ ' + esc(g.carriedFrom) + " から持ち越し"
      + (g.carryStreak >= 2 ? "（" + g.carryStreak + "週連続）" : "") + "</div>";
    html += '<div class="bar"><i style="width:' + pct + '%"></i></div>'
      + '<div class="gmeta"><span>' + done + "/" + linked.length + ' 完了</span><span class="sp"></span></div>';
    const sc = g.scheduleId ? schedById(g.scheduleId) : null;
    if (sc) html += '<div class="sched-link">📅 ' + esc(lanePathParts(sc).slice(-2).join(" › ")) + "</div>";
    node.innerHTML = html;
    node.onclick = () => toggleFilter(g.id);
    if (!state.week.closed && !state.readOnly) {
      const edit = el("button", "btn icon gedit");
      edit.textContent = "✎";
      edit.title = "この目標を編集";
      edit.onclick = (ev) => { ev.stopPropagation(); openGoalDrawer(g); };
      node.querySelector(".gmeta").appendChild(edit);
    }
    lane.appendChild(node);
  }

  if (!state.week.closed) {
    const addGoal = el("button", "ghost-add");
    addGoal.textContent = "＋ 目標を追加";
    addGoal.onclick = () => {
      const title = prompt("今週の目標を入力してください");
      if (!title || !title.trim()) return;
      if (bridge) send({ type: "createGoal", weekId: state.week.id, title: title.trim() });
      else toast("プレビューでは追加されません");
    };
    lane.appendChild(addGoal);
  }

  const schedBox = renderLaneSchedule();
  if (schedBox) lane.appendChild(schedBox);

  const contGoals = asArray(state.board.continuingGoals).filter(isActive);
  if (contGoals.length || !state.readOnly) {
    const sep = el("div", "lane-sep");
    sep.textContent = "継続目標";
    if (!state.readOnly) {
      const manage = el("button", "btn icon gedit");
      manage.textContent = "⚙";
      manage.title = "継続目標を管理";
      manage.onclick = openContDrawer;
      sep.appendChild(manage);
    }
    lane.appendChild(sep);
    for (const c of contGoals) {
      const wk = tasks.filter((t) => t.continuingGoalId === c.id).length;
      const node = el("div", "goal bg" + (filterGoalId === c.id ? " sel" : ""));
      node.innerHTML = '<div class="top"><span class="gkey">' + esc(c.key) + '</span>'
        + '<span class="gt">' + esc(c.title) + "</span></div>"
        + '<div class="gmeta"><span>今週 ' + wk + " 件 ・ 通算 " + (c.totalDone || 0) + " 件</span></div>";
      node.onclick = () => toggleFilter(c.id);
      lane.appendChild(node);
    }
  }

  const unlinkedCount = tasks.filter((t) => !t.goalId && !t.continuingGoalId).length;
  const u = el("div", "unlinked" + (filterGoalId === "__unlinked__" ? " sel" : ""));
  u.innerHTML = "目標に紐づかないタスク <b style='font-family:var(--font-mono)'>" + unlinkedCount + "</b> 件";
  u.onclick = () => toggleFilter("__unlinked__");
  lane.appendChild(u);
  return lane;
}

function renderCard(t) {
  const lockedBy = (state.locks || {})[t.id];
  const card = el("div", "card" + (t.status === "done" ? " done" : "") + (t.carriedFrom ? " carried" : "")
    + (lockedBy ? " locked" : ""));
  card.dataset.taskId = t.id;
  if (!state.week.closed && !state.readOnly && !lockedBy) {
    card.draggable = true;
    wireDrag(card, t);
  }

  // タグ類とタイトルを1段に統合（縦の枚数を稼ぐ）。タグが無ければタイトルだけ
  const row = el("div", "row");
  const goalTag = goalTagFor(t);
  if (goalTag) row.appendChild(goalTag);
  if (t.carriedFrom) row.appendChild(chip("↻ " + shortWeek(t.carriedFrom)));
  if (t.priority === "high") row.appendChild(chip("高", "pri-h"));
  const title = el("div", "title");
  title.textContent = t.title;
  row.appendChild(title);
  card.appendChild(row);

  if (lockedBy) {
    const lb = el("div", "lockbar");
    lb.textContent = "🔒 " + lockedBy + " が編集中";
    card.appendChild(lb);
  }

  const meta = el("div", "meta");
  const due = el("span", "due" + (isOverdue(t) ? " over" : ""));
  due.textContent = fmtDue(t);
  meta.appendChild(due);
  // 子タスクは中身を広げず、進み具合だけ見せる（カードの高さを増やさない）
  const subs = asArray(t.subtasks);
  if (subs.length) {
    const doneN = subs.filter((s) => s.done).length;
    const sc = el("span", "subc" + (doneN === subs.length ? " all" : ""));
    sc.textContent = "☑ " + doneN + "/" + subs.length;
    sc.title = "子タスク " + subs.length + " 件中 " + doneN + " 件済み";
    meta.appendChild(sc);
  }
  meta.appendChild(el("span", "sp"));
  for (const id of asArray(t.assignees)) {
    const m = memberById(id);
    if (m) meta.appendChild(avatar(m));
  }
  card.appendChild(meta);

  card.onclick = () => openTask(t);
  return card;
}

function goalTagFor(t) {
  if (t.goalId) {
    const g = asArray(state.week.goals).find((x) => x.id === t.goalId);
    if (g) return chipTag(g.key, false);
  }
  if (t.continuingGoalId) {
    const c = asArray(state.board.continuingGoals).find((x) => x.id === t.continuingGoalId);
    if (c) return chipTag(c.key, true);
  }
  return null;
}

/* ---------------- 担当者スイムレーン ---------------- */
function renderAssigneeView() {
  const wrap = el("div", "lanes");
  const tasks = visibleTasks();
  // 有効なメンバー＋休止中でもこの週にタスクを持っている人（作業を隠さない）
  const members = asArray(state.board.members).filter(
    (m) => isActive(m) || tasks.some((t) => asArray(t.assignees).includes(m.id))
  );

  const head = el("div", "lane-head");
  head.appendChild(el("div"));
  for (const st of STATUSES) {
    const h = el("div", "h " + st.cls);
    const n = tasks.filter((t) => t.status === st.key).length;
    h.innerHTML = "<span>" + st.label + '</span><span class="n">' + n + "</span>";
    head.appendChild(h);
  }
  wrap.appendChild(head);

  // 各メンバーの行。担当者が複数いるタスクはそれぞれの行に出す。
  for (const m of members) {
    const mine = tasks.filter((t) => asArray(t.assignees).includes(m.id));
    const overdue = mine.filter((t) => isOverdue(t)).length;
    const lane = el("div", "lane" + (overdue ? " over" : ""));

    const who = el("div", "who");
    who.appendChild(avatar(m));
    const nm = el("span");
    nm.textContent = m.name;
    who.appendChild(nm);
    const load = el("span", "load");
    load.textContent = mine.length + (overdue ? " ・超過" + overdue : "");
    who.appendChild(load);
    lane.appendChild(who);

    for (const st of STATUSES) {
      const cell = el("div", "cell");
      for (const t of mine.filter((x) => x.status === st.key)) cell.appendChild(miniCard(t, st.key));
      lane.appendChild(cell);
    }
    wrap.appendChild(lane);
  }

  // 担当者未設定
  const none = tasks.filter((t) => !asArray(t.assignees).length);
  if (none.length) {
    const lane = el("div", "lane");
    const who = el("div", "who");
    who.style.color = "var(--ink-3)";
    who.textContent = "担当なし";
    const load = el("span", "load");
    load.textContent = String(none.length);
    who.appendChild(load);
    lane.appendChild(who);
    for (const st of STATUSES) {
      const cell = el("div", "cell");
      for (const t of none.filter((x) => x.status === st.key)) cell.appendChild(miniCard(t, st.key));
      lane.appendChild(cell);
    }
    wrap.appendChild(lane);
  }

  const scroll = el("div", "lane-scroll");
  scroll.appendChild(wrap);
  return scroll;
}

function miniCard(t, statusKey) {
  const m = el("div", "mini m-" + statusKey);
  const tag = goalTagFor(t);
  const line = el("span");
  line.textContent = (tag ? tag.textContent + " " : "") + t.title;
  m.appendChild(line);
  const d = el("span", "d" + (isOverdue(t) ? " over" : ""));
  d.textContent = fmtDue(t);
  m.appendChild(d);
  m.onclick = () => openTask(t);
  return m;
}

/* ---------------- 振り返り ---------------- */
function renderRetroView() {
  if (!state.retro) {
    if (bridge) { send({ type: "loadRetro" }); return placeholder("読み込み中…"); }
    return placeholder("振り返りはホスト接続時に表示されます（プレビューでは過去週を読み込めません）。");
  }
  if (!state.retro.length) return placeholder("記録された週がまだありません。");

  const wrap = el("div", "retro");
  for (const w of state.retro) {
    const box = el("div", "wk");
    const h = el("div", "wk-h");
    const rate = w.closed
      ? "目標 " + w.goals.length + "件 ・ タスク " + w.taskDone + "/" + w.taskTotal + " 完了 ・ 達成 " + w.achieved + " / 持ち越し " + w.carried
      : "目標 " + w.goals.length + "件 ・ タスク " + w.taskDone + "/" + w.taskTotal + " 完了 ・ 未締め";
    h.innerHTML = '<span class="w">' + esc(w.id) + '</span><span class="d">' + fmtRange(w.range)
      + '</span><span class="rate">' + esc(rate) + "</span>";
    h.onclick = () => { if (bridge) send({ type: "changeWeek", weekId: w.id }); };
    box.appendChild(h);

    const body = el("div", "wk-b");
    if (!w.goals.length) {
      const empty = el("div", "gline");
      empty.style.color = "var(--ink-3)";
      empty.textContent = "目標の登録なし";
      body.appendChild(empty);
    }
    for (const g of w.goals) {
      const line = el("div", "gline");
      let html = '<span class="gkey">' + esc(g.key) + '</span><span class="nm">' + esc(g.title) + "</span>"
        + '<span class="gstat ' + g.status + '">' + statusJa(g.status) + "</span>";
      if (g.carryStreak >= 2) html += '<span class="streak">↻' + g.carryStreak + "週</span>";
      html += '<span class="tk">' + g.done + "/" + g.total + "</span>";
      line.innerHTML = html;
      body.appendChild(line);
    }
    box.appendChild(body);
    wrap.appendChild(box);
  }
  return wrap;
}

/* ---------------- ドラッグ&ドロップ ---------------- */
let draggingId = null;

function wireDrag(card, t) {
  card.addEventListener("dragstart", (e) => {
    draggingId = t.id;
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", t.id);
  });
  card.addEventListener("dragend", () => {
    draggingId = null;
    card.classList.remove("dragging");
    document.querySelectorAll(".dropzone.over").forEach((z) => z.classList.remove("over"));
  });
}

function wireDropzone(zone) {
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    zone.classList.add("over");
    showInsertLine(zone, e.clientY);
  });
  zone.addEventListener("dragleave", (e) => {
    if (!zone.contains(e.relatedTarget)) { zone.classList.remove("over"); clearInsertLine(zone); }
  });
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("over");
    const before = insertBeforeId(zone, e.clientY);
    clearInsertLine(zone);
    const id = draggingId || e.dataTransfer.getData("text/plain");
    const toStatus = zone.dataset.status;
    if (!id) return;
    dropTask(id, toStatus, before);
  });
}

// ドロップ位置の直後に来るカードのIDを返す（末尾なら null）
function insertBeforeId(zone, clientY) {
  const cards = Array.from(zone.querySelectorAll(".card")).filter((c) => c.dataset.taskId !== draggingId);
  for (const c of cards) {
    const r = c.getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return c.dataset.taskId;
  }
  return null;
}

function showInsertLine(zone, clientY) {
  const beforeId = insertBeforeId(zone, clientY);
  document.querySelectorAll(".card.insert-before").forEach((c) => c.classList.remove("insert-before"));
  document.querySelectorAll(".dropzone.insert-end").forEach((z) => z.classList.remove("insert-end"));
  if (beforeId) {
    const target = zone.querySelector('.card[data-task-id="' + beforeId + '"]');
    if (target) target.classList.add("insert-before");
  } else {
    zone.classList.add("insert-end");
  }
}

function clearInsertLine(zone) {
  zone.querySelectorAll(".card.insert-before").forEach((c) => c.classList.remove("insert-before"));
  zone.classList.remove("insert-end");
}

// 列をまたいだら状態変更、同じ列なら並び替え。両方なら状態変更のあと並び替える。
function dropTask(taskId, toStatus, beforeTaskId) {
  const t = asArray(state.week.tasks).find((x) => x.id === taskId);
  if (!t) return;
  const statusChanged = t.status !== toStatus;

  if (!bridge) {
    if (statusChanged) t.status = toStatus;
    reorderLocal(taskId, beforeTaskId);
    render();
    toast(t.title + (statusChanged ? " → " + statusLabel(toStatus) : " を並び替え") + "（プレビュー・未保存）");
    return;
  }
  // 列移動と並び替えは1往復にまとめる（保存と再描画が二重に走らないように）
  if (statusChanged) {
    const from = t.status;   // 変更前を控えてから楽観的更新する
    t.status = toStatus;
    reorderLocal(taskId, beforeTaskId);
    render();
    send({ type: "moveTask", weekId: state.week.id, taskId, from: from, to: toStatus, beforeTaskId: beforeTaskId || "" });
  } else {
    reorderLocal(taskId, beforeTaskId);
    render();
    send({ type: "reorderTask", weekId: state.week.id, taskId, beforeTaskId: beforeTaskId || "" });
  }
}

// プレビュー用のローカル並び替え（ホスト側の Set-TaskOrder と同じ規則）
function reorderLocal(taskId, beforeTaskId) {
  const all = asArray(state.week.tasks);
  const moving = all.find((x) => x.id === taskId);
  if (!moving) return;
  const rest = all.filter((x) => x.id !== taskId);
  const out = [];
  let placed = false;
  for (const t of rest) {
    if (beforeTaskId && t.id === beforeTaskId) { out.push(moving); placed = true; }
    out.push(t);
  }
  if (!placed) out.push(moving);
  state.week.tasks = out;
}

/* ---------------- フィルタ ---------------- */
function toggleFilter(id) {
  filterGoalId = filterGoalId === id ? null : id;
  render();
}

function clearFilter() {
  filterGoalId = null;
  searchText = "";
  document.getElementById("search").value = "";
  render();
}

// 何で絞り込んでいるかの表示名
function filterLabel() {
  if (filterGoalId === "__unlinked__") return "目標に紐づかないタスク";
  const g = asArray(state.week.goals).find((x) => x.id === filterGoalId);
  if (g) return g.key + " ・ " + g.title;
  const c = asArray(state.board.continuingGoals).find((x) => x.id === filterGoalId);
  if (c) return c.key + " ・ " + c.title + "（継続目標）";
  return "選択中の目標";
}

function renderFilterBar() {
  const bar = document.getElementById("filterBar");
  const active = !!filterGoalId || !!searchText;
  bar.hidden = !active;
  if (!active) return;

  const parts = [];
  if (filterGoalId) parts.push(filterLabel());
  if (searchText) parts.push("検索: " + searchText);
  document.getElementById("filterName").textContent = parts.join(" / ");

  const hit = visibleTasks().length;
  const total = asArray(state.week.tasks).length;
  document.getElementById("filterHit").textContent =
    hit === 0 ? "該当なし（全 " + total + " 件）" : hit + " / " + total + " 件";
}

function visibleTasks() {
  let tasks = asArray(state.week.tasks);
  if (filterGoalId === "__unlinked__") tasks = tasks.filter((t) => !t.goalId && !t.continuingGoalId);
  else if (filterGoalId) tasks = tasks.filter((t) => t.goalId === filterGoalId || t.continuingGoalId === filterGoalId);
  if (searchText) {
    const q = searchText.toLowerCase();
    // 子タスクの文言でも親カードが見つかるようにする
    tasks = tasks.filter((t) => t.title.toLowerCase().includes(q)
      || asArray(t.subtasks).some((s) => String(s.title).toLowerCase().includes(q)));
  }
  return tasks;
}

/* ---------------- 詳細ドロワー（新規作成 / 編集 / 削除） ---------------- */
let editingId = null;   // null = 新規作成モード

const openTask = guard("タスクを開く", function (t) { openDrawer(t); });

function openDrawer(task) {
  if (state.week.closed) { toast("締め済みの週は編集できません"); return; }
  if (state.readOnly) { toast("共有フォルダに書き込めないため、閲覧のみです"); return; }
  if (task) {
    const lockedBy = (state.locks || {})[task.id];
    if (lockedBy) { toast(lockedBy + " が編集中です。閉じられるまでお待ちください。"); return; }
  }
  editingId = task ? task.id : null;
  // 開いている間だけ他PCに「編集中」と見せる
  if (task && bridge) send({ type: "lockTask", weekId: state.week.id, taskId: task.id });
  const t = task || {
    title: "", status: "todo", goalId: null, continuingGoalId: null,
    assignees: [], due: state.week.range.end, priority: "normal",
    projectId: null, description: "", subtasks: [], history: [],
  };

  document.getElementById("drawerTitle").textContent = task ? "タスクを編集" : "新規タスク";
  document.getElementById("btnSave").textContent = task ? "保存" : "作成";
  document.getElementById("btnDelete").hidden = !task;
  // 複製は既存タスクにだけ意味がある
  document.getElementById("btnDuplicate").hidden = !task;

  document.getElementById("fTitle").value = t.title || "";
  document.getElementById("fDesc").value = t.description || "";
  // 子タスクは保存まで手元で編集する（キャンセルで元に戻せるよう複製して持つ）
  drawerSubs = asArray(t.subtasks).map((s) => ({ id: s.id, title: s.title, done: !!s.done }));
  document.getElementById("fSubNew").value = "";
  renderSubs();
  document.getElementById("fDue").value = t.due || "";
  document.getElementById("fPriority").value = t.priority || "normal";

  fillSelect("fStatus", STATUSES.map((s) => ({ value: s.key, label: s.label })), t.status);

  // 目標: 週の大目標 → 継続目標 → 紐づけなし
  const goalOpts = [{ value: "", label: "（紐づけなし）" }];
  for (const g of asArray(state.week.goals)) goalOpts.push({ value: "g:" + g.id, label: g.key + " ・ " + g.title });
  for (const c of asArray(state.board.continuingGoals).filter((x) => isActive(x) || x.id === t.continuingGoalId)) {
    goalOpts.push({ value: "c:" + c.id, label: c.key + " ・ " + c.title + "（継続）" });
  }
  const goalVal = t.goalId ? "g:" + t.goalId : t.continuingGoalId ? "c:" + t.continuingGoalId : "";
  fillSelect("fGoal", goalOpts, goalVal);

  // 休止中の案件は選択肢から外すが、既に紐づいているものは残す（勝手に外さない）
  const projOpts = [{ value: "", label: "（なし）" }];
  for (const p of asArray(state.board.projects)) {
    if (!isActive(p) && p.id !== t.projectId) continue;
    projOpts.push({ value: p.id, label: p.name + (isActive(p) ? "" : "（休止中）") });
  }
  fillSelect("fProject", projOpts, t.projectId || "");

  // 担当者ピッカー。休止中でも既に担当しているなら表示する。
  const picker = document.getElementById("fAssignees");
  const selected = new Set(asArray(t.assignees));
  const pickable = asArray(state.board.members).filter((m) => isActive(m) || selected.has(m.id));
  picker.replaceChildren(...pickable.map((m) => {
    const b = el("button", "pick" + (selected.has(m.id) ? " on" : ""));
    b.type = "button";
    b.dataset.memberId = m.id;
    b.appendChild(avatar(m));
    b.appendChild(document.createTextNode(m.name));
    b.onclick = () => b.classList.toggle("on");
    return b;
  }));

  // 履歴。不具合で文字列として保存されたデータでも開けるよう配列に正規化する
  const histWrap = document.getElementById("histWrap");
  const hist = asArray(t.history);
  histWrap.hidden = hist.length === 0;
  document.getElementById("fHistory").textContent = hist.join("\n");

  document.getElementById("scrim").hidden = false;
  document.getElementById("drawer").hidden = false;
  document.getElementById("fTitle").focus();
}

function closeDrawer() {
  if (editingId && bridge) send({ type: "unlockTask", weekId: state.week.id, taskId: editingId });
  document.getElementById("scrim").hidden = true;
  document.getElementById("drawer").hidden = true;
  editingId = null;
}

function collectForm() {
  const goalRaw = document.getElementById("fGoal").value;
  const assignees = Array.from(document.querySelectorAll("#fAssignees .pick.on")).map((b) => b.dataset.memberId);
  return {
    title: document.getElementById("fTitle").value.trim(),
    description: document.getElementById("fDesc").value,
    status: document.getElementById("fStatus").value,
    due: document.getElementById("fDue").value || null,
    priority: document.getElementById("fPriority").value,
    projectId: document.getElementById("fProject").value || null,
    goalId: goalRaw.startsWith("g:") ? goalRaw.slice(2) : null,
    continuingGoalId: goalRaw.startsWith("c:") ? goalRaw.slice(2) : null,
    assignees: assignees,
    subtasks: normSubs(drawerSubs),
  };
}

/* ---- 子タスク（チェックリスト）。週の中の手順だけを扱う ---- */
let drawerSubs = [];

// 保存・比較用にそろえる。空の行は捨てる。新しい行は id 無しで送り、ホスト側で採番する。
function normSubs(list) {
  return asArray(list)
    .map((s) => ({ id: s.id || null, title: String(s.title || "").trim(), done: !!s.done }))
    .filter((s) => s.title);
}

function renderSubs() {
  const wrap = document.getElementById("fSubs");
  wrap.replaceChildren(...drawerSubs.map((s, i) => {
    const row = el("div", "sub" + (s.done ? " done" : ""));
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = s.done;
    cb.onchange = () => { s.done = cb.checked; row.classList.toggle("done", s.done); updateSubCount(); };
    const tx = el("input", "stx");
    tx.value = s.title;
    tx.oninput = () => { s.title = tx.value; };
    const del = el("button", "sdel");
    del.type = "button";
    del.textContent = "✕";
    del.title = "この子タスクを消す";
    del.onclick = () => { drawerSubs.splice(i, 1); renderSubs(); };
    row.append(cb, tx, del);
    return row;
  }));
  updateSubCount();
}

function updateSubCount() {
  const n = drawerSubs.length;
  document.getElementById("fSubCount").textContent =
    n ? drawerSubs.filter((s) => s.done).length + "/" + n : "";
}

function addSub() {
  const input = document.getElementById("fSubNew");
  const title = input.value.trim();
  if (!title) return;
  drawerSubs.push({ id: null, title, done: false });
  input.value = "";
  renderSubs();
  input.focus();
}

function saveDrawer() {
  // 追加欄に打ちかけの子タスクがあれば、取りこぼさず含める
  if (document.getElementById("fSubNew").value.trim()) addSub();
  const fields = collectForm();
  if (!fields.title) { toast("タイトルを入力してください"); document.getElementById("fTitle").focus(); return; }
  if (!bridge) { toast("プレビューでは保存されません"); closeDrawer(); return; }
  if (editingId) send({ type: "updateTask", weekId: state.week.id, taskId: editingId, fields });
  else send({ type: "createTask", weekId: state.week.id, fields });
  closeDrawer();
}

// 開いているタスクを複製する。未保存の編集があれば先に確認する。
function duplicateDrawer() {
  if (!editingId) return;
  const t = asArray(state.week.tasks).find((x) => x.id === editingId);
  if (!t) return;
  // 担当者は並び順が違うだけで別物と見なさないよう、そろえてから比べる
  const norm = (o) => JSON.stringify(Object.assign({}, o, { assignees: asArray(o.assignees).slice().sort() }));
  const edited = norm(collectForm()) !== norm(currentFormOf(t));
  if (edited && !confirm("保存していない変更があります。\n複製すると、その変更は反映されません。続けますか？")) return;
  if (!bridge) { toast("プレビューでは複製されません"); closeDrawer(); return; }
  send({ type: "duplicateTask", weekId: state.week.id, taskId: editingId });
  closeDrawer();
}

// 保存済みの内容をフォームと同じ形にそろえる（未保存かどうかの判定用）
function currentFormOf(t) {
  return {
    title: t.title || "",
    description: t.description || "",
    status: t.status,
    due: t.due || null,
    priority: t.priority || "normal",
    projectId: t.projectId || null,
    goalId: t.goalId || null,
    continuingGoalId: t.continuingGoalId || null,
    assignees: asArray(t.assignees),
    subtasks: normSubs(t.subtasks),
  };
}

function deleteDrawer() {
  if (!editingId) return;
  const t = asArray(state.week.tasks).find((x) => x.id === editingId);
  if (!confirm("「" + (t ? t.title : "このタスク") + "」を削除します。よろしいですか？")) return;
  if (!bridge) { toast("プレビューでは削除されません"); closeDrawer(); return; }
  send({ type: "deleteTask", weekId: state.week.id, taskId: editingId });
  closeDrawer();
}

/* ---------------- 週の目標 編集ドロワー ---------------- */
let editingGoalId = null;

function openGoalDrawer(g) {
  if (state.week.closed) { toast("締め済みの週は編集できません"); return; }
  if (state.readOnly) { toast("共有フォルダに書き込めないため、閲覧のみです"); return; }
  editingGoalId = g.id;

  const linked = asArray(state.week.tasks).filter((t) => t.goalId === g.id);
  document.getElementById("goalDrawerTitle").textContent = g.key + " の目標を編集";
  document.getElementById("gTitle").value = g.title || "";
  document.getElementById("gStatus").value = g.status || "running";

  let hint = "紐づくタスク " + linked.length + " 件。";
  hint += g.carriedFrom ? " " + g.carriedFrom + " から持ち越した目標です。" : "";
  hint += " 削除してもタスクは残り、紐づけだけが外れます。";
  hint += " 達成／持ち越しは週の締めでも判定できます。";
  document.getElementById("gHint").textContent = hint;

  document.getElementById("scrim").hidden = false;
  document.getElementById("goalDrawer").hidden = false;
  document.getElementById("gTitle").focus();
}

function closeGoalDrawer() {
  document.getElementById("scrim").hidden = true;
  document.getElementById("goalDrawer").hidden = true;
  editingGoalId = null;
}

function saveGoalDrawer() {
  const title = document.getElementById("gTitle").value.trim();
  if (!title) { toast("目標を入力してください"); document.getElementById("gTitle").focus(); return; }
  if (!bridge) { toast("プレビューでは保存されません"); closeGoalDrawer(); return; }
  send({
    type: "updateGoal", weekId: state.week.id, goalId: editingGoalId,
    fields: { title: title, status: document.getElementById("gStatus").value },
  });
  closeGoalDrawer();
}

function deleteGoalDrawer() {
  const g = asArray(state.week.goals).find((x) => x.id === editingGoalId);
  const n = asArray(state.week.tasks).filter((t) => t.goalId === editingGoalId).length;
  const msg = "「" + (g ? g.title : "この目標") + "」を削除します。"
    + (n ? "\n紐づくタスク " + n + " 件は残り、紐づけだけが外れます。" : "") + "\nよろしいですか？";
  if (!confirm(msg)) return;
  if (!bridge) { toast("プレビューでは削除されません"); closeGoalDrawer(); return; }
  send({ type: "deleteGoal", weekId: state.week.id, goalId: editingGoalId });
  closeGoalDrawer();
}

/* ---------------- 継続目標の管理ドロワー ---------------- */
function openContDrawer() {
  if (state.readOnly) { toast("共有フォルダに書き込めないため、閲覧のみです"); return; }
  renderContList();
  document.getElementById("contNew").value = "";
  document.getElementById("scrim").hidden = false;
  document.getElementById("contDrawer").hidden = false;
}

function closeContDrawer() {
  document.getElementById("scrim").hidden = true;
  document.getElementById("contDrawer").hidden = true;
}

function renderContList() {
  const list = document.getElementById("contList");
  const goals = asArray(state.board.continuingGoals);
  if (!goals.length) {
    const p = el("p", "hint");
    p.textContent = "まだ継続目標がありません。";
    list.replaceChildren(p);
    return;
  }
  list.replaceChildren(...goals.map((c) => {
    const active = isActive(c);
    const row = el("div", "cg" + (active ? "" : " off"));

    const top = el("div", "top");
    const key = el("span", "gkey");
    key.style.background = "var(--ink-3)";
    key.textContent = c.key;
    top.appendChild(key);
    const input = document.createElement("input");
    input.type = "text"; input.value = c.title;
    input.onchange = () => {
      const v = input.value.trim();
      if (!v) { input.value = c.title; toast("タイトルは空にできません"); return; }
      if (v === c.title) return;
      sendCont("updateContinuingGoal", c.id, { title: v });
    };
    top.appendChild(input);
    row.appendChild(top);

    const foot = el("div", "foot");
    const stat = el("span");
    stat.textContent = (active ? "有効" : "休止中") + " ・ 通算 " + (c.totalDone || 0) + " 件";
    foot.appendChild(stat);
    foot.appendChild(el("span", "sp"));

    const toggle = el("button", "btn");
    toggle.textContent = active ? "休止する" : "再開する";
    toggle.onclick = () => sendCont("updateContinuingGoal", c.id, { active: !active });
    foot.appendChild(toggle);

    const del = el("button", "btn danger");
    del.textContent = "削除";
    del.onclick = () => {
      if (!confirm("「" + c.title + "」を削除します。\n未締めの週のタスクから紐づけが外れます（締めた週の記録は変わりません）。\n\n一時的に使わないだけなら「休止する」をお勧めします。よろしいですか？")) return;
      sendCont("deleteContinuingGoal", c.id, null);
    };
    foot.appendChild(del);

    row.appendChild(foot);
    return row;
  }));
}

function sendCont(type, goalId, fields) {
  if (!bridge) { toast("プレビューでは変更されません"); return; }
  const msg = { type: type, goalId: goalId };
  if (fields) msg.fields = fields;
  send(msg);
}

function addContGoal() {
  const input = document.getElementById("contNew");
  const v = input.value.trim();
  if (!v) { toast("タイトルを入力してください"); input.focus(); return; }
  if (!bridge) { toast("プレビューでは追加されません"); return; }
  send({ type: "createContinuingGoal", title: v });
  input.value = "";
}

/* ---------------- メモ・連絡事項 ---------------- */
// 開閉状態はセッション中だけメモリに持つ（起動・週切替のたびに「ピン留めの有無」で決め直すため保存しない）。
// null = 未決定（次の描画でピン留め有無から決める）。手で開閉／スクロールで畳んだら以後はその値を優先。
let memoCollapsed = null;
const MEMO_AUTO_COLLAPSE_PX = 40;

function renderMemo() {
  const section = document.getElementById("memo");
  const notes = sortedNotes();
  const canEdit = !state.readOnly;

  // メモが1件も無く、書き込みもできないなら帯ごと隠す
  if (!notes.length && !canEdit) { section.hidden = true; return; }
  section.hidden = false;

  document.getElementById("memoCount").textContent = notes.length;
  document.getElementById("memoPeek").textContent = notes.length ? notes[0].text : "（まだありません）";
  if (memoCollapsed === null) memoCollapsed = !notes.some((n) => n.pinned);
  section.classList.toggle("collapsed", memoCollapsed);
  document.getElementById("memoToggle").setAttribute("aria-expanded", String(!memoCollapsed));

  const list = document.getElementById("memoList");
  if (!notes.length) {
    const p = el("div", "memo-empty");
    p.textContent = "週をまたいで覚えておきたいことや、チームへの連絡を書いておけます。";
    list.replaceChildren(p);
  } else {
    list.replaceChildren(...notes.map((n) => renderNote(n, canEdit)));
  }

  document.getElementById("memoNew").disabled = !canEdit;
  document.getElementById("memoAdd").disabled = !canEdit;
}

// 目立たせたいものを上に。同じ扱いなら新しい順（配列の順序を保つ）。
function sortedNotes() {
  const notes = asArray(state.board.notes).slice();
  return notes.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
}

function renderNote(n, canEdit) {
  const row = el("div", "note" + (n.pinned ? " pin" : ""));

  const pin = el("button", "pinbtn");
  pin.type = "button";
  pin.textContent = n.pinned ? "📌" : "○";
  pin.title = n.pinned ? "目立たせるのをやめる" : "上に固定して目立たせる";
  pin.disabled = !canEdit;
  pin.onclick = () => sendMsg({ type: "updateNote", noteId: n.id, fields: { pinned: !n.pinned } });
  row.appendChild(pin);

  // 表示はリンク付きテキスト。クリックすると編集用の textarea に差し替える。
  // （textarea のままではリンクを押せないため）
  const view = el("div", "txt view");
  view.appendChild(renderTextWithLinks(n.text));
  if (canEdit) {
    view.title = "クリックして編集";
    view.onclick = (ev) => {
      if (ev.target.closest("a")) return;   // リンクを押したときは編集に入らない
      startEditNote(row, view, n);
    };
  }
  row.appendChild(view);

  const by = el("span", "by");
  by.textContent = fmtNoteDate(n.createdAt) + " " + (n.author || "");
  row.appendChild(by);

  if (canEdit) {
    const del = el("button", "del");
    del.type = "button";
    del.textContent = "✕";
    del.title = "このメモを削除";
    del.onclick = () => {
      if (!confirm("「" + n.text.slice(0, 40) + (n.text.length > 40 ? "…" : "") + "」を削除します。よろしいですか？")) return;
      sendMsg({ type: "deleteNote", noteId: n.id });
    };
    row.appendChild(del);
  }
  return row;
}

/* メモ内のURL・共有フォルダのパス・メールアドレスをリンクにする。
   innerHTML を使わず DOM を組み立てるので、書かれた内容がHTMLとして解釈されることはない。 */
// リンクの切れ目にする文字。共有フォルダ名に日本語が使われることは普通にあるので
// 全角を一律に除外はせず、日本語の句読点と括弧だけを境界にする。
// これが無いと「\\NAS\共有\見積、確認お願いします」のように後続の文まで飲み込む。
const LINK_STOP = "\\s<>\"'、。，．・…！？　（）〈〉《》「」『』【】〔〕｛｝［］";
const LINK_RE = new RegExp(
  "(https?://[^" + LINK_STOP + "]+)" +          // http / https
  "|(\\\\\\\\[^" + LINK_STOP + "|*?]+)" +       // \\サーバー\共有\... （UNCパス）
  "|([A-Za-z]:\\\\[^" + LINK_STOP + "|*?]+)" +  // C:\... （ローカルパス）
  "|([\\w.+-]+@[\\w-]+\\.[\\w.-]+)",            // メールアドレス
  "g"
);
// 文末の句読点や閉じ括弧はリンクに含めない
const TRAIL_RE = /[。、．，,.;:!?！？）)\]】」』>＞]+$/;

function renderTextWithLinks(text) {
  const frag = document.createDocumentFragment();
  const s = String(text == null ? "" : text);
  let last = 0;
  LINK_RE.lastIndex = 0;
  let m;
  while ((m = LINK_RE.exec(s)) !== null) {
    const target = m[0].replace(TRAIL_RE, "");
    if (!target) { LINK_RE.lastIndex = m.index + m[0].length; continue; }
    if (m.index > last) frag.appendChild(document.createTextNode(s.slice(last, m.index)));

    const a = document.createElement("a");
    a.className = "lnk";
    a.href = "#";
    a.textContent = target;
    a.title = target + "（クリックで開きます）";
    a.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openLink(target);
    };
    frag.appendChild(a);

    last = m.index + target.length;
    LINK_RE.lastIndex = last;
  }
  if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last)));
  return frag;
}

// WebView2 の中で開くとアプリごと遷移してしまうので、ホストに開いてもらう
function openLink(target) {
  if (!bridge) { toast("プレビューでは開けません: " + target); return; }
  send({ type: "openLink", url: target });
}

// 表示 → 編集への切り替え
function startEditNote(row, view, n) {
  const ta = document.createElement("textarea");
  ta.className = "txt";
  ta.value = n.text;
  ta.rows = 1;
  ta.maxLength = 200;
  const fit = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const v = ta.value.trim();
    if (save && v && v !== n.text) {
      sendMsg({ type: "updateNote", noteId: n.id, fields: { text: v } });
      return;   // 保存すると再描画されるので戻す必要はない
    }
    if (save && !v) toast("メモは空にできません");
    // 変更なし・取りやめのときは表示に戻す
    const back = el("div", "txt view");
    back.appendChild(renderTextWithLinks(n.text));
    back.title = "クリックして編集";
    back.onclick = (ev) => { if (!ev.target.closest("a")) startEditNote(row, back, n); };
    row.replaceChild(back, ta);
  };

  ta.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
  };
  ta.onblur = () => finish(true);
  ta.oninput = fit;

  row.replaceChild(ta, view);
  fit();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function fmtNoteDate(iso) {
  if (!iso) return "";
  const s = String(iso).slice(5).replace("-", "/");
  return s || "";
}

function toggleMemo() {
  memoCollapsed = !memoCollapsed;
  renderMemo();
}

// 看板を下へ読み進めたらメモ欄を畳んで高さを譲る（開き直しはしない）。入力・編集中は畳まない。
function autoCollapseMemo() {
  if (memoCollapsed !== false) return;
  const section = document.getElementById("memo");
  if (section.hidden || section.contains(document.activeElement)) return;
  if (document.getElementById("viewRoot").scrollTop <= MEMO_AUTO_COLLAPSE_PX) return;
  memoCollapsed = true;
  renderMemo();
}

function addNote() {
  const input = document.getElementById("memoNew");
  const v = input.value.trim();
  if (!v) { toast("内容を入力してください"); input.focus(); return; }
  if (!bridge) { toast("プレビューでは保存されません"); return; }
  send({ type: "createNote", text: v });
  input.value = "";
}

/* ---------------- メンバー・案件の設定ドロワー ---------------- */
const PALETTE = [
  "#2F6E86", "#8A5A2B", "#5B6E33", "#7A4A6E", "#43607F", "#8C4A45",
  "#3F6B57", "#7B5AA6", "#A05252", "#4A6B8A", "#6B7A3A", "#87543F",
];
let paletteOpenFor = null;   // 色パレットを開いているメンバーID

function openSettings() {
  if (state.readOnly) { toast("共有フォルダに書き込めないため、閲覧のみです"); return; }
  paletteOpenFor = null;
  renderSettings();
  document.getElementById("memberNew").value = "";
  document.getElementById("projectNew").value = "";
  document.getElementById("scrim").hidden = false;
  document.getElementById("setDrawer").hidden = false;
}

function closeSettings() {
  document.getElementById("scrim").hidden = true;
  document.getElementById("setDrawer").hidden = true;
  paletteOpenFor = null;
}

function renderSettings() {
  renderMemberList();
  renderProjectList();
}

function renderMemberList() {
  const list = document.getElementById("memberList");
  const members = asArray(state.board.members);
  if (!members.length) {
    const p = el("p", "hint");
    p.textContent = "まだメンバーがいません。";
    list.replaceChildren(p);
    return;
  }
  const nodes = [];
  for (const m of members) {
    const active = isActive(m);
    const row = el("div", "mb" + (active ? "" : " off"));

    const av = avatar(m);
    av.setAttribute("role", "button");
    av.tabIndex = 0;
    av.title = "色と表示文字を変える";
    av.onclick = () => {
      paletteOpenFor = paletteOpenFor === m.id ? null : m.id;
      renderMemberList();
    };
    row.appendChild(av);

    const nm = document.createElement("input");
    nm.type = "text"; nm.className = "nm"; nm.value = m.name; nm.maxLength = 20;
    nm.onchange = () => {
      const v = nm.value.trim();
      if (!v) { nm.value = m.name; toast("名前は空にできません"); return; }
      if (v === m.name) return;
      sendMsg({ type: "updateMember", memberId: m.id, fields: { name: v } });
    };
    row.appendChild(nm);

    if (!active) {
      const tag = el("span", "tag");
      tag.textContent = "休止中";
      row.appendChild(tag);
    }

    const toggle = el("button", "btn");
    toggle.textContent = active ? "休止する" : "戻す";
    toggle.onclick = () => sendMsg({ type: "updateMember", memberId: m.id, fields: { active: !active } });
    row.appendChild(toggle);

    const del = el("button", "btn danger");
    del.textContent = "削除";
    del.onclick = () => confirmDeleteMember(m);
    row.appendChild(del);

    nodes.push(row);

    // 色と表示文字のパレット（アバターをクリックしたときだけ開く）
    if (paletteOpenFor === m.id) {
      const pal = el("div", "palette");
      for (const c of PALETTE) {
        const sw = el("button", "sw" + (c.toLowerCase() === String(m.color).toLowerCase() ? " on" : ""));
        sw.style.background = c;
        sw.title = c;
        sw.onclick = () => sendMsg({ type: "updateMember", memberId: m.id, fields: { color: c } });
        pal.appendChild(sw);
      }
      const lbl = el("span", "lbl");
      lbl.textContent = "表示文字";
      pal.appendChild(lbl);
      const ini = document.createElement("input");
      ini.type = "text"; ini.className = "ini"; ini.value = m.initial || ""; ini.maxLength = 1;
      ini.onchange = () => {
        const v = ini.value.trim();
        if (!v) { ini.value = m.initial || ""; return; }
        if (v === m.initial) return;
        sendMsg({ type: "updateMember", memberId: m.id, fields: { initial: v } });
      };
      pal.appendChild(ini);
      nodes.push(pal);
    }
  }
  list.replaceChildren(...nodes);
}

function confirmDeleteMember(m) {
  const n = countAssigned(m.id);
  let msg = "「" + m.name + "」を削除します。";
  if (n.unclosed) msg += "\n未締めの週のタスク " + n.unclosed + " 件から担当が外れます。";
  if (n.closedOnly) msg += "\n締めた週の記録 " + n.closedOnly + " 件はそのまま残ります。";
  msg += "\n\nチームから外れただけなら「休止する」をお勧めします。よろしいですか？";
  if (!confirm(msg)) return;
  sendMsg({ type: "deleteMember", memberId: m.id });
}

// 現在読み込んでいる週のぶんだけ数える（全期間はホスト側の loadUsage が持つ）
function countAssigned(memberId) {
  const tasks = asArray(state.week.tasks);
  const n = tasks.filter((t) => asArray(t.assignees).includes(memberId)).length;
  return state.week.closed ? { unclosed: 0, closedOnly: n } : { unclosed: n, closedOnly: 0 };
}

function renderProjectList() {
  const list = document.getElementById("projectList");
  const projects = asArray(state.board.projects);
  if (!projects.length) {
    const p = el("p", "hint");
    p.textContent = "まだ案件がありません。";
    list.replaceChildren(p);
    return;
  }
  list.replaceChildren(...projects.map((p) => {
    const active = isActive(p);
    const row = el("div", "mb" + (active ? "" : " off"));

    const nm = document.createElement("input");
    nm.type = "text"; nm.className = "nm"; nm.value = p.name; nm.maxLength = 40;
    nm.onchange = () => {
      const v = nm.value.trim();
      if (!v) { nm.value = p.name; toast("案件名は空にできません"); return; }
      if (v === p.name) return;
      sendMsg({ type: "updateProject", projectId: p.id, fields: { name: v } });
    };
    row.appendChild(nm);

    if (!active) {
      const tag = el("span", "tag");
      tag.textContent = "休止中";
      row.appendChild(tag);
    }

    const toggle = el("button", "btn");
    toggle.textContent = active ? "休止する" : "戻す";
    toggle.onclick = () => sendMsg({ type: "updateProject", projectId: p.id, fields: { active: !active } });
    row.appendChild(toggle);

    const del = el("button", "btn danger");
    del.textContent = "削除";
    del.onclick = () => {
      const n = asArray(state.week.tasks).filter((t) => t.projectId === p.id).length;
      let msg = "案件「" + p.name + "」を削除します。";
      if (n) msg += "\n今週のタスク " + n + " 件から紐づけが外れます（締めた週の記録は変わりません）。";
      msg += "\n\n終わった案件なら「休止する」をお勧めします。よろしいですか？";
      if (!confirm(msg)) return;
      sendMsg({ type: "deleteProject", projectId: p.id });
    };
    row.appendChild(del);
    return row;
  }));
}

function addMember() {
  const input = document.getElementById("memberNew");
  const v = input.value.trim();
  if (!v) { toast("名前を入力してください"); input.focus(); return; }
  if (!bridge) { toast("プレビューでは追加されません"); return; }
  send({ type: "createMember", fields: { name: v } });
  input.value = "";
}

function addProject() {
  const input = document.getElementById("projectNew");
  const v = input.value.trim();
  if (!v) { toast("案件名を入力してください"); input.focus(); return; }
  if (!bridge) { toast("プレビューでは追加されません"); return; }
  send({ type: "createProject", name: v });
  input.value = "";
}

function sendMsg(msg) {
  if (!bridge) { toast("プレビューでは変更されません"); return; }
  send(msg);
}

// 配列であることを保証する。PowerShell 側の書き出し方によっては
// 1件しかない配列が単体の値になって届くことがあるため、受け側でも守っておく。
function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v === null || v === undefined || v === "") return [];
  return [v];
}

// active が未設定の既存データは「有効」とみなす
function isActive(x) { return !x || x.active !== false; }
function activeMembers() { return asArray(state.board.members).filter(isActive); }
function activeProjects() { return asArray(state.board.projects).filter(isActive); }

/* ---------------- 締めの解除 ---------------- */
// ホストに「解除したら何が起きるか」を問い合わせ、結果が届いたら確認画面を出す
function askReopen() {
  if (!bridge) { toast("プレビューでは解除できません"); return; }
  send({ type: "checkReopen", weekId: state.week.id });
}

function showReopenDialog(c) {
  const body = document.getElementById("reopenBody");
  body.replaceChildren();

  document.getElementById("reopenTitle").textContent = c.weekId + " の締めを解除";
  const sub = [];
  if (c.closedAt) sub.push(c.closedAt + " に " + (c.closedBy || "不明") + " が締めました");
  document.getElementById("reopenSub").textContent = sub.join(" / ");

  const confirmBtn = document.getElementById("reopenConfirm");

  if (!c.canReopen) {
    body.appendChild(noteBlock("warn", c.reason));
    confirmBtn.hidden = true;
  } else {
    confirmBtn.hidden = false;
    body.appendChild(noteBlock("", c.weekId + " をもう一度編集できる状態に戻します。この週の目標は「進行中」に戻ります。"));

    if (c.reason) body.appendChild(noteBlock("warn", c.reason));

    const remove = asArray(c.removeTasks);
    const keep = asArray(c.keepTasks);

    if (c.nextWeekId) {
      if (remove.length) {
        body.appendChild(listBlock(
          c.nextWeekId + " から取り消すもの（" + remove.length + "件）",
          remove,
          "締めたときに運ばれた分です。まだ誰も手を付けていないので取り消します。"
        ));
      }
      if (keep.length) {
        body.appendChild(listBlock(
          c.nextWeekId + " に残すもの（" + keep.length + "件）",
          keep,
          "着手済み・編集済みのため取り消しません。不要なら次週で手動で削除してください。"
        ));
      }
      if (!remove.length && !keep.length) {
        body.appendChild(noteBlock("", c.nextWeekId + " に持ち越したものはありません。"));
      }
      if (c.removeGoals) {
        body.appendChild(noteBlock("", "持ち越した目標 " + c.removeGoals + " 件も、残すタスクが無ければ " + c.nextWeekId + " から取り消します。"));
      }
    }
  }

  document.getElementById("reopenScrim").hidden = false;
  document.getElementById("reopenModal").hidden = false;
}

function noteBlock(kind, text) {
  const d = el("div", "rp-note" + (kind ? " " + kind : ""));
  d.textContent = text;
  return d;
}

function listBlock(title, items, hint) {
  const wrap = el("div", "rp-sec");
  const h = el("div", "rp-h");
  h.textContent = title;
  wrap.appendChild(h);
  const ul = el("ul", "rp-list");
  for (const it of items) {
    const li = el("li");
    li.textContent = it;
    ul.appendChild(li);
  }
  wrap.appendChild(ul);
  if (hint) {
    const p = el("div", "rp-hint");
    p.textContent = hint;
    wrap.appendChild(p);
  }
  return wrap;
}

function closeReopenDialog() {
  document.getElementById("reopenScrim").hidden = true;
  document.getElementById("reopenModal").hidden = true;
}

function confirmReopen() {
  if (!bridge) { closeReopenDialog(); return; }
  send({ type: "reopenWeek", weekId: state.week.id });
  closeReopenDialog();
}

/* ---------------- 週の締めダイアログ ---------------- */
const judgements = {};        // goalId -> 'achieved' | 'carried'

function openCloseDialog() {
  const w = state.week;
  if (w.closed) { toast(w.id + " は既に締め済みです"); return; }
  const goals = w.goals || [];
  const tasks = w.tasks || [];
  const unfinished = tasks.filter((t) => t.status !== "done");

  // 既定は「持ち越す」。全タスク完了の目標だけ「達成」を初期選択にする。
  for (const g of goals) {
    const linked = tasks.filter((t) => t.goalId === g.id);
    judgements[g.id] = (linked.length > 0 && linked.every((t) => t.status === "done")) ? "achieved" : "carried";
  }

  document.getElementById("closeTitle").textContent = w.id + " を締める";
  document.getElementById("closeSub").textContent =
    fmtRange(w.range) + " ・ 目標 " + goals.length + "件、未完了タスク " + unfinished.length + "件";

  const body = document.getElementById("closeBody");
  body.replaceChildren();

  for (const g of goals) {
    const linked = tasks.filter((t) => t.goalId === g.id);
    const doneN = linked.filter((t) => t.status === "done").length;
    const openTasks = linked.filter((t) => t.status !== "done");
    const row = el("div", "jrow");

    const gt = el("div", "gt");
    gt.innerHTML = '<span class="gkey">' + esc(g.key) + "</span>" + esc(g.title);
    row.appendChild(gt);

    const sub = el("div", "sub");
    let subHtml = "タスク " + linked.length + "件中 " + doneN + "件完了 ・ 未完了 " + openTasks.length + "件";
    if (g.carryStreak >= 1) subHtml += ' ・ <span class="warn">' + (g.carryStreak + 1) + "週連続の持ち越しになります</span>";
    sub.innerHTML = subHtml;
    row.appendChild(sub);

    // 達成 / 持ち越し のトグル
    const seg = el("div", "seg");
    for (const v of [{ k: "carried", t: "持ち越す" }, { k: "achieved", t: "達成にする" }]) {
      const b = el("button");
      b.type = "button"; b.dataset.v = v.k; b.textContent = v.t;
      b.classList.toggle("on", judgements[g.id] === v.k);
      b.onclick = () => {
        judgements[g.id] = v.k;
        seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x.dataset.v === v.k));
        syncCarryList(row, v.k);
        updateCloseSummary();
      };
      seg.appendChild(b);
    }
    row.appendChild(seg);

    // 運ぶタスクのチェックリスト（持ち越し時のみ有効）
    if (openTasks.length) {
      const list = el("div", "carrylist");
      list.dataset.goalId = g.id;
      for (const t of openTasks) list.appendChild(carryCheckbox(t, judgements[g.id] === "carried"));
      row.appendChild(list);
    }
    body.appendChild(row);
  }

  // 目標に紐づかない未完了タスク
  const loose = unfinished.filter((t) => !t.goalId);
  if (loose.length) {
    const row = el("div", "jrow");
    const gt = el("div", "gt");
    gt.style.fontWeight = "400"; gt.style.color = "var(--ink-2)"; gt.style.fontSize = "12.5px";
    gt.textContent = "目標に紐づかない未完了タスク " + loose.length + "件";
    row.appendChild(gt);
    const list = el("div", "carrylist");
    for (const t of loose) list.appendChild(carryCheckbox(t, true));
    row.appendChild(list);
    body.appendChild(row);
  }

  updateCloseSummary();
  document.getElementById("closeScrim").hidden = false;
  document.getElementById("closeModal").hidden = false;
}

function carryCheckbox(t, checked) {
  const lab = el("label");
  const cb = document.createElement("input");
  cb.type = "checkbox"; cb.checked = checked; cb.dataset.taskId = t.id;
  cb.onchange = updateCloseSummary;
  lab.appendChild(cb);
  const span = el("span");
  span.textContent = t.title;
  const st = el("span", "st");
  st.textContent = " [" + statusLabel(t.status) + "]";
  span.appendChild(st);
  lab.appendChild(span);
  return lab;
}

// 「達成」を選んだ目標の配下タスクは運ばない（チェックを外して無効化）
function syncCarryList(row, verdict) {
  const list = row.querySelector(".carrylist");
  if (!list) return;
  const carry = verdict === "carried";
  list.querySelectorAll("input").forEach((cb) => { cb.checked = carry; cb.disabled = !carry; });
  list.style.opacity = carry ? "1" : ".45";
}

function collectCarryIds() {
  return Array.from(document.querySelectorAll("#closeBody input[type=checkbox]"))
    .filter((cb) => cb.checked && !cb.disabled)
    .map((cb) => cb.dataset.taskId);
}

function updateCloseSummary() {
  const carriedGoals = Object.values(judgements).filter((v) => v === "carried").length;
  const carriedTasks = collectCarryIds().length;
  document.getElementById("closeSummary").textContent =
    "次週に 目標" + carriedGoals + "件・タスク" + carriedTasks + "件 が作られます";
}

function closeCloseDialog() {
  document.getElementById("closeScrim").hidden = true;
  document.getElementById("closeModal").hidden = true;
}

function confirmClose() {
  if (!bridge) { toast("プレビューでは締められません"); closeCloseDialog(); return; }
  send({
    type: "closeWeek",
    weekId: state.week.id,
    judgements: judgements,
    carryTaskIds: collectCarryIds(),
  });
  closeCloseDialog();
}

function fillSelect(id, options, value) {
  const sel = document.getElementById(id);
  sel.replaceChildren(...options.map((o) => {
    const opt = document.createElement("option");
    opt.value = o.value; opt.textContent = o.label;
    return opt;
  }));
  sel.value = value == null ? "" : value;
}

/* ---------------- スケジュール（ガント） ---------------- */
// 案件 → 工程 → 作業/マイルストーン の3段。データは state.schedule.items（ホストの schedule.json）。
const SCHED_DAY_W = 22;
const SCHED_WEEKS = 13;
const SCHED_LS_KEY = "taskboard.schedule.collapsed";
const SCHED_KINDS = [
  { value: "phase", label: "工程" },
  { value: "task", label: "作業" },
  { value: "milestone", label: "マイルストーン" },
];
let schedStart = null;        // 表示開始日（月曜）。null = 初期位置（今週の月曜の2週前）
let schedLinks = [];          // scheduleLinks の links
let schedCollapsed = schedLoadCollapsed();
let schedMenuEl = null;
let schedEditingId = null;

function schedLoadCollapsed() {
  try {
    const raw = localStorage.getItem(SCHED_LS_KEY);
    const a = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(a) ? a : []);
  } catch (e) { return new Set(); }
}
function schedSaveCollapsed() {
  try { localStorage.setItem(SCHED_LS_KEY, JSON.stringify(Array.from(schedCollapsed))); } catch (e) { /* 保存できなくても動く */ }
}

/* 日付ユーティリティ（"yyyy-MM-dd" を UTC で扱い、夏時間などに左右されないようにする） */
function schedPad(n) { return String(n).padStart(2, "0"); }
function schedParse(iso) { const p = String(iso).split("-"); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
function schedFmt(ms) { const d = new Date(ms); return d.getUTCFullYear() + "-" + schedPad(d.getUTCMonth() + 1) + "-" + schedPad(d.getUTCDate()); }
function schedAddDays(iso, n) { return schedFmt(schedParse(iso) + n * 86400000); }
function schedDiff(a, b) { return Math.round((schedParse(b) - schedParse(a)) / 86400000); }
function schedMonday(iso) { const dow = (new Date(schedParse(iso)).getUTCDay() + 6) % 7; return schedAddDays(iso, -dow); }
// ISO週（木曜が属する年の週）。"2026-W40" 形式の週IDを返す
function schedWeekIdOf(iso) {
  const ms = schedParse(iso);
  const dow = (new Date(ms).getUTCDay() + 6) % 7;
  const thu = ms + (3 - dow) * 86400000;
  const y = new Date(thu).getUTCFullYear();
  const w = Math.floor((thu - Date.UTC(y, 0, 1)) / 86400000 / 7) + 1;
  return y + "-W" + schedPad(w);
}
// 週ID → その週の月曜（不正なら null）
function schedWeekMonday(weekId) {
  const m = /^(\d+)-W(\d+)$/.exec(String(weekId));
  if (!m) return null;
  const jan4 = Date.UTC(+m[1], 0, 4);
  const dow = (new Date(jan4).getUTCDay() + 6) % 7;
  return schedFmt(jan4 - dow * 86400000 + (+m[2] - 1) * 7 * 86400000);
}
function schedToday() { return state.today || todayISO(); }
function schedDefaultStart() { return schedAddDays(schedMonday(schedToday()), -14); }

/* データ */
function schedItems() { return asArray(state && state.schedule && state.schedule.items); }
function schedById(id) { return schedItems().find((i) => i.id === id) || null; }
function schedCmp(a, b) {
  const pa = a.period, pb = b.period;
  if (pa.start !== pb.start) return pa.start < pb.start ? -1 : 1;
  const ta = a.item.title || "", tb = b.item.title || "";
  return ta < tb ? -1 : ta > tb ? 1 : 0;
}
function schedKids(phaseId) { return schedItems().filter((i) => i.kind !== "phase" && i.parentId === phaseId); }
// 工程も自分で入力した start/end を使う（工程を先に置き、作業はあとから入れる運用のため、子から計算しない）
function schedPeriodOf(item) {
  return { start: item.start, end: item.end || item.start };
}
// 工程の期間から外れている子の範囲（左・右）。なければ空配列
function schedSpillOf(item) {
  if (item.kind !== "phase" || !item.start) return [];
  const pEnd = item.end || item.start;
  const kids = schedKids(item.id).filter((k) => k.start && k.end);
  if (!kids.length) return [];
  const minS = kids.reduce((m, k) => (k.start < m ? k.start : m), kids[0].start);
  const maxE = kids.reduce((m, k) => (k.end > m ? k.end : m), kids[0].end);
  const out = [];
  if (minS < item.start) out.push({ start: minS, end: schedAddDays(item.start, -1) });
  if (maxE > pEnd) out.push({ start: schedAddDays(pEnd, 1), end: maxE });
  return out;
}
function schedNode(item) { return { item: item, period: schedPeriodOf(item), kids: [] }; }

// 案件ごとの木を作る。projects の順、最後に「案件なし」
function schedTree() {
  const items = schedItems();
  const phaseIds = new Set(items.filter((i) => i.kind === "phase").map((i) => i.id));
  const projects = asArray(state.board.projects);
  const known = new Set(projects.map((p) => p.id));
  const groups = [];
  const mk = (project) => {
    const mine = items.filter((i) => (project ? i.projectId === project.id : !i.projectId || !known.has(i.projectId)));
    const top = [];
    for (const i of mine) {
      if (i.kind === "phase") {
        const n = schedNode(i);
        n.kids = schedKids(i.id).map(schedNode).sort(schedCmp);
        top.push(n);
      } else if (!(i.parentId && phaseIds.has(i.parentId))) {
        top.push(schedNode(i));
      }
    }
    top.sort(schedCmp);
    return { project: project, top: top };
  };
  for (const p of projects) {
    const g = mk(p);
    if (g.top.length || isActive(p)) groups.push(g);
  }
  const none = mk(null);
  if (none.top.length) groups.push(none);
  return groups;
}

// 予定IDごとの目標リンク。工程は子の分もまとめる
function schedLinksFor(ids) {
  const set = new Set(ids);
  return schedLinks.filter((l) => set.has(l.scheduleId));
}
function schedLinkTitle(l) {
  return shortWeek(l.weekId) + (l.key ? " " + l.key : "") + ": " + (l.title || "");
}
// 終了日を過ぎても、結びついた目標のうち最新週のものが達成されていない
function schedIsOverrun(period, links) {
  if (!links.length || !period.end || period.end >= schedToday()) return false;
  let latest = links[0];
  for (const l of links) if (String(l.weekId) > String(latest.weekId)) latest = l;
  return latest.status !== "achieved";
}

function schedRequestLinks() { if (bridge) send({ type: "getScheduleLinks" }); }

/* 描画 */
function renderScheduleView() {
  schedCloseMenu();
  const ro = !!state.readOnly;
  const from = schedStart || schedDefaultStart();
  const days = SCHED_WEEKS * 7;
  const weekW = SCHED_DAY_W * 7;
  const today = schedToday();
  const gridW = 260 + days * SCHED_DAY_W;

  const wrap = el("div", "sched-wrap");
  const bar = el("div", "sched-bar");
  const mkBtn = (text, fn, cls) => {
    const b = el("button", "btn" + (cls ? " " + cls : ""));
    b.type = "button"; b.textContent = text; b.onclick = guard("スケジュール操作", fn);
    return b;
  };
  bar.appendChild(mkBtn("‹ 4週", () => { schedStart = schedAddDays(from, -28); render(); }));
  bar.appendChild(mkBtn("今日", () => { schedStart = null; render(); }));
  bar.appendChild(mkBtn("4週 ›", () => { schedStart = schedAddDays(from, 28); render(); }));
  const range = el("span", "s-range");
  range.textContent = from.replace(/-/g, "/") + " – " + schedAddDays(from, days - 1).replace(/-/g, "/");
  bar.appendChild(range);
  if (!ro) {
    const sp = el("span", "spacer"); bar.appendChild(sp);
    bar.appendChild(mkBtn("＋ 工程", () => openSchedDrawer(null, { kind: "phase" }), "primary"));
    bar.appendChild(mkBtn("＋ 作業", () => openSchedDrawer(null, { kind: "task" }), "primary"));
  }
  wrap.appendChild(bar);

  const grid = el("div", "sched");
  grid.style.width = gridW + "px";
  grid.style.setProperty("--dw", SCHED_DAY_W + "px");

  const mkRow = (cls) => {
    const row = el("div", "s-row" + (cls ? " " + cls : ""));
    const name = el("div", "s-name");
    const cells = el("div", "s-cells");
    cells.style.width = days * SCHED_DAY_W + "px";
    row.appendChild(name); row.appendChild(cells);
    return { row: row, name: name, cells: cells };
  };
  const todayIdx = schedDiff(from, today);
  const addToday = (cells) => {
    if (todayIdx < 0 || todayIdx >= days) return;
    const t = el("i", "s-today");
    t.style.left = todayIdx * SCHED_DAY_W + Math.floor(SCHED_DAY_W / 2) + "px";
    cells.appendChild(t);
  };

  /* 見出し3段（月／週番号／日） */
  const head = el("div", "s-head");
  const hMonth = mkRow("s-h1"), hWeek = mkRow("s-h2"), hDay = mkRow("s-h3");
  let segStart = 0;
  for (let i = 0; i <= days; i++) {
    const cur = i < days ? schedAddDays(from, i).slice(0, 7) : null;
    const prev = schedAddDays(from, segStart).slice(0, 7);
    if (i === days || cur !== prev) {
      const s = el("span", "s-mon");
      s.style.left = segStart * SCHED_DAY_W + "px";
      s.style.width = (i - segStart) * SCHED_DAY_W + "px";
      s.textContent = i - segStart >= 4 ? prev.slice(0, 4) + "/" + (+prev.slice(5)) + "月" : "";
      hMonth.cells.appendChild(s);
      segStart = i;
    }
  }
  for (let w = 0; w < SCHED_WEEKS; w++) {
    const s = el("span", "s-wk-h");
    s.style.left = w * weekW + "px"; s.style.width = weekW + "px";
    const id = schedWeekIdOf(schedAddDays(from, w * 7));
    s.textContent = shortWeek(id);
    s.title = id;
    hWeek.cells.appendChild(s);
  }
  for (let i = 0; i < days; i++) {
    const d = schedAddDays(from, i);
    const s = el("span", "s-day" + (i % 7 >= 5 ? " we" : "") + (d === today ? " today" : ""));
    s.textContent = String(+d.slice(8));
    hDay.cells.appendChild(s);
  }
  hMonth.name.textContent = "案件 / 工程 / 作業";
  head.appendChild(hMonth.row); head.appendChild(hWeek.row); head.appendChild(hDay.row);
  grid.appendChild(head);

  /* 本体 */
  const groups = schedTree();

  // 工程の期間から作業がはみ出した部分を危険色で示す（警告のみ）
  const putSpill = (cells, it) => {
    for (const sp of schedSpillOf(it)) {
      const s = schedDiff(from, sp.start), e = schedDiff(from, sp.end);
      if (e < 0 || s >= days) continue;
      const cs = Math.max(0, s), ce = Math.min(days - 1, e);
      const b = el("div", "s-spill");
      b.style.left = cs * SCHED_DAY_W + "px";
      b.style.width = (ce - cs + 1) * SCHED_DAY_W + "px";
      b.title = "作業がこの工程の期間外にあります（" + sp.start + " – " + sp.end + "）";
      cells.appendChild(b);
    }
  };
  const putBar = (cells, node, links) => {
    const it = node.item, p = node.period;
    if (!p.start) return;
    const s = schedDiff(from, p.start), e = schedDiff(from, p.end);
    if (e < 0 || s >= days) return;
    const cs = Math.max(0, s), ce = Math.min(days - 1, e);
    const b = el("div", "s-bar-" + it.kind);
    if (it.kind === "milestone") {
      b.style.left = s * SCHED_DAY_W + "px";
      b.textContent = "◆";
      b.title = (it.title || "") + "（" + p.start + "）";
      cells.appendChild(b);
      return;
    }
    b.style.left = cs * SCHED_DAY_W + "px";
    b.style.width = (ce - cs + 1) * SCHED_DAY_W + "px";
    b.title = (it.title || "") + "（" + p.start + " – " + p.end + "）";
    if (it.kind === "task") {
      const t = el("span", "s-bt"); t.textContent = it.title || ""; b.appendChild(t);
    }
    if (e <= days - 1 && schedIsOverrun(p, links)) {
      const o = el("i", "s-over");
      o.title = "終了日を過ぎても目標が持ち越し中です";
      b.appendChild(o);
    }
    cells.appendChild(b);
  };
  const putMarks = (cells, links) => {
    const byWeek = new Map();
    for (const l of links) {
      const mon = schedWeekMonday(l.weekId);
      if (!mon) continue;
      const idx = schedDiff(from, mon);
      if (idx + 7 <= 0 || idx >= days) continue;
      if (!byWeek.has(idx)) byWeek.set(idx, []);
      byWeek.get(idx).push(l);
    }
    byWeek.forEach((arr, idx) => {
      const band = el("div", "s-wk");
      band.style.left = idx * SCHED_DAY_W + "px";
      band.style.width = weekW + "px";
      for (const l of arr) {
        const m = el("span", "s-mark " + l.status);
        m.textContent = l.status === "achieved" ? "✓" : l.status === "carried" ? "↻" : "●";
        m.title = schedLinkTitle(l);
        band.appendChild(m);
      }
      cells.appendChild(band);
    });
  };
  const wireCells = (cells, item) => {
    if (ro) return;
    cells.classList.add("clickable");
    cells.onclick = guard("スケジュール", (e) => {
      const day = Math.floor((e.clientX - cells.getBoundingClientRect().left) / SCHED_DAY_W);
      if (day < 0 || day >= days) return;
      schedShowMenu(e, item, schedAddDays(from, day));
    });
  };
  const addBtn = (name, title, fn) => {
    if (ro) return;
    const b = el("button", "s-add"); b.type = "button"; b.textContent = "＋"; b.title = title;
    b.onclick = guard("スケジュール追加", (e) => { e.stopPropagation(); fn(); });
    name.appendChild(b);
  };
  const editable = (t, item) => {
    if (ro) return;
    t.classList.add("editable");
    t.onclick = guard("スケジュール編集", () => openSchedDrawer(item));
  };
  const itemRow = (node, level) => {
    const it = node.item;
    const r = mkRow(it.kind === "phase" ? "s-phase-row" : "");
    const links = schedLinksFor([it.id].concat(node.kids.map((k) => k.item.id)));
    r.name.style.paddingLeft = 8 + level * 16 + "px";
    if (it.kind === "phase") {
      const open = !schedCollapsed.has(it.id);
      const tg = el("button", "s-tg"); tg.type = "button"; tg.textContent = open ? "▾" : "▸";
      tg.title = open ? "たたむ" : "ひらく";
      tg.onclick = guard("工程の開閉", (e) => {
        e.stopPropagation();
        if (schedCollapsed.has(it.id)) schedCollapsed.delete(it.id); else schedCollapsed.add(it.id);
        schedSaveCollapsed(); render();
      });
      r.name.appendChild(tg);
      const t = el("span", "s-title strong");
      t.textContent = it.title || "（無題）"; t.title = t.textContent;
      editable(t, it);
      r.name.appendChild(t);
      const cnt = el("span", "s-cnt"); cnt.textContent = String(node.kids.length); r.name.appendChild(cnt);
      addBtn(r.name, "この工程に作業を追加", () => openSchedDrawer(null, { kind: "task", projectId: it.projectId || null, parentId: it.id, start: node.period.start }));
    } else {
      const t = el("span", "s-title");
      t.textContent = (it.kind === "milestone" ? "◆ " : "") + (it.title || "（無題）"); t.title = t.textContent;
      editable(t, it);
      r.name.appendChild(t);
      const asg = asArray(it.assignees).map(memberById).filter(Boolean);
      if (asg.length) {
        const w = el("span", "s-asg");
        for (const m of asg.slice(0, 3)) w.appendChild(avatar(m));
        r.name.appendChild(w);
      }
    }
    putMarks(r.cells, links);
    putSpill(r.cells, it);
    putBar(r.cells, node, links);
    addToday(r.cells);
    wireCells(r.cells, it);
    return r.row;
  };

  for (const g of groups) {
    const r = mkRow("s-proj-row");
    const nm = el("span", "s-title strong");
    nm.textContent = g.project ? g.project.name + (isActive(g.project) ? "" : "（休止中）") : "案件なし";
    r.name.appendChild(nm);
    if (g.project) addBtn(r.name, "この案件に工程を追加", () => openSchedDrawer(null, { kind: "phase", projectId: g.project.id }));
    addToday(r.cells);
    grid.appendChild(r.row);
    for (const n of g.top) {
      grid.appendChild(itemRow(n, 1));
      if (n.item.kind === "phase" && !schedCollapsed.has(n.item.id)) {
        for (const k of n.kids) grid.appendChild(itemRow(k, 2));
      }
    }
  }
  wrap.appendChild(grid);
  return wrap;
}

/* 日クリックのメニュー */
function schedCloseMenu() {
  if (schedMenuEl) { schedMenuEl.remove(); schedMenuEl = null; }
}
function schedShowMenu(ev, item, dateISO) {
  schedCloseMenu();
  const weekId = schedWeekIdOf(dateISO);
  const m = el("div", "s-menu");
  const b1 = el("button"); b1.type = "button"; b1.textContent = shortWeek(weekId) + " の目標にする";
  b1.onclick = guard("目標にする", () => { schedCloseMenu(); schedMakeGoal(item, weekId); });
  const b2 = el("button"); b2.type = "button"; b2.textContent = "編集";
  b2.onclick = guard("スケジュール編集", () => { schedCloseMenu(); openSchedDrawer(item); });
  m.appendChild(b1); m.appendChild(b2);
  m.style.left = Math.max(4, Math.min(ev.clientX, window.innerWidth - 170)) + "px";
  m.style.top = Math.max(4, Math.min(ev.clientY + 4, window.innerHeight - 80)) + "px";
  document.body.appendChild(m);
  schedMenuEl = m;
}
document.addEventListener("mousedown", (e) => {
  if (schedMenuEl && !schedMenuEl.contains(e.target)) schedCloseMenu();
}, true);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") schedCloseMenu(); });
window.addEventListener("resize", schedCloseMenu);
document.addEventListener("scroll", schedCloseMenu, true);

/* 週の目標への落とし込み */
function schedMakeGoal(item, weekId) {
  if (state.readOnly) { toast("共有フォルダに書き込めないため、閲覧のみです"); return; }
  const closed = asArray(state.weeks).some((w) => w.id === weekId && w.closed) || (state.week.id === weekId && state.week.closed);
  if (closed) { toast(shortWeek(weekId) + " は締め済みのため、目標を作れません"); return; }
  const parent = item.parentId ? schedById(item.parentId) : null;
  const def = parent && item.kind === "task" ? (parent.title || "") + "：" + (item.title || "") : (item.title || "");
  const title = prompt(shortWeek(weekId) + " の目標にします。目標名を確認してください。", def);
  if (title === null) return;
  const t = title.trim();
  if (!t) { toast("目標名を入力してください"); return; }
  if (!bridge) { toast("プレビューでは保存されません"); return; }
  send({ type: "createGoal", weekId: weekId, title: t, scheduleId: item.id, viewWeekId: state.week.id });
  schedRequestLinks();
}

/* 予定の編集ドロワー */
function wireScheduleDrawer() {
  document.getElementById("sdClose").onclick = closeSchedDrawer;
  document.getElementById("sdCancel").onclick = closeSchedDrawer;
  document.getElementById("sdSave").onclick = guard("予定の保存", saveSchedDrawer);
  document.getElementById("sdDelete").onclick = guard("予定の削除", deleteSchedDrawer);
  document.getElementById("sdKind").onchange = () => refreshSchedForm();
  document.getElementById("sdProject").onchange = () => refreshSchedForm();
}

function openSchedDrawer(item, preset) {
  if (state.readOnly) { toast("共有フォルダに書き込めないため、閲覧のみです"); return; }
  schedEditingId = item ? item.id : null;
  const p = preset || {};
  const t = item || {
    kind: p.kind || "task", projectId: p.projectId || null, parentId: p.parentId || null,
    title: "", start: p.start || schedToday(), end: p.start || schedToday(), assignees: [], history: [],
  };
  const hasKids = !!item && item.kind === "phase" && schedKids(item.id).length > 0;
  document.getElementById("sdTitleH").textContent = item ? "予定を編集" : "予定を追加";
  document.getElementById("sdSave").textContent = item ? "保存" : "作成";
  document.getElementById("sdDelete").hidden = !item;
  fillSelect("sdKind", SCHED_KINDS, t.kind);
  document.getElementById("sdKind").disabled = hasKids;   // 子を持つ工程は種類を変えられない
  document.getElementById("sdTitle").value = t.title || "";

  const projOpts = [{ value: "", label: "（案件なし）" }];
  for (const pr of asArray(state.board.projects)) {
    if (!isActive(pr) && pr.id !== t.projectId) continue;
    projOpts.push({ value: pr.id, label: pr.name + (isActive(pr) ? "" : "（休止中）") });
  }
  fillSelect("sdProject", projOpts, t.projectId || "");
  document.getElementById("sdParent").replaceChildren();
  document.getElementById("sdParent").dataset.want = t.parentId || "";
  document.getElementById("sdStart").value = t.start || "";
  document.getElementById("sdEnd").value = t.end || t.start || "";

  const picker = document.getElementById("sdAssignees");
  const selected = new Set(asArray(t.assignees));
  const pickable = asArray(state.board.members).filter((m) => isActive(m) || selected.has(m.id));
  picker.replaceChildren(...pickable.map((m) => {
    const b = el("button", "pick" + (selected.has(m.id) ? " on" : ""));
    b.type = "button"; b.dataset.memberId = m.id;
    b.appendChild(avatar(m)); b.appendChild(document.createTextNode(m.name));
    b.onclick = () => b.classList.toggle("on");
    return b;
  }));

  const hist = asArray(t.history);
  document.getElementById("sdHistWrap").hidden = hist.length === 0;
  document.getElementById("sdHistory").textContent = hist.join("\n");

  refreshSchedForm();
  document.getElementById("scrim").hidden = false;
  document.getElementById("schedDrawer").hidden = false;
  document.getElementById("sdTitle").focus();
}

// 種類・案件に応じて、親工程の選択肢と日付欄の状態を整える
function refreshSchedForm() {
  const kind = document.getElementById("sdKind").value;
  const projectId = document.getElementById("sdProject").value || null;
  const parentSel = document.getElementById("sdParent");
  const want = parentSel.value || parentSel.dataset.want || "";
  const opts = [{ value: "", label: "なし（案件の直下）" }];
  for (const ph of schedItems().filter((i) => i.kind === "phase" && i.id !== schedEditingId && (i.projectId || null) === projectId)) {
    opts.push({ value: ph.id, label: ph.title || "（無題）" });
  }
  fillSelect("sdParent", opts, opts.some((o) => o.value === want) ? want : "");
  parentSel.dataset.want = "";
  document.getElementById("sdParentWrap").hidden = kind === "phase";
  document.getElementById("sdEndWrap").hidden = kind === "milestone";
  document.getElementById("sdStartK").textContent = kind === "milestone" ? "日付" : "開始日";
}

function closeSchedDrawer() {
  document.getElementById("scrim").hidden = true;
  document.getElementById("schedDrawer").hidden = true;
  schedEditingId = null;
}

function saveSchedDrawer() {
  const kind = document.getElementById("sdKind").value;
  const title = document.getElementById("sdTitle").value.trim();
  if (!title) { toast("タイトルを入力してください"); document.getElementById("sdTitle").focus(); return; }
  const item = schedEditingId ? schedById(schedEditingId) : null;
  const start = document.getElementById("sdStart").value;
  const end = kind === "milestone" ? start : document.getElementById("sdEnd").value;
  if (!start || !end) { toast("日付を入力してください"); return; }
  if (end < start) { toast("終了日は開始日以降にしてください"); return; }
  const parentId = kind === "phase" ? null : (document.getElementById("sdParent").value || null);
  const parent = parentId ? schedById(parentId) : null;
  const fields = {
    kind: kind, title: title,
    projectId: parent ? (parent.projectId || null) : (document.getElementById("sdProject").value || null),
    parentId: parentId,
    assignees: Array.from(document.querySelectorAll("#sdAssignees .pick.on")).map((b) => b.dataset.memberId),
    start: start, end: end,
  };
  if (!bridge) { toast("プレビューでは保存されません"); closeSchedDrawer(); return; }
  if (item) send({ type: "updateScheduleItem", itemId: item.id, fields: fields });
  else send({ type: "createScheduleItem", fields: fields });
  closeSchedDrawer();
}

function deleteSchedDrawer() {
  const item = schedEditingId ? schedById(schedEditingId) : null;
  if (!item) return;
  const n = item.kind === "phase" ? schedKids(item.id).length : 0;
  const msg = "「" + (item.title || "この予定") + "」を削除します。"
    + (n ? "\n工程の中の作業・マイルストーン " + n + " 件も一緒に削除されます。" : "") + "\nよろしいですか？";
  if (!confirm(msg)) return;
  if (!bridge) { toast("プレビューでは削除されません"); closeSchedDrawer(); return; }
  send({ type: "deleteScheduleItem", itemId: item.id });
  closeSchedDrawer();
}

/* ---------------- 小物 ---------------- */
function el(tag, cls) { const n = document.createElement(tag); if (cls) n.className = cls; return n; }
function chip(text, extra) { const c = el("span", "chip" + (extra ? " " + extra : "")); c.textContent = text; return c; }
function chipTag(key, isBg) { const c = el("span", "gtag" + (isBg ? " bg" : "")); c.textContent = key; return c; }
function avatar(m) { const a = el("span", "av"); a.style.background = m.color; a.textContent = m.initial; a.title = m.name; return a; }
function placeholder(text) { const p = el("div", "placeholder"); p.textContent = text; return p; }
function memberById(id) { return asArray(state.board.members).find((m) => m.id === id); }
function statusLabel(k) { const s = STATUSES.find((x) => x.key === k); return s ? s.label : k; }
function statusJa(s) { return { running: "進行中", achieved: "達成", carried: "持ち越し" }[s] || s; }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
// "2026-W30" → "W30"（年をまたいでも正しく短縮する）
function shortWeek(id) { const i = String(id).indexOf("-W"); return i < 0 ? String(id) : String(id).slice(i + 1); }

function fmtRange(r) { return r.start.slice(5).replace("-", "/") + " – " + r.end.slice(5).replace("-", "/"); }
function fmtDue(t) {
  if (t.status === "done") return t.due ? t.due.slice(5).replace("-", "/") + " 完了" : "完了";
  if (!t.due) return "";
  const d = t.due.slice(5).replace("-", "/");
  return isOverdue(t) ? d + " 期限" : d;
}
function isOverdue(t) {
  if (t.status === "done" || !t.due) return false;
  return t.due <= (state.today || todayISO());
}
function todayISO() { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function daysLeftText(endISO) {
  const today = state.today || todayISO();
  if (today > endISO) return "終了";
  const a = new Date(today + "T00:00:00"), b = new Date(endISO + "T00:00:00");
  const days = Math.round((b - a) / 86400000);
  return days === 0 ? "残り 本日" : "残り " + days + " 日";
}

let toastTimer = null;
function toast(text) {
  const t = document.getElementById("toast");
  t.textContent = text; t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}
function setSync(connected, text) {
  const s = document.getElementById("sync");
  s.classList.toggle("off", !connected);
  document.getElementById("syncText").textContent = text || (connected ? "同期済" : "切断");
}

/* ---------------- スタンドアロン用デモデータ ---------------- */
function buildStandaloneState() {
  const board = {
    boardName: "開発1課（プレビュー）",
    members: [
      { id: "m1", name: "田中", initial: "田", color: "#2F6E86" },
      { id: "m2", name: "佐藤", initial: "佐", color: "#8A5A2B" },
      { id: "m3", name: "鈴木", initial: "鈴", color: "#5B6E33" },
      { id: "m4", name: "高橋", initial: "高", color: "#7A4A6E" },
      { id: "m5", name: "中村", initial: "中", color: "#43607F" },
      { id: "m6", name: "小林", initial: "小", color: "#8C4A45" },
    ],
    continuingGoals: [
      { id: "cg1", key: "S", title: "社内手順書の整備", active: true, totalDone: 14 },
      { id: "cg2", key: "T", title: "検証環境の安定化", active: true, totalDone: 8 },
    ],
    projects: [
      { id: "p-a", name: "A社更新", active: true },
      { id: "p-b", name: "B社案件", active: true },
      { id: "p-in", name: "社内", active: true },
    ],
    notes: [
      { id: "n1", text: "月末の請求処理は27日までに完了させること。締め日が変わりました。", author: "田中", createdAt: "2026-07-21", pinned: true },
      { id: "n2", text: "定例会は毎週水曜15:00〜（会議室B）", author: "佐藤", createdAt: "2026-07-13", pinned: false },
      { id: "n3", text: "B社の窓口が8月から山田さんに変わります", author: "鈴木", createdAt: "2026-07-22", pinned: false },
    ],
  };
  const week = {
    id: "2026-W30", range: { start: "2026-07-20", end: "2026-07-26" }, closed: false,
    goals: [
      { id: "gA", key: "A", title: "B社 要件定義を確定させる", status: "running", carriedFrom: null, carryStreak: 0 },
      { id: "gB", key: "B", title: "A社 更新契約の書類を揃える", status: "running", carriedFrom: "2026-W29", carryStreak: 1 },
      { id: "gC", key: "C", title: "月次締め作業を金曜までに終わらせる", status: "running", carriedFrom: null, carryStreak: 0 },
    ],
    tasks: [
      { id: "t1", title: "帳票要件の残論点を洗い出す", status: "todo", goalId: "gA", continuingGoalId: null, assignees: ["m1"], due: "2026-07-24", priority: "high", carriedFrom: null },
      { id: "t2", title: "保守契約書のドラフト作成", status: "todo", goalId: "gB", continuingGoalId: null, assignees: ["m1"], due: "2026-07-24", priority: "normal", carriedFrom: "2026-W29" },
      { id: "t3", title: "共有フォルダの権限棚卸し", status: "todo", goalId: null, continuingGoalId: "cg1", assignees: ["m5"], due: "2026-07-24", priority: "normal", carriedFrom: null },
      { id: "t4", title: "備品発注のとりまとめ", status: "todo", goalId: null, continuingGoalId: null, assignees: ["m6"], due: "2026-07-25", priority: "normal", carriedFrom: null },
      { id: "t5", title: "要件ヒアリング議事録のまとめ", status: "doing", goalId: "gA", continuingGoalId: null, assignees: ["m2"], due: "2026-07-24", priority: "high", carriedFrom: null },
      { id: "t6", title: "現地調査の日程調整", status: "doing", goalId: "gB", continuingGoalId: null, assignees: ["m6"], due: "2026-07-24", priority: "normal", carriedFrom: null },
      { id: "t7", title: "検証環境の再構築", status: "doing", goalId: null, continuingGoalId: "cg2", assignees: ["m2"], due: "2026-07-25", priority: "normal", carriedFrom: null },
      { id: "t8", title: "構成図 v2 の内容確認", status: "review", goalId: "gA", continuingGoalId: null, assignees: ["m3", "m1"], due: "2026-07-24", priority: "normal", carriedFrom: null },
      { id: "t9", title: "経費精算フローの手順書", status: "review", goalId: null, continuingGoalId: "cg1", assignees: ["m5", "m4"], due: "2026-07-24", priority: "normal", carriedFrom: null },
      { id: "t10", title: "7月度 勤怠の締め確認", status: "done", goalId: "gC", continuingGoalId: null, assignees: ["m4"], due: "2026-07-23", priority: "normal", carriedFrom: null },
      { id: "t11", title: "前年度実績データの抽出", status: "done", goalId: "gA", continuingGoalId: null, assignees: ["m2"], due: "2026-07-22", priority: "normal", carriedFrom: null },
      { id: "t12", title: "請求データの突合", status: "done", goalId: "gC", continuingGoalId: null, assignees: ["m3"], due: "2026-07-22", priority: "normal", carriedFrom: null },
    ],
  };
  const schedule = { items: [
    { id: "sc-1", kind: "phase", projectId: "p-a", parentId: null, title: "設計工程", start: "2026-07-13", end: "2026-07-31", assignees: [], history: [] },
    { id: "sc-2", kind: "task", projectId: "p-a", parentId: "sc-1", title: "画面設計", start: "2026-07-13", end: "2026-07-24", assignees: ["m1"], history: [] },
    { id: "sc-3", kind: "task", projectId: "p-a", parentId: "sc-1", title: "帳票設計", start: "2026-07-20", end: "2026-08-07", assignees: ["m2"], history: [] },
    { id: "sc-4", kind: "milestone", projectId: "p-a", parentId: null, title: "契約更新日", start: "2026-08-14", end: "2026-08-14", assignees: [], history: [] },
    { id: "sc-5", kind: "task", projectId: "p-b", parentId: null, title: "要件ヒアリング", start: "2026-07-15", end: "2026-07-22", assignees: ["m3"], history: [] },
  ] };
  return { type: "state", board, week, weeks: [{ id: "2026-W30" }], schedule, view: "board", today: "2026-07-24", connected: true };
}
