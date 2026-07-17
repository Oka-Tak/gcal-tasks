// ==UserScript==
// @name         Kairos 課題取り込み
// @namespace    kairos
// @version      1.4.0
// @description  静大 学務システム: 課題一覧の一括取り込み + 課題詳細・小テスト/アンケートの設問（プルダウン選択肢含む）をKairosへ（AIが課題内容を理解できるようになる）
// @match        https://gakujo.shizuoka.ac.jp/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      zundamon-ubuntu-alc6.tail7507d4.ts.net
// ==/UserScript==

(function () {
  "use strict";
  const KAIROS = "https://zundamon-ubuntu-alc6.tail7507d4.ts.net:10000";
  const TOKEN = "__KAIROS_WIDGET_TOKEN__";

  // gakujoのCSP(connect-src 'self')を迂回するため GM_xmlhttpRequest を使う
  const post = (path, payload) => new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: "POST",
      url: KAIROS + path,
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify(payload),
      timeout: 60000,
      onload: (res) => {
        try { resolve({ status: res.status, body: JSON.parse(res.responseText) }); }
        catch (e) { reject(new Error("bad response: " + res.responseText.slice(0, 120))); }
      },
      onerror: () => reject(new Error("network error (TailscaleがONか確認)")),
      ontimeout: () => reject(new Error("timeout")),
    });
  });

  const btnStyle = {
    display: "block", margin: "12px 0", padding: "10px 18px", fontSize: "15px",
    fontWeight: "700", color: "#222", background: "#f5c518", border: "none",
    borderRadius: "8px", cursor: "pointer", boxShadow: "0 1px 4px rgba(0,0,0,.3)",
  };

  /* ============================ 課題一覧（従来機能） ============================ */

  const parseDeadline = (text) => {
    const m = (text || "").match(/～\s*([\d]{4})\/([\d]{1,2})\/([\d]{1,2})\s+([\d]{1,2}):([\d]{2})/);
    if (!m) return { due: null, dueTime: null };
    const [, y, mo, d, h, mi] = m;
    const p = (n) => String(n).padStart(2, "0");
    return { due: `${y}-${p(mo)}-${p(d)}`, dueTime: `${p(h)}:${p(mi)}` };
  };

  const collect = () => {
    const table = document.getElementById("dataTable01");
    if (!table) return [];
    const cell = (row, label) => row.querySelector(`td[data-label*="${label}"]`);
    return Array.from(table.querySelectorAll("tbody tr")).map((row) => {
      const course = (cell(row, "講義名")?.innerHTML || "").split("<br>")[0].replace(/<[^>]+>/g, "").trim();
      const title = cell(row, "タイトル")?.textContent?.trim() || "";
      const kind = cell(row, "提出物種別")?.textContent?.trim() || "";
      const status = cell(row, "提出状況")?.textContent?.trim() || "";
      const term = cell(row, "提出期間")?.textContent?.trim() || "";
      const { due, dueTime } = parseDeadline(term);
      return { course, title, kind, due, dueTime, submitted: status.includes("提出済") };
    }).filter((a) => a.title);
  };

  const showAllThen = (cb) => {
    const sel = document.querySelector('select[name="dataTable01_length"]');
    const tbody = document.querySelector("#dataTable01 tbody");
    if (!sel || sel.value === "-1" || !tbody) return cb();
    const obs = new MutationObserver(() => { obs.disconnect(); setTimeout(cb, 300); });
    obs.observe(tbody, { childList: true });
    sel.value = "-1";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const sendList = (btn) => {
    showAllThen(async () => {
      const assignments = collect();
      if (!assignments.length) { alert("課題が見つかりません（課題・アンケートリストで実行してください）"); return; }
      btn.textContent = `送信中… (${assignments.length}件)`;
      try {
        const { status, body } = await post("/api/import/gakujo", { token: TOKEN, assignments });
        if (status !== 200) { alert("失敗: " + (body.detail || body.error || status)); }
        else { alert(`Kairosに取り込みました\n新規 ${body.created} / 既存スキップ ${body.skipped} / 締切不明 ${body.noDue} / 済・過去 ${body.pastOrDone}`); }
      } catch (e) { alert("エラー: " + e.message); }
      btn.textContent = "📅 Kairosに取り込む";
    });
  };

  /* ==================== 課題詳細ページ（v1.3.0: 設問文の取り込み） ==================== */
  // 「課題・アンケート提出」画面（SC_14002B00_03）の設問本文・締切・講義名を
  // Kairosへ送る → 授業資料フォルダに md 保存 → RAG登録 & タスクのメモに反映。
  // AIチャット/タスク推定が課題の中身を理解できるようになる。

  const parseJpDeadline = (text) => {
    // 例: 2026年08月02日 23時55分
    const m = (text || "").match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2})時(\d{1,2})分/);
    if (!m) return { due: null, dueTime: null };
    const p = (n) => String(n).padStart(2, "0");
    return { due: `${m[1]}-${p(m[2])}-${p(m[3])}`, dueTime: `${p(m[4])}:${p(m[5])}` };
  };

  // 小テスト/アンケートの設問収集: 「第N問」ラベル（全角数字対応）を起点に、
  // 後続のプルダウン(select)・ラジオ・チェック・自由記述(textarea)を対応付ける。
  const collectQuestions = () => {
    const questions = [];
    let cur = null;
    const push = () => { if (cur && (cur.text || cur.options.length)) questions.push(cur); };
    for (const el of document.body.querySelectorAll("*")) {
      const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3)
        .map((n) => n.textContent).join(" ").replace(/\s+/g, " ").trim().normalize("NFKC");
      const m = own.match(/^第\s*(\d+)\s*問/);
      if (m) { push(); cur = { no: +m[1], text: "", options: [], kind: "" }; continue; }
      if (!cur) continue;
      if (el.tagName === "SELECT") {
        cur.kind = cur.kind || "プルダウン";
        for (const o of el.options) { const t = o.textContent.trim(); if (t && !cur.options.includes(t)) cur.options.push(t); }
      } else if (el.tagName === "TEXTAREA") {
        cur.kind = cur.kind || "自由記述";
      } else if (el.tagName === "INPUT" && (el.type === "radio" || el.type === "checkbox")) {
        cur.kind = cur.kind || (el.type === "radio" ? "単一選択" : "複数選択");
        const lbl = (el.closest("label")?.textContent || (el.id && document.querySelector(`label[for="${el.id}"]`)?.textContent) || "").trim();
        if (lbl && !cur.options.includes(lbl)) cur.options.push(lbl);
      } else if (
        own.length > 3 && !/^(必須|任意)$/.test(own) &&
        el.tagName !== "OPTION" && !el.closest("select") &&
        !(el.closest("label") && el.closest("label").querySelector("input"))
      ) {
        cur.text = cur.text ? cur.text + "\n" + own : own;
      }
    }
    push();
    return questions;
  };

  const questionsToText = (qs) =>
    qs.map((q) => [
      `### 第${q.no}問${q.kind ? `（${q.kind}）` : ""}`,
      q.text,
      ...q.options.map((o) => `- ${o}`),
    ].filter(Boolean).join("\n")).join("\n\n");

  const collectDetail = () => {
    const title = document.querySelector(".question-heading-contents h2.c-heading")?.textContent?.trim();
    if (!title) return null;
    // 講義名: <dt>講義名：</dt><dd>AIシステムⅠ ｜ 狩野 芳伸</dd>
    let course = "";
    for (const dt of document.querySelectorAll("dt")) {
      if (dt.textContent.includes("講義名")) {
        course = (dt.nextElementSibling?.textContent || "").split("｜")[0].trim();
        break;
      }
    }
    let grading = "";
    for (const dt of document.querySelectorAll("dt")) {
      if (dt.textContent.includes("評価方法")) { grading = dt.nextElementSibling?.textContent?.trim() || ""; break; }
    }
    const { due, dueTime } = parseJpDeadline(document.querySelector(".deadline_box .date")?.textContent);
    // 設問本文: .c-contents-body 内の .text（複数あることがある）
    const desc = Array.from(document.querySelectorAll(".c-contents-body .text, .c-contents-body p.text"))
      .map((p) => p.innerText.trim())
      .filter((t) => t && !/^(受付中|受付終了|締め切り)/.test(t))
      .join("\n\n");
    // 小テスト/アンケートなら設問+選択肢も収集
    const qs = collectQuestions();
    const body = [desc, qs.length ? `## 設問\n\n${questionsToText(qs)}` : ""].filter(Boolean).join("\n\n");
    if (!body || body.length < 10) return null;
    return { course, title, body, due, dueTime, grading, url: location.href.split("?")[0] };
  };

  const sendDetail = async (btn) => {
    const detail = collectDetail();
    if (!detail) { alert("課題の本文が見つかりません（課題の詳細画面で実行してください）"); return; }
    btn.textContent = "送信中…";
    try {
      const { status, body } = await post("/api/import/gakujo", { token: TOKEN, detail });
      if (status !== 200) { alert("失敗: " + (body.detail || body.error || status)); }
      else {
        alert(`Kairosに取り込みました\n📁 ${body.savedTo ? body.savedTo.split("/").slice(-2).join("/") : "保存先なし"}\n📝 タスクのメモ反映: ${body.taskUpdated ? "あり" : "対応タスクなし"}\n（RAGへは30分以内に自動登録されます）`);
      }
    } catch (e) { alert("エラー: " + e.message); }
    btn.textContent = "📚 内容をKairosへ";
  };

  /* ================================ マウント ================================ */

  const mount = () => {
    // 一覧ページ
    if (document.title === "課題・アンケートリスト" && !document.getElementById("kairos-import-btn")) {
      const table = document.getElementById("dataTable01");
      if (table) {
        const btn = document.createElement("button");
        btn.id = "kairos-import-btn";
        btn.type = "button";
        btn.textContent = "📅 Kairosに取り込む";
        Object.assign(btn.style, btnStyle);
        btn.addEventListener("click", () => sendList(btn));
        table.parentNode.insertBefore(btn, table);
      }
    }
    // 詳細ページ（課題・アンケート提出）
    if (!document.getElementById("kairos-detail-btn")) {
      const heading = document.querySelector(".question-heading-contents h2.c-heading");
      const bodyEl = document.querySelector(".c-contents-body") || document.querySelector("form select, form textarea, form input[type=radio]")?.closest("form") || null;
      if (heading && bodyEl) {
        const btn = document.createElement("button");
        btn.id = "kairos-detail-btn";
        btn.type = "button";
        btn.textContent = "📚 内容をKairosへ";
        Object.assign(btn.style, btnStyle, { margin: "10px 0" });
        btn.title = "設問文・締切をKairosへ送る — 授業フォルダにmd保存され、AIチャット/タスク推定が課題内容を理解できるようになります";
        btn.addEventListener("click", () => sendDetail(btn));
        bodyEl.parentNode.insertBefore(btn, bodyEl);
      }
    }
  };

  window.addEventListener("load", () => setTimeout(mount, 1200));
  new MutationObserver(mount).observe(document.body, { childList: true, subtree: true });
})();
