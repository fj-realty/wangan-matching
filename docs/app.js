/* ===== 湾岸マッチング フロントエンド v2 (vanilla JS / 依存ゼロ) =====
   - 定量条件（予算・広さ・間取り・築年数・駅徒歩）で現在募集中の住戸を絞り込み
   - 24問6軸の価値観診断 → 15タイプ判定＆六角形レーダー
   - マッチ度TOP3（該当なし対応・階/㎡はぼかし表示）
   - 結果から「条件だけ変えて再検索」「最初からやり直す」 */
const CONFIG = {
  LINE_URL: "https://liff.line.me/2000002966-QKeEB4Jy/landing?follow=%40057dqjjg&lp=p6O2dE&liff_id=2000002966-QKeEB4Jy",
};
const $app = document.getElementById("app");

const BUDGET_OPTS = [
  { v: 8000, l: "〜8,000万円" }, { v: 10000, l: "〜1億円" }, { v: 12000, l: "〜1.2億円" },
  { v: 15000, l: "〜1.5億円" }, { v: 20000, l: "〜2億円" }, { v: 30000, l: "〜3億円" }, { v: null, l: "上限なし" },
];
const AREA_OPTS = [
  { v: null, l: "指定なし" }, { v: 40, l: "40㎡以上" }, { v: 50, l: "50㎡以上" }, { v: 60, l: "60㎡以上" },
  { v: 70, l: "70㎡以上" }, { v: 80, l: "80㎡以上" }, { v: 90, l: "90㎡以上" }, { v: 100, l: "100㎡以上" },
];
const LAYOUT_OPTS = [
  { v: "1R", l: "1R/1K" }, { v: "1LDK", l: "1LDK" }, { v: "2LDK", l: "2LDK" }, { v: "3LDK", l: "3LDK" }, { v: "4LDK+", l: "4LDK以上" },
];
const AGE_OPTS = [
  { v: null, l: "指定なし" }, { v: 5, l: "築5年以内" }, { v: 10, l: "築10年以内" }, { v: 15, l: "築15年以内" },
  { v: 20, l: "築20年以内" }, { v: 25, l: "築25年以内" },
];
const WALK_OPTS = [
  { v: null, l: "指定なし" }, { v: 3, l: "3分以内" }, { v: 5, l: "5分以内" }, { v: 7, l: "7分以内" },
  { v: 10, l: "10分以内" }, { v: 15, l: "15分以内" },
];

const state = {
  axes: [], scale: [], questions: [], types: [], mansions: [], listings: [], mById: {},
  screen: "intro",
  conds: { budget: 15000, areaMin: 50, layouts: [], ageMax: null, walkMax: null },
  answers: {}, qIndex: 0,
  result: null,
  researchMode: false,
};

/* ---------- 起動 ---------- */
async function boot() {
  try {
    const [qdoc, typesDoc, mans, lst] = await Promise.all([
      fetch("./data/questions.json?v=3").then((r) => r.json()),
      fetch("./data/types.json?v=3").then((r) => r.json()),
      fetch("./data/mansions.json?v=3").then((r) => r.json()),
      fetch("./data/listings.json?v=3").then((r) => r.json()),
    ]);
    state.axes = qdoc.axes;
    state.scale = qdoc.scale;
    state.questions = qdoc.questions;
    state.types = typesDoc.types;
    state.mansions = mans.mansions || [];
    state.listings = lst.listings || [];
    state.mById = {};
    state.mansions.forEach((m) => { state.mById[m.id] = m; });
    const fresh = document.getElementById("dataFresh");
    if (fresh && (lst.generatedAt || mans.generatedAt)) {
      fresh.textContent = `データ更新 ${String(lst.generatedAt || mans.generatedAt).slice(0, 10)}／募集中 ${state.listings.length}件`;
    }
    const b = document.getElementById("boot");
    if (b) b.classList.add("hide");
    render();
  } catch (e) {
    const b = document.getElementById("boot");
    if (b) b.innerHTML =
      '<div style="padding:24px;text-align:center;max-width:340px">' +
      '<div class="boot-logo">湾岸マッチング</div>' +
      '<p style="margin-top:14px;line-height:1.7">データの読み込みに失敗しました。<br>少し時間をおいて再読み込みしてください。</p></div>';
    console.error(e);
  }
}

