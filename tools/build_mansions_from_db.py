# -*- coding: utf-8 -*-
"""
【レガシー v1・通常は実行しない】主DB＝旧「湾岸タワマンDB(本番用)」の成約データ。
v2で参照先を「★湾岸マンション募集DB ver2」へ移行したため、本ビルダーは将来の
機能復活用に保持している（コードは消さずに残す方針）。現行の生成は
tools/build_data_v2.py を使用し、純粋ヘルパ/スコア関数は本ファイルから再利用している。

data/mansions.json を 2つの実DBから構築する。

  主DB（成約データ）  : 「湾岸タワマンDB(本番用)」5,843件
      → 坪単価(直近3ヶ月の移動平均/1取引1票)・値上がり率(資産性)・面積中央値(広さ)・取引件数・代表間取り
  従DB（スペック）    : 別スプレッドシート「検索・ソート情報」49棟
      → 駅徒歩・築年・耐震・総戸数・共用施設(プール/ジム/バー/サウナ/コンビニ/内廊下/オール電化)

2つを物件名（NFKC正規化＋空白除去）で結合し、5軸スコアを実データから算出する。
  資産性 asset … 値上がり率（成約）
  広さ   size  … 成約面積の中央値
  施設   fac   … 共用施設フラグ（従DB）
  立地   loc   … 駅徒歩（従DB）＋エリア
  居住性 liv   … 築年・耐震・内廊下・オール電化・施設（従DB）

※スプレッドシートは「読み取り専用」。本スクリプトは取得(export)のみで、シートを編集しない。
実行: python3 tools/build_mansions_from_db.py
"""
import csv, os, re, json, datetime, statistics, unicodedata, zipfile, urllib.request
from xml.etree import ElementTree as ET
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSV_PATH = os.path.join(ROOT, "data", "raw", "transactions.csv")   # 主DB
SPEC_XLSX = os.path.join(ROOT, "data", "raw", "spec_master.xlsx")  # 従DB
OUT_PATH = os.path.join(ROOT, "docs", "data", "mansions.json")   # 公開フォルダ(GitHub Pages)へ出力

TX_SHEET, TX_GID = "1bACQzWCUEPAOzvgz-MR-7A3VxVQmYNtebicjJv6h7Ok", "1143110723"
TX_CSV_URL = f"https://docs.google.com/spreadsheets/d/{TX_SHEET}/export?format=csv&gid={TX_GID}"
SPEC_SHEET = "1oDzjB2OrS3arlr868wDUckeJPVXZLr1PakxSFIEhBE4"
SPEC_XLSX_URL = f"https://docs.google.com/spreadsheets/d/{SPEC_SHEET}/export?format=xlsx"

# 外観写真（湾岸マンションアナリティクスの公開アセット。モデル名で命名）
PHOTO_BASE = "https://www.wangananalytics.com/images/properties/"

THIS_YEAR = 2026

# 列インデックス（主DB: NO,成約年月,エリア,マンション名,階数,面積,間取り,成約価格,坪単価,...）
C_DATE, C_AREA, C_NAME, C_SQM, C_LAYOUT, C_TSUBO = 1, 2, 3, 5, 6, 8

# エリア基準（立地のベース＆値上がり率が無い棟の資産性フォールバックにのみ使用）
AREA_BASE = {
    "豊洲": {"loc": 82, "asset": 80}, "東雲": {"loc": 62, "asset": 66},
    "有明": {"loc": 60, "asset": 64}, "晴海": {"loc": 68, "asset": 74},
    "勝どき": {"loc": 82, "asset": 80}, "月島": {"loc": 80, "asset": 76},
    "港南": {"loc": 88, "asset": 82}, "辰巳": {"loc": 58, "asset": 58},
    "佃": {"loc": 80, "asset": 74},
}
DEFAULT_BASE = {"loc": 66, "asset": 66}
SEIS_BONUS = {"免震": 8, "制震": 4, "耐震": 0}
FAC_KEYS = ["プール", "ジム", "バー", "サウナ", "コンビニ", "内廊下", "オール電化"]


# ---------------------------------------------------------------- helpers
def clamp(v, lo=35, hi=98):
    return max(lo, min(hi, int(round(v))))


def to_int(s):
    d = re.sub(r"[^0-9]", "", s or "")
    return int(d) if d else None


def to_float(s):
    d = re.sub(r"[^0-9.]", "", s or "")
    try:
        return float(d) if d else None
    except ValueError:
        return None


def year_of(s):
    s = (s or "").strip().split("/")[0]
    return int(s) if s.isdigit() and len(s) == 4 else None


