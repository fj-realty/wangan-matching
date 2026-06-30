# -*- coding: utf-8 -*-
"""
【v2ビルダー】★湾岸マンション募集DB ver2 から
  - docs/data/mansions.json … 建物単位（5軸スコア＋スペック＋市場坪単価）
  - docs/data/listings.json … 現在募集中の住戸単位（価格/面積/階/間取り/方位/角/眺望）
を構築する。

参照（すべて読み取りのみ・gviz CSV / 公開xlsx）:
  募集DB ver2 (id=1reTIz...) の各タブ:
    成約履歴      … 棟の市場坪単価（成約価格÷坪の単純平均＝新方式）＋値上がり率(資産性)
    募集マスタ_*  … 現在募集中の住戸（最新スナップショット列に価格がある行を抽出）
  従DB スペック(別シート) … 駅徒歩/築年/耐震/総戸数/総階数/共用施設（48/49棟をカバー）

※旧「湾岸タワマンDB(本番用)」の成約取得は tools/build_mansions_from_db.py に
  レガシーとして保持（将来復活用・通常は実行しない）。本v2では使用しない。

実行: python3 tools/build_data_v2.py
"""
import os, re, csv, io, json, datetime, statistics, unicodedata, urllib.request, urllib.parse
from collections import Counter, defaultdict
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_mansions_from_db as base  # 純粋ヘルパ／スコア関数を再利用

ROOT = base.ROOT
OUT_MANSIONS = os.path.join(ROOT, "docs", "data", "mansions.json")
OUT_LISTINGS = os.path.join(ROOT, "docs", "data", "listings.json")

BOSHU_ID = "1reTIz2hLX6dYmUykKxDzdTb3c93ggh3ZQoK1v5RXYsA"
AREAS = ["豊洲", "東雲", "有明", "晴海", "勝どき・月島", "豊海"]
TSUBO = 3.30578
THIS_YEAR = base.THIS_YEAR

DIRS = {"南", "北", "東", "西", "南東", "南西", "北東", "北西"}
DATE_RE = re.compile(r"^\d{1,2}/\d{1,2}$")
FLOOR_RE = re.compile(r"^(\d+)\s*階$")
LAYOUT_RE = re.compile(r"^(ワンルーム|1R|[1-9]\d?[SLDK]{1,3})$")
PRICE_RE = re.compile(r"([\d,]+)\s*万円")

# 成約履歴/売出履歴の列: NO,年月,エリア,名,階数,面積,間取り,価格,坪単価,方位,月
S_YM, S_AREA, S_NAME, S_FLOOR, S_SQM, S_LAYOUT, S_PRICE, S_TSUBO = 1, 2, 3, 4, 5, 6, 7, 8


# ---------------------------------------------------------------- 名寄せ（強）
def keyname(s):
    """棟名の表記揺れを強く吸収（NFKC＋小文字＋空白/括弧/中黒/長音/各種ダッシュ除去）。
    成約履歴『…(タワーA)』と募集マスタ『… タワーA』、スペックの表記差を一致させる。"""
    s = unicodedata.normalize("NFKC", s or "").lower()
    s = re.sub(r"[()\[\]（）［］「」｛｝{}・,，、。\.\s ー\-―–—~〜&＆]", "", s)
    return s.strip()


# ---------------------------------------------------------------- 取得
def gviz(sheet, retry=3):
    url = f"https://docs.google.com/spreadsheets/d/{BOSHU_ID}/gviz/tq?tqx=out:csv&sheet=" + urllib.parse.quote(sheet)
    last = None
    for _ in range(retry):
        try:
            data = urllib.request.urlopen(url, timeout=60).read().decode("utf-8")
            return list(csv.reader(io.StringIO(data)))
        except Exception as e:  # noqa
            last = e
    raise RuntimeError(f"gviz取得失敗: {sheet}: {last}")


def to_man(s):
    m = PRICE_RE.search(s or "")
    return int(m.group(1).replace(",", "")) if m else None