/* ---------- ユーティリティ ---------- */
function fmtMan(man) {
  man = Math.round(man || 0);
  if (man >= 10000) {
    const oku = Math.floor(man / 10000), rest = man % 10000;
    return rest ? `${oku}億${rest.toLocaleString()}万円` : `${oku}億円`;
  }
  return `${man.toLocaleString()}万円`;
}
function blurFloor(f) { if (!f) return "階数不明"; if (f < 10) return "10階未満"; return Math.floor(f / 10) * 10 + "階台"; }
function blurSqm(s) { if (!s) return ""; return Math.floor(s / 10) * 10 + "㎡台"; }
// 募集坪単価 vs 建物の成約相場 → 相場比バッジ（成約相場がある建物のみ）
function valueTag(asking, market, source) {
  if (!asking || !market || source !== "成約") return "";
  const d = Math.round((asking - market) / market * 100);
  if (d <= 0) return `<span class="chip vgood">相場以下 ${d}%</span>`;
  if (d <= 15) return `<span class="chip vok">ほぼ相場 +${d}%</span>`;
  return `<span class="chip vhigh">相場より高め +${d}%</span>`;
}
function el(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; }
function go(screen) { state.screen = screen; render(); window.scrollTo({ top: 0, behavior: "smooth" }); }
function track(ev, params) { try { if (window.gtag) window.gtag("event", ev, params || {}); } catch (e) {} }
function countCandidates(conds) {
  try { return WANGAN.scoreListings({ liv: 50, asset: 50, fac: 50, loc: 50, size: 50, view: 50 }, conds, state.listings, state.mById, 1).candidateCount; }
  catch (e) { return 0; }
}

/* ---------- ルーター ---------- */
function render() {
  if (state.screen === "intro") return renderIntro();
  if (state.screen === "step1") return renderStep1();
  if (state.screen === "quiz") return renderQuiz();
  if (state.screen === "loading") return renderLoading();
  if (state.screen === "result") return renderResult();
}

/* ---------- INTRO ---------- */
function renderIntro() {
  $app.innerHTML = `
    <section class="hero fade">
      <span class="badge badge-warn">📊 実データ（成約＋募集中の住戸）で診断</span>
      <div class="hero-illust"><img class="hero-icon" src="fujifujita.png" alt="ふじふじ太" onerror="this.style.display='none';this.parentNode.textContent='🌆'"></div>
      <h1><span class="accent">湾岸マッチング</span></h1>
      <p class="hero-sub">あなたにベストな湾岸マンションがわかるマッチングアプリ</p>
      <p class="lead">条件 × 性格・価値観で、湾岸エリアの<br><b>いま募集中の住戸</b>からあなたにベストなTOP3を提案します。</p>
      <div class="kpis">
        <div class="kpi"><b>${state.listings.length || "—"}</b><span>募集中の住戸</span></div>
        <div class="kpi"><b>24</b><span>診断の質問</span></div>
        <div class="kpi"><b>3<small>分</small></b><span>かんたん診断</span></div>
      </div>
      <button class="btn btn-primary" id="start">無料で診断をはじめる</button>
      <p class="note">登録不要・無料／結果はSNSでシェアできます</p>
    </section>`;
  document.getElementById("start").onclick = () => { state.researchMode = false; go("step1"); };
}