def ym_of(s):
    p = (s or "").strip().split("/")
    if len(p) >= 2 and p[0].isdigit() and p[1].isdigit():
        return int(p[0]) * 12 + int(p[1])
    return None


def mean(xs):
    return sum(xs) / len(xs)


def norm(s):
    """物件名の表記揺れ吸収（全角/半角・中黒・空白）"""
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", s or "")).strip()


def truthy(v):
    try:
        return float(v) == 1
    except (TypeError, ValueError):
        return str(v).strip() in ("○", "有", "TRUE", "True", "yes", "Yes")


def serial_year(v):
    """Excelシリアル日付 -> 西暦年"""
    try:
        n = int(float(v))
    except (TypeError, ValueError):
        return None
    if n < 10000:
        return None
    return (datetime.date(1899, 12, 30) + datetime.timedelta(days=n)).year


def parse_station(s):
    m = re.search(r"「(.+?)」", s or "")
    return m.group(1) if m else (s or "").strip()


def moving_avg_price(rec, anchor_ym):
    """坪単価＝直近3ヶ月の成約坪単価の移動平均（1取引1票＝単純平均）。
    成約が無い棟のみ窓を6→12→24ヶ月へ拡大。win=None は全期間。"""
    for win in (3, 6, 12, 24):
        lo = anchor_ym - (win - 1)
        sel = [t for _, ym, t, _ in rec if ym and ym >= lo]
        if sel:
            return round(mean(sel)), win, len(sel)
    allt = [t for _, _, t, _ in rec]
    return round(mean(allt)), None, len(allt)


# ----------------------------------------------------------- 取得（読み取り専用）
def _fetch(url, dest, min_bytes=2000):
    """一時ファイルに取得し、サイズ検証後に原子的に差し替え（失敗時は既存を維持）"""
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + ".tmp"
    urllib.request.urlretrieve(url, tmp)
    if os.path.getsize(tmp) < min_bytes:
        os.remove(tmp)
        raise ValueError(f"取得サイズ異常（公開設定/URLを確認）: {url}")
    os.replace(tmp, dest)


def ensure_files(force=False):
    """force=True なら最新を取り直す（更新反映用）。読み取りのみでシートは編集しない。"""
    if force or not os.path.exists(CSV_PATH):
        print("主DB(成約CSV)を取得…")
        _fetch(TX_CSV_URL, CSV_PATH)
    if force or not os.path.exists(SPEC_XLSX):
        print("従DB(スペックxlsx)を取得…")
        _fetch(SPEC_XLSX_URL, SPEC_XLSX, min_bytes=20000)


# ----------------------------------------------------------- 従DB（xlsx）読み込み
_Q = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def _xlsx_sheets(path):
    z = zipfile.ZipFile(path)
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        t = ET.fromstring(z.read("xl/sharedStrings.xml"))
        for si in t.findall(_Q + "si"):
            shared.append("".join((n.text or "") for n in si.iter(_Q + "t")))

    def col_idx(ref):
        s = re.match(r"([A-Z]+)", ref).group(1)
        i = 0
        for c in s:
            i = i * 26 + (ord(c) - 64)
        return i - 1

    for name in z.namelist():
        if not re.match(r"xl/worksheets/sheet\d+\.xml$", name):
            continue
        t = ET.fromstring(z.read(name))
        rows = []
        for row in t.iter(_Q + "row"):
            d, mx = {}, -1
            for c in row.findall(_Q + "c"):
                j = col_idx(c.get("r"))
                ty = c.get("t")
                v = c.find(_Q + "v")
                val = ""
                if ty == "s" and v is not None:
                    val = shared[int(v.text)]
                elif v is not None:
                    val = v.text
                d[j] = val
                mx = max(mx, j)
            rows.append([d.get(i, "") for i in range(mx + 1)])
        yield rows


