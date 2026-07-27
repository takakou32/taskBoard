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
      if (!sameWeek) filterGoalId = null;
      render();
      break;
    }
    case "retro":
      if (state) { state.retro = msg.weeks || []; render(); }
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
  document.getElementById("btnNewTask").onclick = () => openDrawer(null);
  document.getElementById("drawerClose").onclick = closeDrawer;
  document.getElementById("btnCancel").onclick = closeDrawer;
  // 背景の暗幕は3つのドロワーで共用。開いているものを閉じる。
  document.getElementById("scrim").onclick = () => {
    if (!document.getElementById("drawer").hidden) closeDrawer();
    else if (!document.getElementById("goalDrawer").hidden) closeGoalDrawer();
    else if (!document.getElementById("contDrawer").hidden) closeContDrawer();
    else if (!document.getElementById("setDrawer").hidden) closeSettings();
  };
  document.getElementById("btnSave").onclick = saveDrawer;
  document.getElementById("btnDelete").onclick = deleteDrawer;
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

  document.getElementById("btnCloseWeek").onclick = openCloseDialog;
  document.getElementById("closeCancel").onclick = closeCloseDialog;
  document.getElementById("closeScrim").onclick = closeCloseDialog;
  document.getElementById("closeConfirm").onclick = confirmClose;
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!document.getElementById("drawer").hidden) closeDrawer();
    else if (!document.getElementById("goalDrawer").hidden) closeGoalDrawer();
    else if (!document.getElementById("contDrawer").hidden) closeContDrawer();
    else if (!document.getElementById("setDrawer").hidden) closeSettings();
    else if (!document.getElementById("closeModal").hidden) closeCloseDialog();
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
function render() {
  if (!state) return;
  renderToolbarState();
  const root = document.getElementById("viewRoot");
  if (state.view === "assignee") root.replaceChildren(renderAssigneeView());
  else if (state.view === "retro") root.replaceChildren(renderRetroView());
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

  // 締め忘れバナー
  if (state.needsClose) {
    banner.classList.add("show");
    document.getElementById("bannerText").textContent = w.id + " が未締めです。達成／持ち越しを判定してください。";
    const act = document.getElementById("bannerAction");
    act.textContent = "週を締める";
    act.onclick = openCloseDialog;
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

function renderGoalLane() {
  const lane = el("aside", "goal-lane");
  const title = el("div", "lane-title");
  title.innerHTML = '<span class="t">今週の目標</span><span class="s">' + esc(shortWeek(state.week.id)) + "</span>";
  lane.appendChild(title);

  const weekGoals = state.week.goals || [];
  const tasks = state.week.tasks || [];
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

  const contGoals = (state.board.continuingGoals || []).filter(isActive);
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

  const row = el("div", "row");
  const goalTag = goalTagFor(t);
  if (goalTag) row.appendChild(goalTag);
  if (t.carriedFrom) row.appendChild(chip("↻ " + shortWeek(t.carriedFrom)));
  if (t.priority === "high") row.appendChild(chip("高", "pri-h"));
  if (!goalTag && !t.carriedFrom && t.priority !== "high") row.appendChild(chip("紐づけなし"));
  card.appendChild(row);

  const title = el("div", "title");
  title.textContent = t.title;
  card.appendChild(title);

  if (lockedBy) {
    const lb = el("div", "lockbar");
    lb.textContent = "🔒 " + lockedBy + " が編集中";
    card.appendChild(lb);
  }

  const meta = el("div", "meta");
  const due = el("span", "due" + (isOverdue(t) ? " over" : ""));
  due.textContent = fmtDue(t);
  meta.appendChild(due);
  meta.appendChild(el("span", "sp"));
  for (const id of (t.assignees || [])) {
    const m = memberById(id);
    if (m) meta.appendChild(avatar(m));
  }
  card.appendChild(meta);

  card.onclick = () => openTask(t);
  return card;
}

function goalTagFor(t) {
  if (t.goalId) {
    const g = (state.week.goals || []).find((x) => x.id === t.goalId);
    if (g) return chipTag(g.key, false);
  }
  if (t.continuingGoalId) {
    const c = (state.board.continuingGoals || []).find((x) => x.id === t.continuingGoalId);
    if (c) return chipTag(c.key, true);
  }
  return null;
}

/* ---------------- 担当者スイムレーン ---------------- */
function renderAssigneeView() {
  const wrap = el("div", "lanes");
  const tasks = visibleTasks();
  // 有効なメンバー＋休止中でもこの週にタスクを持っている人（作業を隠さない）
  const members = (state.board.members || []).filter(
    (m) => isActive(m) || tasks.some((t) => (t.assignees || []).includes(m.id))
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
    const mine = tasks.filter((t) => (t.assignees || []).includes(m.id));
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
  const none = tasks.filter((t) => !(t.assignees || []).length);
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
  const t = (state.week.tasks || []).find((x) => x.id === taskId);
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
  const all = state.week.tasks || [];
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

function visibleTasks() {
  let tasks = state.week.tasks || [];
  if (filterGoalId === "__unlinked__") tasks = tasks.filter((t) => !t.goalId && !t.continuingGoalId);
  else if (filterGoalId) tasks = tasks.filter((t) => t.goalId === filterGoalId || t.continuingGoalId === filterGoalId);
  if (searchText) {
    const q = searchText.toLowerCase();
    tasks = tasks.filter((t) => t.title.toLowerCase().includes(q));
  }
  return tasks;
}

/* ---------------- 詳細ドロワー（新規作成 / 編集 / 削除） ---------------- */
let editingId = null;   // null = 新規作成モード

function openTask(t) { openDrawer(t); }

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
    projectId: null, description: "", history: [],
  };

  document.getElementById("drawerTitle").textContent = task ? "タスクを編集" : "新規タスク";
  document.getElementById("btnSave").textContent = task ? "保存" : "作成";
  document.getElementById("btnDelete").hidden = !task;

  document.getElementById("fTitle").value = t.title || "";
  document.getElementById("fDesc").value = t.description || "";
  document.getElementById("fDue").value = t.due || "";
  document.getElementById("fPriority").value = t.priority || "normal";

  fillSelect("fStatus", STATUSES.map((s) => ({ value: s.key, label: s.label })), t.status);

  // 目標: 週の大目標 → 継続目標 → 紐づけなし
  const goalOpts = [{ value: "", label: "（紐づけなし）" }];
  for (const g of state.week.goals || []) goalOpts.push({ value: "g:" + g.id, label: g.key + " ・ " + g.title });
  for (const c of (state.board.continuingGoals || []).filter((x) => isActive(x) || x.id === t.continuingGoalId)) {
    goalOpts.push({ value: "c:" + c.id, label: c.key + " ・ " + c.title + "（継続）" });
  }
  const goalVal = t.goalId ? "g:" + t.goalId : t.continuingGoalId ? "c:" + t.continuingGoalId : "";
  fillSelect("fGoal", goalOpts, goalVal);

  // 休止中の案件は選択肢から外すが、既に紐づいているものは残す（勝手に外さない）
  const projOpts = [{ value: "", label: "（なし）" }];
  for (const p of (state.board.projects || [])) {
    if (!isActive(p) && p.id !== t.projectId) continue;
    projOpts.push({ value: p.id, label: p.name + (isActive(p) ? "" : "（休止中）") });
  }
  fillSelect("fProject", projOpts, t.projectId || "");

  // 担当者ピッカー。休止中でも既に担当しているなら表示する。
  const picker = document.getElementById("fAssignees");
  const selected = new Set(t.assignees || []);
  const pickable = (state.board.members || []).filter((m) => isActive(m) || selected.has(m.id));
  picker.replaceChildren(...pickable.map((m) => {
    const b = el("button", "pick" + (selected.has(m.id) ? " on" : ""));
    b.type = "button";
    b.dataset.memberId = m.id;
    b.appendChild(avatar(m));
    b.appendChild(document.createTextNode(m.name));
    b.onclick = () => b.classList.toggle("on");
    return b;
  }));

  // 履歴
  const histWrap = document.getElementById("histWrap");
  const hist = t.history || [];
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
  };
}

function saveDrawer() {
  const fields = collectForm();
  if (!fields.title) { toast("タイトルを入力してください"); document.getElementById("fTitle").focus(); return; }
  if (!bridge) { toast("プレビューでは保存されません"); closeDrawer(); return; }
  if (editingId) send({ type: "updateTask", weekId: state.week.id, taskId: editingId, fields });
  else send({ type: "createTask", weekId: state.week.id, fields });
  closeDrawer();
}

function deleteDrawer() {
  if (!editingId) return;
  const t = (state.week.tasks || []).find((x) => x.id === editingId);
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

  const linked = (state.week.tasks || []).filter((t) => t.goalId === g.id);
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
  const g = (state.week.goals || []).find((x) => x.id === editingGoalId);
  const n = (state.week.tasks || []).filter((t) => t.goalId === editingGoalId).length;
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
  const goals = state.board.continuingGoals || [];
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
  const members = state.board.members || [];
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
  const tasks = state.week.tasks || [];
  const n = tasks.filter((t) => (t.assignees || []).includes(memberId)).length;
  return state.week.closed ? { unclosed: 0, closedOnly: n } : { unclosed: n, closedOnly: 0 };
}

function renderProjectList() {
  const list = document.getElementById("projectList");
  const projects = state.board.projects || [];
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
      const n = (state.week.tasks || []).filter((t) => t.projectId === p.id).length;
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

// active が未設定の既存データは「有効」とみなす
function isActive(x) { return !x || x.active !== false; }
function activeMembers() { return (state.board.members || []).filter(isActive); }
function activeProjects() { return (state.board.projects || []).filter(isActive); }

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

/* ---------------- 小物 ---------------- */
function el(tag, cls) { const n = document.createElement(tag); if (cls) n.className = cls; return n; }
function chip(text, extra) { const c = el("span", "chip" + (extra ? " " + extra : "")); c.textContent = text; return c; }
function chipTag(key, isBg) { const c = el("span", "gtag" + (isBg ? " bg" : "")); c.textContent = key; return c; }
function avatar(m) { const a = el("span", "av"); a.style.background = m.color; a.textContent = m.initial; a.title = m.name; return a; }
function placeholder(text) { const p = el("div", "placeholder"); p.textContent = text; return p; }
function memberById(id) { return (state.board.members || []).find((m) => m.id === id); }
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
  return { type: "state", board, week, weeks: [{ id: "2026-W30" }], view: "board", today: "2026-07-24", connected: true };
}