/* ---------- STEP1 条件入力 ---------- */
function selectField(label, optsArr, curVal, id) {
  const opts = optsArr.map((o) => `<option value="${o.v === null ? "" : o.v}" ${String(o.v) === String(curVal) || (o.v === null && curVal == null) ? "selected" : ""}>${o.l}</option>`).join("");
  return `<div class="field"><div class="flabel"><b>${label}</b></div><select class="fselect" id="${id}">${opts}</select></div>`;
}
function conditionFieldsHTML(c) {
  const chips = LAYOUT_OPTS.map((o) =>
    `<button type="button" class="lchip ${c.layouts.indexOf(o.v) >= 0 ? "on" : ""}" data-v="${o.v}">${o.l}</button>`).join("");
  return `
    ${selectField("ご予算（上限）", BUDGET_OPTS, c.budget, "fBudget")}
    ${selectField("広さ", AREA_OPTS, c.areaMin, "fArea")}
    <div class="field">
      <div class="flabel"><b>間取り</b><span class="fhint">複数選択OK／未選択=すべて</span></div>
      <div class="lchips" id="fLayouts">${chips}</div>
    </div>
    ${selectField("築年数", AGE_OPTS, c.ageMax, "fAge")}
    ${selectField("駅徒歩", WALK_OPTS, c.walkMax, "fWalk")}
    <div class="budget-box" id="candBox"></div>`;
}
function wireConditionFields() {
  const c = state.conds;
  const upd = () => {
    const box = document.getElementById("candBox");
    if (!box) return;
    const n = countCandidates(c);
    box.innerHTML =
      `<div class="br"><span>条件に合う「募集中」の住戸</span><b>${n}<small> / ${state.listings.length}件</small></b></div>` +
      `<div class="hint">${n === 0 ? "条件が厳しすぎます。いずれかをゆるめてください。" : "この中から性格診断のマッチ度でTOP3を選びます。"}</div>`;
  };
  const parseSel = (v) => (v === "" ? null : Number(v));
  const bind = (id, key) => { const e = document.getElementById(id); if (e) e.onchange = (ev) => { c[key] = parseSel(ev.target.value); upd(); }; };
  bind("fBudget", "budget"); bind("fArea", "areaMin"); bind("fAge", "ageMax"); bind("fWalk", "walkMax");
  document.querySelectorAll("#fLayouts .lchip").forEach((b) => {
    b.onclick = () => {
      const v = b.dataset.v, i = c.layouts.indexOf(v);
      if (i >= 0) c.layouts.splice(i, 1); else c.layouts.push(v);
      b.classList.toggle("on"); upd();
    };
  });
  upd();
}
function renderStep1() {
  const research = state.researchMode;
  $app.innerHTML = `
    <section class="fade">
      <div class="step-head"><span class="step-tag">${research ? "条件を変更" : "STEP 1 / 3"}</span><span class="badge">${research ? "再検索" : "希望条件"}</span></div>
      ${research ? "" : '<div class="progress"><i style="width:33%"></i></div>'}
      <div class="card">
        <h2 class="sec">まずは、あなたの条件を</h2>
        <p class="sub">いま<b>募集中の住戸</b>から、条件に合うものを探します。${research ? "性格診断の回答はそのまま使います。" : ""}</p>
        ${conditionFieldsHTML(state.conds)}
        <button class="btn btn-primary" id="next">${research ? "この条件で再検索する →" : "価値観診断にすすむ →"}</button>
      </div>
    </section>`;
  wireConditionFields();
  document.getElementById("next").onclick = () => {
    if (research) { submit(); }
    else { state.qIndex = 0; go("quiz"); }
  };
}

/* ---------- STEP2 価値観診断 ---------- */
function renderQuiz() {
  const total = state.questions.length;
  const q = state.questions[state.qIndex];
  const axis = state.axes.find((a) => a.key === q.axis) || {};
  const cur = state.answers[q.id];
  const pct = Math.round((state.qIndex / total) * 100);

  $app.innerHTML = `
    <section class="fade">
      <div class="step-head"><span class="step-tag">STEP 2 / 3</span><span class="badge">価値観診断</span></div>
      <div class="progress"><i style="width:${pct}%"></i></div>
      <div class="card qcard">
        <div class="qnum">Q ${state.qIndex + 1} / ${total}</div>
        <div><span class="qaxis">${axis.emoji || ""} ${axis.label || ""}</span></div>
        <div class="qtext">${q.text}</div>
        <div class="opts">
          ${state.scale.map((s) => `
            <button class="opt ${cur === s.value ? "sel" : ""}" data-v="${s.value}">
              <span class="dot"></span><span>${s.label}</span>
            </button>`).join("")}
        </div>
        <div class="q-nav">
          <button class="q-back" id="back" ${state.qIndex === 0 ? "disabled" : ""}>← 戻る</button>
          <span class="step-tag">あと ${total - state.qIndex} 問</span>
        </div>
      </div>
    </section>`;

  $app.querySelectorAll(".opt").forEach((b) => {
    b.onclick = () => {
      state.answers[q.id] = +b.dataset.v;
      $app.querySelectorAll(".opt").forEach((x) => x.classList.remove("sel"));
      b.classList.add("sel");
      setTimeout(() => {
        if (state.qIndex < total - 1) { state.qIndex++; renderQuiz(); window.scrollTo({ top: 0 }); }
        else submit();
      }, 220);
    };
  });
  const back = document.getElementById("back");
  if (back) back.onclick = () => { if (state.qIndex > 0) { state.qIndex--; renderQuiz(); } };
}