def read_spec():
    """従DBの「検索・ソート情報」を {正規化名: specdict} で返す"""
    spec_rows = None
    for rows in _xlsx_sheets(SPEC_XLSX):
        h = rows[0] if rows else []
        if "駅徒歩" in h and any("プール" in (c or "") for c in h):
            spec_rows = rows
            break
    if not spec_rows:
        print("⚠ 従DBのスペックシートが見つかりません")
        return {}

    hdr = spec_rows[0]
    idx = {h: i for i, h in enumerate(hdr)}

    def g(row, key):
        i = idx.get(key)
        return row[i] if (i is not None and i < len(row)) else ""

    out = {}
    for r in spec_rows[1:]:
        name = (g(r, "物件名") or "").strip()
        if not name or name == "平均":
            continue
        built = serial_year(g(r, "築年月日"))
        floors = to_int(re.search(r"(\d+)階建", g(r, "耐震構造") or "").group(1)) if re.search(r"(\d+)階建", g(r, "耐震構造") or "") else None
        seis_raw = g(r, "耐震") or ""
        seismic = "免震" if "免震" in seis_raw else ("制震" if ("制震" in seis_raw or "制振" in seis_raw) else ("耐震" if seis_raw else None))
        fac = {
            "プール": truthy(g(r, "プール有")), "ジム": truthy(g(r, "ジム有")),
            "バー": truthy(g(r, "バー有（カフェ含む）")), "サウナ": truthy(g(r, "サウナ")),
            "コンビニ": truthy(g(r, "コンビニ")), "内廊下": truthy(g(r, "内廊下")),
            "オール電化": truthy(g(r, "オール電化")),
        }
        out[norm(name)] = {
            "modelName": (g(r, "モデル名") or "").strip() or None,
            "address": (g(r, "住所") or "").strip(),
            "station": parse_station(g(r, "最寄駅")),
            "stationFull": (g(r, "最寄駅") or "").strip(),
            "walkMin": to_int(g(r, "駅徒歩")),
            "builtYear": built,
            "ageYears": (THIS_YEAR - built) if built else None,
            "seismic": seismic,
            "floors": floors,
            "totalUnits": to_int(g(r, "総戸数")),
            "school": (g(r, "学区") or "").strip(),
            "facilities": fac,
        }
    return out


# ----------------------------------------------------------- 主DB（成約CSV）読み込み
def load_tx_rows():
    with open(CSV_PATH, encoding="utf-8") as f:
        rows = list(csv.reader(f))
    return [r for r in rows[2:] if len(r) > C_TSUBO and r[C_NAME].strip()]


# ----------------------------------------------------------- スコア算出
def score_fac(fac):
    amen = [k for k in ["プール", "ジム", "バー", "サウナ", "コンビニ", "内廊下"] if fac.get(k)]
    return clamp(38 + 10 * len(amen) + (6 if fac.get("プール") else 0))


def score_loc(area, walk):
    base = AREA_BASE.get(area, DEFAULT_BASE)["loc"]
    return clamp(base + (10 - walk) * 1.6) if walk else clamp(base)


def score_liv(built, seismic, fac, fac_score):
    base = 58 + ((built or 2010) - 2008) * 0.9 + SEIS_BONUS.get(seismic, 2)
    base += 5 if fac.get("内廊下") else 0
    base += 3 if fac.get("オール電化") else 0
    base += fac_score * 0.06
    return clamp(base)


