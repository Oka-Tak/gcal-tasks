// Kairos ホーム画面ウィジェット (iOS Scriptable 用)
//
// セットアップ:
//   1. App Store で「Scriptable」を入れる
//   2. 新規スクリプトを作り、このファイルの中身を貼り付ける
//   3. 下の TOKEN を .env.local の KAIROS_WIDGET_TOKEN の値に書き換える
//   4. ホーム画面長押し → ウィジェット追加 → Scriptable → Medium →
//      ウィジェットを長押し → スクリプトにこれを選択
//   5. iPhone の Tailscale が ON であること（VPN接続時のみ届く）
//
// 表示: 次の予定(進行中は▶) / 3日以内の締切 / 昨晩の睡眠 / 今日の支出

const BASE = "https://zundamon-ubuntu-alc6.tail7507d4.ts.net:10000";
const TOKEN = "ここにKAIROS_WIDGET_TOKENを貼る";

const COLORS = {
  bg1: new Color("#1b1e2b"),
  bg2: new Color("#252a3d"),
  text: new Color("#e8eaf2"),
  muted: new Color("#9aa1b5"),
  accent: new Color("#f5c518"),
  danger: new Color("#ff6b6b"),
  ok: new Color("#7bd88f"),
};

async function fetchData() {
  const req = new Request(`${BASE}/api/widget?token=${TOKEN}`);
  req.timeoutInterval = 12;
  return await req.loadJSON();
}

function line(stack, left, right, opts = {}) {
  const row = stack.addStack();
  row.centerAlignContent();
  const l = row.addText(left);
  l.font = opts.bold ? Font.semiboldSystemFont(12) : Font.systemFont(12);
  l.textColor = opts.color ?? COLORS.text;
  l.lineLimit = 1;
  row.addSpacer();
  if (right) {
    const r = row.addText(right);
    r.font = Font.systemFont(11);
    r.textColor = COLORS.muted;
    r.lineLimit = 1;
  }
}

async function build() {
  const w = new ListWidget();
  const grad = new LinearGradient();
  grad.colors = [COLORS.bg1, COLORS.bg2];
  grad.locations = [0, 1];
  w.backgroundGradient = grad;
  w.setPadding(12, 14, 12, 14);
  w.url = BASE; // タップでKairosを開く

  let d;
  try {
    d = await fetchData();
  } catch {
    const t = w.addText("Kairos に届きません");
    t.textColor = COLORS.danger;
    t.font = Font.systemFont(12);
    const hint = w.addText("Tailscale がONか確認");
    hint.textColor = COLORS.muted;
    hint.font = Font.systemFont(10);
    return w;
  }

  // ヘッダ: 日付 + 睡眠/支出
  const head = w.addStack();
  const now = new Date();
  const title = head.addText(`${now.getMonth() + 1}/${now.getDate()} Kairos`);
  title.font = Font.boldSystemFont(13);
  title.textColor = COLORS.accent;
  head.addSpacer();
  const bits = [];
  if (d.sleep) bits.push(`😴${d.sleep}`);
  if (d.spentTodayYen > 0) bits.push(`💰¥${d.spentTodayYen.toLocaleString()}`);
  if (bits.length) {
    const meta = head.addText(bits.join("  "));
    meta.font = Font.systemFont(11);
    meta.textColor = COLORS.muted;
  }
  w.addSpacer(6);

  // 予定
  const evs = (d.events || []).slice(0, 3);
  if (!evs.length) {
    line(w, "予定なし 🎉", "", { color: COLORS.muted });
  }
  for (const e of evs) {
    line(w, `${e.ongoing ? "▶ " : ""}${e.title}`, e.when, {
      bold: e.ongoing,
      color: e.ongoing ? COLORS.ok : COLORS.text,
    });
    w.addSpacer(2);
  }

  // 締切
  const dues = (d.dues || []).slice(0, 2);
  if (dues.length) {
    w.addSpacer(4);
    for (const t of dues) {
      line(w, `⏰ ${t.title}`, t.due, { color: t.isToday ? COLORS.danger : COLORS.text, bold: t.isToday });
      w.addSpacer(2);
    }
  }

  w.refreshAfterDate = new Date(Date.now() + 10 * 60_000); // ~10分ごと更新
  return w;
}

const widget = await build();
if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  await widget.presentMedium();
}
Script.complete();