def to_f(s):
    s = (s or "").strip()
    if not s or not re.search(r"\d", s):
        return None
    try:
        return float(re.sub(r"[^0-9.]", "", s))
    except ValueError:
        return None


def mean(xs):
    return sum(xs) / len(xs) if xs else None


# ---------------------------------------------------------------- 成約履歴 → 棟の市場データ
def load_seiyaku():
    """棟ごとに {tsubo成約坪単価リスト, (year,坪単価)リスト} を集計。"""
    rows = gviz("成約履歴")
    per = defaultdict(lambda: {"tsubo": [], "yt": []})
    for r in rows[1:]:
        if len(r) <= S_TSUBO or not (r[S_NAME] or "").strip():
            continue
        t = to_f(r[S_TSUBO])
        if t is None or t < 50 or t > 3000:
            continue
        k = keyname(r[S_NAME])
        per[k]["tsubo"].append(t)
        y = base.year_of(r[S_YM])
        if y:
            per[k]["yt"].append((y, t))
    out = {}
    for k, d in per.items():
        ts = d["tsubo"]
        # 新方式：成約坪単価の単純平均（毎月末データ／1取引1票・全期間）
        market_tsubo = round(mean(ts)) if ts else None
        # 値上がり率（資産性）：年の前半 vs 後半の中央値
        trend = None
        yt = d["yt"]
        if yt:
            ys = [y for y, _ in yt]
            y_min, y_max = min(ys), max(ys)
            if (y_max - y_min) >= 3:
                early = [t for y, t in yt if y <= y_min + 1]
                late = [t for y, t in yt if y >= y_max - 1]
                if early and late and statistics.median(early):
                    trend = round((statistics.median(late) / statistics.median(early) - 1) * 100, 1)
        out[k] = {"marketTsubo": market_tsubo, "trendPct": trend, "txCount": len(ts)}
    return out


# ---------------------------------------------------------------- 募集マスタ → 現在募集中の住戸
def parse_listing(row, date_cols, latest_col):
    price = to_man(row[latest_col]) if len(row) > latest_col else None
    if not price:
        return None
    name = (row[1] if len(row) > 1 else "").strip()
    if not name:
        return None
    floor = layout = direction = None
    corner = False
    floats = []
    for i, c in enumerate(row):
        c = (c or "").strip()
        if not c or i in date_cols:
            continue
        if direction is None and c in DIRS:
            direction = c
        if c == "角":
            corner = True
        if floor is None:
            m = FLOOR_RE.match(c)
            if m:
                floor = int(m.group(1))
        if layout is None and LAYOUT_RE.match(c):
            layout = c
        if "万" not in c:
            f = to_f(c)
            if f is not None:
                floats.append(f)
    # 面積㎡/坪 は比 ~3.306 のペアで特定（坪単価と誤認しない）
    sqm = None
    for a in floats:
        for b in floats:
            if b and 3.15 < a / b < 3.45 and 15 <= a <= 400:
                sqm = a
                break
        if sqm:
            break
    if sqm is None:
        cand = [f for f in floats if 15 <= f <= 250]
        sqm = cand[0] if cand else None
    if not (floor and sqm):
        return None
    return {"name": name, "price": price, "sqm": round(sqm, 2),
            "floor": floor, "layout": layout, "direction": direction, "corner": corner}


def load_listings():
    """全エリアの募集マスタから現在募集中（最新スナップショット列に価格あり）を抽出。"""
    out = []
    per_area = {}
    for a in AREAS:
        rows = gviz("募集マスタ_" + a)
        hdr = rows[0]
        date_cols = [i for i, h in enumerate(hdr) if DATE_RE.match((h or "").strip())]
        latest = None
        for c in reversed(date_cols):
            if any(len(r) > c and (r[c] or "").strip() for r in rows[1:]):
                latest = c
                break
        cnt = 0
        if latest is not None:
            dcset = set(date_cols)
            for r in rows[1:]:
                L = parse_listing(r, dcset, latest)
                if L:
                    L["area"] = a
                    L["bkey"] = keyname(L["name"])
                    out.append(L)
                    cnt += 1
        per_area[a] = cnt
    return out, per_area