# ----------------------------------------------------------- 構築
def build():
    spec_map = read_spec()
    rows = load_tx_rows()
    per = defaultdict(lambda: {"rec": [], "area": Counter(), "layout": Counter()})
    max_ym = 0
    for r in rows:
        name = r[C_NAME].strip()
        tsubo = to_int(r[C_TSUBO])
        sqm = to_float(r[C_SQM])
        if tsubo is None or tsubo < 80 or tsubo > 2000:
            continue
        ym = ym_of(r[C_DATE])
        per[name]["rec"].append((year_of(r[C_DATE]), ym, tsubo, sqm))
        if ym:
            max_ym = max(max_ym, ym)
        if r[C_AREA].strip():
            per[name]["area"][r[C_AREA].strip()] += 1
        if r[C_LAYOUT].strip():
            per[name]["layout"][r[C_LAYOUT].strip()] += 1

    mansions = []
    for name, d in per.items():
        rec = d["rec"]
        if len(rec) < 10:
            continue
        area = d["area"].most_common(1)[0][0] if d["area"] else "湾岸"
        tsubos = [t for _, _, t, _ in rec]
        years = [y for y, _, _, _ in rec if y]
        sqms = [s for _, _, _, s in rec if s]
        y_max, y_min = (max(years), min(years)) if years else (None, None)

        tsubo_now, win_months, tx_in_win = moving_avg_price(rec, max_ym)
        tsubo_all = round(mean(tsubos))

        trend_pct = None
        if y_min and y_max and (y_max - y_min) >= 3:
            early = [t for y, _, t, _ in rec if y <= y_min + 1]
            late = [t for y, _, t, _ in rec if y >= y_max - 1]
            if early and late and statistics.median(early):
                trend_pct = round((statistics.median(late) / statistics.median(early) - 1) * 100, 1)

        median_sqm = round(statistics.median(sqms), 1) if sqms else None
        rep_layout = d["layout"].most_common(1)[0][0] if d["layout"] else ""

        sp = spec_map.get(norm(name), {})
        fac = sp.get("facilities", {k: False for k in FAC_KEYS})

        fac_score = score_fac(fac)
        loc_score = score_loc(area, sp.get("walkMin"))
        liv_score = score_liv(sp.get("builtYear"), sp.get("seismic"), fac, fac_score)
        asset_score = clamp(55 + trend_pct * 0.45) if trend_pct is not None else clamp(AREA_BASE.get(area, DEFAULT_BASE)["asset"])
        size_score = clamp(38 + ((median_sqm or 60) - 45) * 1.0)

        mansions.append({
            "name": name, "area": area,
            # 主DB（成約）由来
            "tsuboPrice": tsubo_now, "tsuboWindowMonths": win_months, "txInWindow": tx_in_win,
            "tsuboAll": tsubo_all, "trendPct": trend_pct, "txCount": len(rec),
            "medianSqm": median_sqm, "repLayout": rep_layout,
            "yearMin": y_min, "yearMax": y_max,
            # 従DB（スペック）由来
            "station": sp.get("station"), "walkMin": sp.get("walkMin"),
            "builtYear": sp.get("builtYear"), "ageYears": sp.get("ageYears"),
            "seismic": sp.get("seismic"), "floors": sp.get("floors"),
            "totalUnits": sp.get("totalUnits"), "address": sp.get("address"),
            "modelName": sp.get("modelName"),
            "photoUrl": (PHOTO_BASE + sp["modelName"] + ".jpg") if sp.get("modelName") else None,
            "facilities": {k: bool(fac.get(k)) for k in FAC_KEYS},
            "specsPending": not sp,
            "scores": {"liv": liv_score, "asset": asset_score, "fac": fac_score,
                       "loc": loc_score, "size": size_score},
            "realFields": ["tsuboPrice", "trendPct", "txCount", "medianSqm", "repLayout",
                           "station", "walkMin", "builtYear", "seismic", "totalUnits",
                           "facilities", "photoUrl", "scores.asset", "scores.size",
                           "scores.fac", "scores.loc", "scores.liv"],
        })

    mansions.sort(key=lambda m: (m["area"], -m["tsuboPrice"]))
    for i, m in enumerate(mansions, 1):
        m["id"] = f"WM{i:03d}"
    return mansions, max_ym, spec_map


def _payload(mansions, max_ym):
    anchor = f"{max_ym // 12}/{max_ym % 12 or 12:02d}"
    return {
        "_note": "坪単価/資産性/広さ/取引件数 は主DB(成約)、駅徒歩/築年/耐震/総戸数/共用施設 は従DB(スペック)の実データ。"
                 "5軸スコアは両DBの実データから算出。スプレッドシートは読み取りのみで未編集。",
        "source": "real",
        "priceMethod": "直近3ヶ月の成約坪単価の移動平均（1取引1票＝単純平均）",
        "priceAnchor": anchor,
        "dataYearMax": max_ym // 12,
        "generatedAt": datetime.datetime.now().isoformat(timespec="seconds"),
        "count": len(mansions),
        "mansions": mansions,
    }


def rebuild_and_save(force_fetch=False):
    """スプレッドシートを（必要なら取り直して）再集計し data/mansions.json を更新。payload を返す。
    サーバの自動更新・手動更新からも呼ばれる。失敗時は例外を投げ、呼び元が旧データを維持する。"""
    ensure_files(force=force_fetch)
    mansions, max_ym, _ = build()
    payload = _payload(mansions, max_ym)
    tmp = OUT_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    os.replace(tmp, OUT_PATH)   # 原子的に差し替え
    return payload


def main():
    payload = rebuild_and_save(force_fetch=False)
    mansions = payload["mansions"]
    joined = sum(1 for m in mansions if not m["specsPending"])
    print(f"wrote {len(mansions)} mansions / 従DB結合 {joined}/{len(mansions)} / 基準月={payload['priceAnchor']} -> {OUT_PATH}")
    for m in sorted(mansions, key=lambda x: -x["txCount"])[:6]:
        fac = "・".join(k for k, v in m["facilities"].items() if v) or "なし"
        print(f"  {m['name']}（{m['area']}）坪{m['tsuboPrice']} 徒歩{m['walkMin']}分 築{m['ageYears']}年 "
              f"{m['seismic']} {m['totalUnits']}戸 / 施設:{fac}")


if __name__ == "__main__":
    main()