/* ---------- ローディング ---------- */
function renderLoading() {
  $app.innerHTML = `<div class="loading fade"><div class="spin"></div>
    <p>あなたにベストな募集中の住戸を<br>診断しています…</p></div>`;
}

function submit() {
  go("loading");
  try {
    const res = WANGAN.diagnose(
      { conds: state.conds, answers: state.answers },
      { axes: state.axes, questions: state.questions, types: state.types, mansions: state.mansions, listings: state.listings },
      { lineUrl: CONFIG.LINE_URL }
    );
    state.result = res;
    state.researchMode = false;
    track("diagnose_complete", { type: res.type && res.type.name, candidates: res.candidateCount });
    setTimeout(() => go("result"), 500);
  } catch (e) {
    console.error(e);
    alert("診断の計算でエラーが発生しました。再読み込みしてください。");
    go("step1");
  }
}

/* ---------- レーダーチャート(SVG・軸数に自動対応＝六角形) ---------- */
function radarSVG(values, axes) {
  const cx = 170, cy = 150, R = 92, n = axes.length;
  const ang = (i) => ((-90 + (i * 360) / n) * Math.PI) / 180;
  const pt = (i, r) => [cx + r * Math.cos(ang(i)), cy + r * Math.sin(ang(i))];
  let grid = "";
  [0.25, 0.5, 0.75, 1].forEach((f) => {
    const p = axes.map((_, i) => pt(i, R * f).map((v) => v.toFixed(1)).join(",")).join(" ");
    grid += `<polygon points="${p}" fill="none" stroke="rgba(20,70,130,.16)" stroke-width="1"/>`;
  });
  let spokes = "";
  axes.forEach((_, i) => { const [x, y] = pt(i, R); spokes += `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="rgba(20,70,130,.16)"/>`; });
  const poly = axes.map((a, i) => pt(i, R * ((values[a.key] || 0) / 100)).map((v) => v.toFixed(1)).join(",")).join(" ");
  let dots = "", labels = "";
  axes.forEach((a, i) => {
    const [x, y] = pt(i, R * ((values[a.key] || 0) / 100));
    dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.2" fill="#f3c64b" stroke="#fff" stroke-width="1.5"/>`;
    const [lx, ly] = pt(i, R + 20);
    const dx = lx - cx;
    const anchor = Math.abs(dx) < 12 ? "middle" : (dx > 0 ? "start" : "end");
    labels += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}" dominant-baseline="middle" font-size="12" font-weight="700" fill="#1463bf">${a.emoji || ""}${a.label}</text>`;
  });
  return `<svg viewBox="0 0 340 310" width="100%" style="max-width:340px;height:auto" role="img" aria-label="価値観レーダーチャート（6軸）">
    ${grid}${spokes}
    <polygon points="${poly}" fill="rgba(20,99,191,.16)" stroke="#1463bf" stroke-width="2.5"/>
    ${dots}${labels}</svg>`;
}

/* ---------- STEP3 結果 ---------- */
function condSummary(c) {
  const parts = [];
  parts.push("予算 " + (c.budget ? "〜" + fmtMan(c.budget) : "上限なし"));
  if (c.areaMin) parts.push(c.areaMin + "㎡以上");
  if (c.layouts && c.layouts.length) parts.push(c.layouts.map((v) => (LAYOUT_OPTS.find((o) => o.v === v) || {}).l || v).join("/"));
  if (c.ageMax) parts.push("築" + c.ageMax + "年以内");
  if (c.walkMax) parts.push("徒歩" + c.walkMax + "分以内");
  return parts.join("・");
}

