/* ===== 湾岸マッチング 診断エンジン v2（ブラウザ版・依存ゼロ） =====
   - 6軸(居住性/資産性/施設/立地/広さ/眺望)の価値観診断
   - 提案は「現在募集中の住戸(listings)」を、定量条件で絞り込み→6軸マッチ度でTOP3
   - 予算は直接入力（旧: 世帯年収×7 は廃止）
   ※建物5軸スコアは mansions.json、眺望は住戸の階数から算出済(listings.viewScore)。 */
(function (global) {
  "use strict";
  var TSUBO_PER_SQM = 3.30578;
  var AXES = ["liv", "asset", "fac", "loc", "size", "view"];

  // STEP2: 24問 → 6軸 0-100
  function computeUserAxes(answers, questions) {
    answers = answers || {};
    var raw = {}, count = {};
    AXES.forEach(function (a) { raw[a] = 0; count[a] = 0; });
    questions.forEach(function (q) {
      var a = q.axis;
      if (raw[a] === undefined) return;
      var v = answers[q.id];
      if (v === undefined) v = answers[String(q.id)];
      v = Number(v) || 0;
      v = Math.max(-2, Math.min(2, v));
      if (q.rev) v = -v;
      raw[a] += v;
      count[a] += 1;
    });
    var user = {};
    AXES.forEach(function (a) {
      var n = count[a] || 1, lo = -2 * n, hi = 2 * n;
      user[a] = hi !== lo ? Math.round((raw[a] - lo) / (hi - lo) * 100) : 50;
    });
    return user;
  }

  // STEP3: タイプ判定（最近傍 archetype・6軸ユークリッド距離）
  function classifyType(userAxes, types) {
    var best = null, bestDist = Infinity;
    types.forEach(function (t) {
      var d = 0;
      AXES.forEach(function (a) { var diff = userAxes[a] - (t.axis[a] || 0); d += diff * diff; });
      d = Math.sqrt(d);
      if (d < bestDist) { bestDist = d; best = t; }
    });
    return { key: best.key, name: best.name, emoji: best.emoji, catch: best.catch, desc: best.desc, axis: best.axis };
  }

  // 間取りをカテゴリ化（フォームのチェックボックスと突合：1R/1LDK/2LDK/3LDK/4LDK+）
  function layoutCat(s) {
    if (!s) return null;
    if (/(ワンルーム|^1R|^1K|^1DK|^1SK|^STUDIO)/i.test(s)) return "1R";
    var m = s.match(/^([1-9])/);
    if (!m) return "other";
    var n = +m[1];
    if (n >= 4) return "4LDK+";
    return n + "LDK";
  }

  // 住戸が定量条件(予算/広さ/間取り/築年/駅徒歩)を満たすか（提案とモーダルで共通利用）
  function listingPassesConds(L, building, conds) {
    conds = conds || {};
    building = building || {};
    var hasLayout = conds.layouts && conds.layouts.length > 0;
    if (conds.budget && L.price > conds.budget) return false;
    if (conds.areaMin && (L.sqm == null || L.sqm < conds.areaMin)) return false;
    if (hasLayout && (!L.layout || conds.layouts.indexOf(layoutCat(L.layout)) < 0)) return false;
    if (conds.ageMax != null && building.ageYears != null && building.ageYears > conds.ageMax) return false;
    if (conds.walkMax != null && building.walkMin != null && building.walkMin > conds.walkMax) return false;
    return true;
  }

  // 住戸の6軸ベクトル（建物5軸 + 住戸の眺望）
  function listingVector(L, building) {
    var s = (building && building.scores) || {};
    return {
      liv: s.liv != null ? s.liv : 50,
      asset: s.asset != null ? s.asset : 50,
      fac: s.fac != null ? s.fac : 50,
      loc: s.loc != null ? s.loc : 50,
      size: s.size != null ? s.size : 50,
      view: L.viewScore != null ? L.viewScore : 50,
    };
  }

  // STEP3: 現在募集中の住戸を 定量条件で絞り込み → 6軸マッチ度でTOP3
  //   conds = { budget(万,任意), areaMin(㎡,任意), layouts([],任意), ageMax(年,任意), walkMax(分,任意) }
  function scoreListings(userAxes, conds, listings, mansionById, topN) {
    topN = topN || 3;
    conds = conds || {};
    var weights = {}, wsum = 0;
    AXES.forEach(function (a) { weights[a] = userAxes[a] + 10; wsum += weights[a]; });
    if (!wsum) wsum = 1;

    var pass = [];
    listings.forEach(function (L) {
      var b = mansionById[L.bid] || {};
      // ---- ハード条件（満たさなければ除外）----
      if (!listingPassesConds(L, b, conds)) return;
      // ---- ソフト：6軸マッチ度 ----
      var vec = listingVector(L, b);
      var matchRaw = 0;
      AXES.forEach(function (a) { matchRaw += weights[a] * vec[a]; });
      matchRaw = matchRaw / wsum;
      pass.push({
        listing: L, building: b, vec: vec,
        matchPct: Math.max(1, Math.min(99, Math.round(matchRaw))),
      });
    });
    pass.sort(function (a, b) {
      if (b.matchPct !== a.matchPct) return b.matchPct - a.matchPct;
      return (b.listing.viewScore || 0) - (a.listing.viewScore || 0);
    });
    // 同一建物の重複を除き、別々の建物でTOP3（選択肢のバリエーション確保）
    var seen = {}, uniq = [];
    pass.forEach(function (p) {
      var k = p.listing.bid || p.listing.bkey;
      if (seen[k]) return;
      seen[k] = 1; uniq.push(p);
    });
    return { matches: uniq.slice(0, topN), candidateCount: pass.length, buildingCount: uniq.length };
  }

  // まとめ
  function diagnose(input, data, opts) {
    opts = opts || {};
    var userAxes = computeUserAxes(input.answers, data.questions);
    var type = classifyType(userAxes, data.types);
    var mById = {};
    (data.mansions || []).forEach(function (m) { mById[m.id] = m; });
    var conds = input.conds || {};
    var r = scoreListings(userAxes, conds, data.listings || [], mById, 3);
    return {
      conds: conds,
      userAxis: userAxes,
      axesMeta: data.axes,
      type: type,
      matches: r.matches,
      candidateCount: r.candidateCount,
      totalListings: (data.listings || []).length,
      lineUrl: opts.lineUrl || "",
    };
  }

  global.WANGAN = { diagnose: diagnose, scoreListings: scoreListings, listingPassesConds: listingPassesConds, computeUserAxes: computeUserAxes, classifyType: classifyType, layoutCat: layoutCat, AXES: AXES, TSUBO_PER_SQM: TSUBO_PER_SQM };
})(window);