# ---------------------------------------------------------------- 眺望スコア（階数ベース・将来方角追加可）
def view_score(floor, total_floors):
    """眺望＝階数/総階数（高層ほど高得点）。総階数不明時は絶対階で代替。
    将来：方角(海/運河向き)や前建ての有無を加点する拡張余地を残す。"""
    if total_floors and total_floors > 0:
        ratio = min(1.0, floor / total_floors)
        return base.clamp(45 + 53 * ratio)
    return base.clamp(45 + min(floor, 50) * 1.0)


# ---------------------------------------------------------------- 構築
def build():
    # 強名寄せでスペックを読む（base.read_spec を流用しつつキーを強normへ）
    base._fetch(base.SPEC_XLSX_URL, base.SPEC_XLSX, min_bytes=20000)
    base.norm = keyname  # ← read_spec のキー生成を強normへ差し替え
    spec_map = base.read_spec()

    market = load_seiyaku()
    listings, per_area = load_listings()

    # 募集中の棟ごとに住戸を束ねる
    by_bldg = defaultdict(list)
    for L in listings:
        by_bldg[L["bkey"]].append(L)

    mansions = []
    floors_by_key = {}
    for bkey, units in by_bldg.items():
        rep_name = Counter(u["name"] for u in units).most_common(1)[0][0]
        area = Counter(u["area"] for u in units).most_common(1)[0][0]
        sp = spec_map.get(bkey, {})
        fac = sp.get("facilities", {k: False for k in base.FAC_KEYS})
        mk = market.get(bkey, {})
        # 総階数：スペックが妥当ならそれを、壊れ/欠落時は募集の最高階で代替（眺望算出と表示に使用）
        max_floor = max((u["floor"] for u in units if u["floor"]), default=0)
        sp_floors = sp.get("floors")
        total_floors = sp_floors if (sp_floors and sp_floors >= max_floor) else (max_floor or None)
        floors_by_key[bkey] = total_floors

        # 市場坪単価：成約があれば成約ベース、無ければ募集（現在価格）の中央値で代替
        asking_tsubos = [round(u["price"] / (u["sqm"] / TSUBO)) for u in units if u["sqm"]]
        if mk.get("marketTsubo"):
            tsubo_price, tsubo_source = mk["marketTsubo"], "成約"
        elif asking_tsubos:
            tsubo_price, tsubo_source = round(statistics.median(asking_tsubos)), "募集"
        else:
            tsubo_price, tsubo_source = None, None

        sqms = [u["sqm"] for u in units if u["sqm"]]
        median_sqm = round(statistics.median(sqms), 1) if sqms else None
        rep_layout = Counter(u["layout"] for u in units if u["layout"]).most_common(1)
        rep_layout = rep_layout[0][0] if rep_layout else ""

        fac_score = base.score_fac(fac)
        loc_score = base.score_loc(area, sp.get("walkMin"))
        liv_score = base.score_liv(sp.get("builtYear"), sp.get("seismic"), fac, fac_score)
        trend = mk.get("trendPct")
        asset_score = base.clamp(55 + trend * 0.45) if trend is not None else base.clamp(base.AREA_BASE.get(area, base.DEFAULT_BASE)["asset"])
        size_score = base.clamp(38 + ((median_sqm or 60) - 45) * 1.0)

        mansions.append({
            "key": bkey, "name": rep_name, "area": area,
            "marketTsubo": tsubo_price, "tsuboSource": tsubo_source,
            "trendPct": trend, "txCount": mk.get("txCount", 0),
            "listingCount": len(units), "medianSqm": median_sqm, "repLayout": rep_layout,
            "station": sp.get("station"), "walkMin": sp.get("walkMin"),
            "builtYear": sp.get("builtYear"), "ageYears": sp.get("ageYears"),
            "seismic": sp.get("seismic"), "floors": total_floors,
            "totalUnits": sp.get("totalUnits"), "address": sp.get("address"),
            "modelName": sp.get("modelName"),
            "photoUrl": (base.PHOTO_BASE + sp["modelName"] + ".jpg") if sp.get("modelName") else None,
            "facilities": {k: bool(fac.get(k)) for k in base.FAC_KEYS},
            "specsPending": not sp,
            # 建物5軸（眺望は住戸ごとにlistings側で算出）
            "scores": {"liv": liv_score, "asset": asset_score, "fac": fac_score,
                       "loc": loc_score, "size": size_score},
        })

    mansions.sort(key=lambda m: (m["area"], -(m["marketTsubo"] or 0)))
    idmap = {}
    for i, m in enumerate(mansions, 1):
        m["id"] = f"WM{i:03d}"
        idmap[m["key"]] = m["id"]

    # 住戸側を仕上げ（眺望・坪単価・建物ID付与）
    out_listings = []
    for j, L in enumerate(sorted(listings, key=lambda x: (x["area"], x["bkey"], -x["floor"])), 1):
        tf = floors_by_key.get(L["bkey"])
        tsubo = L["sqm"] / TSUBO if L["sqm"] else None
        out_listings.append({
            "id": f"L{j:04d}", "bid": idmap.get(L["bkey"]), "bkey": L["bkey"],
            "name": L["name"], "area": L["area"],
            "price": L["price"],                       # 総額（万円）
            "sqm": L["sqm"], "tsubo": round(tsubo, 2) if tsubo else None,
            "askingTsubo": round(L["price"] / tsubo) if tsubo else None,  # 募集坪単価(万/坪)
            "floor": L["floor"], "layout": L["layout"],
            "direction": L["direction"], "corner": L["corner"],
            "viewScore": view_score(L["floor"], tf),
        })
    return mansions, out_listings, per_area, spec_map, market