function renderResult() {
  const r = state.result, t = r.type, axes = r.axesMeta || state.axes;
  const medals = ["🥇", "🥈", "🥉"];

  const ranksHtml = r.matches.length === 0
    ? `<div class="card" style="text-align:center;padding:26px 18px">
         <div style="font-size:40px">🔍</div>
         <h3 style="margin:8px 0">条件に合う「募集中」物件が<br>見つかりませんでした</h3>
         <p class="sub">予算・広さ・間取り・築年数・駅徒歩 のいずれかを少しゆるめると見つかりやすくなります。</p>
         <button class="btn btn-primary" id="loosen">条件を変更する</button>
       </div>`
    : r.matches.map((m, idx) => {
      const L = m.listing, b = m.building || {};
      const facs = ["プール", "ジム", "サウナ", "バー", "コンビニ", "内廊下"].filter((f) => b.facilities && b.facilities[f]);
      return `
        <div class="rank rank-click" data-bid="${L.bid}">
          <div class="rthumb">
            ${b.photoUrl ? `<img src="${b.photoUrl}" alt="${L.name}の外観" loading="lazy" onerror="this.style.display='none'">` : ""}
            <span class="medal">${medals[idx] || ""}</span>
          </div>
          <div class="rinfo">
            ${idx === 0 ? '<span class="best-badge">★ ベストマッチ</span>' : ""}
            <div class="rname">${L.name}</div>
            <div class="rmeta">${L.area}${b.station ? "・" + b.station + "駅 徒歩" + (b.walkMin != null ? b.walkMin + "分" : "—") : ""}${b.ageYears != null ? "・築" + b.ageYears + "年" : ""}${b.seismic ? "・" + b.seismic : ""}</div>
            <div class="chips">
              <span class="chip price">${fmtMan(L.price)}</span>
              <span class="chip">${blurFloor(L.floor)}・${blurSqm(L.sqm)}${L.layout ? "・" + L.layout : ""}${L.direction ? "・" + L.direction + "向き" : ""}${L.corner ? "・角部屋" : ""}</span>
            </div>
            <div class="chips">
              <span class="chip price">募集 ${L.askingTsubo}万/坪</span>
              ${b.marketTsubo ? `<span class="chip">${b.tsuboSource === "成約" ? "成約相場 " + b.marketTsubo + "万/坪" : "参考 " + b.marketTsubo + "万/坪(募集)"}</span>` : ""}
              ${valueTag(L.askingTsubo, b.marketTsubo, b.tsuboSource)}
              ${b.trendPct != null ? `<span class="chip ${b.trendPct >= 0 ? "up" : "down"}">📈 ${b.trendPct >= 0 ? "+" : ""}${b.trendPct}%</span>` : ""}
              <span class="chip fac">🌅 眺望 ${L.viewScore}</span>
            </div>
            ${facs.length ? `<div class="chips">${facs.map((f) => `<span class="chip fac">${f === "バー" ? "ラウンジ/バー" : f}</span>`).join("")}</div>` : ""}
            <div class="rest">現在募集中／坪単価は${b.tsuboSource === "成約" ? "実成約" : "募集"}ベース。階数・面積はぼかして表示しています。</div>
            <div class="tap-hint">▸ この建物の募集中の部屋をすべて見る</div>
          </div>
          <div class="match"><b>${m.matchPct}<small>%</small></b><span>マッチ度</span></div>
        </div>`;
    }).join("");

  $app.innerHTML = `
    <section class="fade">
      <div class="card card result-hero">
        <span class="badge badge-warn" style="position:absolute;top:14px;right:14px">実データ</span>
        <div class="emoji">${t.emoji}</div>
        <div class="tlabel">あなたの購入タイプは</div>
        <h1><span class="accent">${t.name}</span></h1>
        <div class="catch">${t.catch}</div>
        <p class="desc">${t.desc}</p>
      </div>

      <div class="section-title">📊 あなたの価値観バランス（6軸）</div>
      <div class="card">
        <div class="radar-wrap">${radarSVG(r.userAxis, axes)}</div>
        <div class="axis-legend">
          ${axes.map((a) => `<div><b>${r.userAxis[a.key]}</b><br>${a.label}</div>`).join("")}
        </div>
      </div>

      <div class="section-title">🏙️ いま狙えるTOP3</div>
      <div class="budget-recap">
        <div><span>あなたの条件</span><b style="font-size:13px">${condSummary(r.conds)}</b></div>
        <div><span>条件に合う募集中</span><b>${r.candidateCount}<small>/${r.totalListings}件</small></b></div>
      </div>
      <div id="ranks">${ranksHtml}</div>
      <p class="lock-note">📊「成約相場」＝実際に売れた坪単価の直近3ヶ月平均（湾岸タワマンDB・月次更新）／「募集」＝現在の売り出し坪単価。相場比はその差。各スコアは実データに基づく算出値です。</p>
      <p class="lock-note">🔒 部屋番号・正確な階数/面積・最新の空室状況はLINEでご案内します</p>

      <div class="section-title">🔧 条件を変えて再検索</div>
      <div class="card" id="condPanel">
        <p class="sub" style="margin-bottom:14px">性格診断の回答はそのまま、条件だけ変えてすぐ再検索できます。</p>
        ${conditionFieldsHTML(r.conds)}
        <button class="btn btn-primary" id="reSearchInline">この条件で再検索する</button>
      </div>

      <div class="card cta-card">
        <h3>気になる住戸、見つかりましたか？</h3>
        <p>専任アドバイザーが、あなたのタイプと条件に合わせて<br>具体的な部屋・価格をご提案します。</p>
        <button class="btn btn-line" id="line">💬 この条件で相談する（LINE）</button>
        <div class="share-row">
          <button class="btn btn-x btn-sm" id="share">𝕏 結果をシェア</button>
          <button class="btn btn-ghost btn-sm" id="restart">最初からやり直す</button>
        </div>
      </div>
    </section>`;

  const loosen = document.getElementById("loosen");
  if (loosen) loosen.onclick = () => { const p = document.getElementById("condPanel"); if (p) p.scrollIntoView({ behavior: "smooth", block: "start" }); };
  document.getElementById("line").onclick = () => {
    const url = r.lineUrl || CONFIG.LINE_URL || "#";
    track("line_click", { type: r.type && r.type.name, top: r.matches[0] && r.matches[0].listing.name });
    window.open(url, "_blank");
  };
  document.getElementById("share").onclick = shareX;
  wireConditionFields();
  document.getElementById("reSearchInline").onclick = () => submit();
  document.getElementById("restart").onclick = () => {
    state.answers = {}; state.qIndex = 0; state.researchMode = false;
    state.conds = { budget: 15000, areaMin: 50, layouts: [], ageMax: null, walkMax: null };
    go("intro");
  };
  $app.querySelectorAll(".rank-click").forEach((card) => {
    card.onclick = () => openBuildingModal(card.dataset.bid);
  });
}

/* ---------- 建物の募集中住戸モーダル ---------- */
function unitRow(L, b) {
  const tag = valueTag(L.askingTsubo, b && b.marketTsubo, b && b.tsuboSource);
  return `
    <div class="unit">
      <div class="uinfo">
        <b>${blurFloor(L.floor)}・${blurSqm(L.sqm)}</b>
        <span>${L.layout || "間取り不明"}${L.direction ? "・" + L.direction + "向き" : ""}${L.corner ? "・角部屋" : ""}・🌅${L.viewScore}</span>
        ${tag}
      </div>
      <div class="uprice"><b>${fmtMan(L.price)}</b><span>坪${L.askingTsubo}万</span></div>
    </div>`;
}
function openBuildingModal(bid) {
  const b = state.mById[bid];
  if (!b) return;
  const conds = (state.result && state.result.conds) || {};
  const all = state.listings.filter((L) => L.bid === bid).sort((x, y) => x.price - y.price);
  const matching = all.filter((L) => WANGAN.listingPassesConds(L, b, conds));
  let showAll = false;
  track("building_detail", { building: b.name, matching: matching.length, all: all.length });
  const facs = ["プール", "ジム", "サウナ", "バー", "コンビニ", "内廊下"].filter((f) => b.facilities && b.facilities[f]);
  const m = el(`<div class="modal-ov" id="bmodal">
    <div class="modal" role="dialog" aria-label="${b.name} の募集中住戸">
      <button class="modal-x" aria-label="閉じる">×</button>
      <div class="rname" style="font-size:1.22rem;padding-right:30px">${b.name}</div>
      <div class="rmeta">${b.area}${b.station ? "・" + b.station + "駅 徒歩" + (b.walkMin != null ? b.walkMin + "分" : "—") : ""}${b.ageYears != null ? "・築" + b.ageYears + "年" : ""}${b.seismic ? "・" + b.seismic : ""}${b.totalUnits ? "・" + b.totalUnits + "戸" : ""}</div>
      <div class="chips" style="margin-top:8px">
        ${b.marketTsubo ? `<span class="chip price">市場坪単価 ${b.marketTsubo}万(${b.tsuboSource === "成約" ? "成約" : "募集"})</span>` : ""}
        ${b.trendPct != null ? `<span class="chip ${b.trendPct >= 0 ? "up" : "down"}">📈 ${b.trendPct >= 0 ? "+" : ""}${b.trendPct}%</span>` : ""}
        ${facs.map((f) => `<span class="chip fac">${f === "バー" ? "ラウンジ/バー" : f}</span>`).join("")}
      </div>
      <div class="modal-sub" id="uSub"></div>
      <div class="unit-list" id="uList"></div>
      <button class="utoggle" id="uToggle"></button>
      <p class="lock-note" style="margin-top:10px">※ 部屋番号・正確な階数/面積・最新の空室状況はLINEでご案内します</p>
      <button class="btn btn-line" id="mLine">💬 この建物について相談する（LINE）</button>
    </div>
  </div>`);
  const renderList = () => {
    const arr = showAll ? all : matching;
    m.querySelector("#uList").innerHTML = arr.length ? arr.map((L) => unitRow(L, b)).join("")
      : '<div class="rest" style="padding:10px 4px">ご希望条件に合う募集中はありません。下の「条件外も見る」で全戸を確認できます。</div>';
    m.querySelector("#uSub").innerHTML = showAll
      ? `この建物の募集中 <b>${all.length}</b> 戸 <small>（安い順・階/面積ぼかし）</small>`
      : `ご希望条件に合う募集中 <b>${matching.length}</b> 戸 <small>（全${all.length}戸中・安い順）</small>`;
    const tg = m.querySelector("#uToggle");
    if (all.length > matching.length) {
      tg.style.display = "";
      tg.textContent = showAll ? `↩ 条件に合う${matching.length}戸だけ表示` : `条件以外も含めて全${all.length}戸を見る ▾`;
    } else { tg.style.display = "none"; }
  };
  document.body.appendChild(m);
  document.body.style.overflow = "hidden";
  const close = () => { m.remove(); document.body.style.overflow = ""; };
  m.onclick = (e) => { if (e.target === m) close(); };
  m.querySelector(".modal-x").onclick = close;
  m.querySelector("#uToggle").onclick = () => { showAll = !showAll; renderList(); };
  m.querySelector("#mLine").onclick = () => { track("line_click", { from: "modal", building: b.name }); window.open(CONFIG.LINE_URL, "_blank"); };
  renderList();
}

function shareX() {
  const r = state.result, t = r.type;
  track("share_click", { type: t && t.name });
  const names = r.matches.map((m, i) => `${i + 1}. ${m.listing.name}`).join("\n");
  const body = r.matches.length ? `\n\n◤いま狙えるTOP3◢\n${names}` : "";
  const text = `私の湾岸マンションタイプは「${t.emoji}${t.name}」でした！\n${t.catch}${body}\n\nあなたは何タイプ？`;
  const url = location.origin + location.pathname;
  window.open(
    `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}&hashtags=湾岸マッチング,湾岸タワマン`,
    "_blank"
  );
}

boot();