def _now():
    return datetime.datetime.now().isoformat(timespec="seconds")


def rebuild_and_save():
    mansions, listings, per_area, spec_map, market = build()
    mpay = {
        "_note": "建物単位。坪単価=成約履歴の成約坪単価の単純平均(新方式)。成約が無い棟はtsuboSource='募集'で現在募集の中央値。"
                 "駅徒歩/築年/耐震/総戸数/総階数/施設は従DB(スペック)。5軸スコアは実データ算出（眺望は住戸ごとlistings側）。",
        "source": "real", "priceMethod": "成約坪単価の単純平均（毎月末データ・全期間／成約が無い棟は募集坪単価の中央値）",
        "generatedAt": _now(), "count": len(mansions), "mansions": mansions,
    }
    lpay = {
        "_note": "現在募集中の住戸（各エリア募集マスタの最新スナップショット列に価格がある行）。眺望=階数/総階数から算出。",
        "source": "real", "generatedAt": _now(), "count": len(listings), "listings": listings,
    }
    for path, pay in ((OUT_MANSIONS, mpay), (OUT_LISTINGS, lpay)):
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(pay, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    return mansions, listings, per_area, spec_map, market


def main():
    mansions, listings, per_area, spec_map, market = rebuild_and_save()
    no_spec = [m["name"] for m in mansions if m["specsPending"]]
    by_src = Counter(m["tsuboSource"] for m in mansions)
    print(f"✓ mansions {len(mansions)}棟 / listings {len(listings)}件 -> docs/data/")
    print(f"  エリア別 募集: {per_area}")
    print(f"  坪単価ソース: {dict(by_src)}（成約={by_src.get('成約',0)}棟 / 募集代替={by_src.get('募集',0)}棟）")
    print(f"  スペック未連携: {len(no_spec)}棟 {no_spec}")
    print("  サンプル住戸:")
    for L in listings[:5]:
        b = next((m for m in mansions if m["id"] == L["bid"]), {})
        print(f"    {L['name'][:18]:18} {L['floor']}階 {L['sqm']}㎡ {L['layout']} {L['price']}万 "
              f"坪{L['askingTsubo']} 眺望{L['viewScore']} / 徒歩{b.get('walkMin')}分 築{b.get('ageYears')}年")


if __name__ == "__main__":
    main()
