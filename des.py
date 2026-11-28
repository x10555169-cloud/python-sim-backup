"""用經驗分布（Empirical Distribution）模擬產線：以「已完成」的實際加工時間，預測產線表現、比較不同方案。

跟 simulation.py 的差別：
  simulation.py  統計分析：把「已經發生」的紀錄整理成 CT、瓶頸、產線 Cycle Time
  des.py         模擬：每站的加工時間用經驗分布產生，讓電腦依流程「假裝生產」很多次，預測結果

一、加工時間：經驗分布（不假設常態、指數等理論分布，直接用實際資料的分布）
  連續型（預設，Law & Kelton 的分段線性經驗分布）
      把 n 筆資料由小到大排好 x(1)…x(n)，相鄰兩點之間用直線連成累積分布；
      抽樣（反函數法）：U ~ 均勻(0,1)，P = (n−1)U，I = ⌊P⌋ + 1，
                        加工時間 = x(I) + (P − I + 1) × (x(I+1) − x(I))
      → 會產生資料點「之間」的值，資料少時比只重抽原始值合理；不會超出最小～最大值
  離散型（重抽樣）  每筆資料被抽中的機率都是 1/n，只會抽到出現過的值
  固定平均值        每件都用平均值（沒有波動，給教學比較用）

二、資料來源（只用 status = COMPLETED 的已完成資料，而且只用本組）：實務上每站至少 30 筆、最好 100 筆以上，
  但一場只做 3～6 張椅子，所以可以選擇加入本組之前場次的資料：
  round   只用本場（即時：做完幾件就用幾筆）
  group   本場 + 本組「流程相同」的其他場次
  auto30  自動補到 30 筆：本場不夠時，依序加入本組「流程相同」的其他場次（場次近的優先），加到 30 筆為止
  流程相同 = 兩場的工站連線（station_flow）完全一樣。不同場次可以有不同流程，流程不同時，
  同一個工站編號做的事情可能不一樣（例如前站不同、組裝的零件不同），所以不加入。
  任一場沒有設定流程時，無法確認相同，也不加入。

三、產線模型（每一組 + 每一個場次）：
  工站與流程   station_flow（同老師的候選順序 T3 → T2 → T1 → 組別）；沒有流程時：
               有 ST09 → 老師網頁預設的 9 站組裝流程；否則依工站編號串聯
  合流（組裝） 有好幾個前站的工站，要每個前站各送來 1 件才能開工（齊套）
  起點站       原料無限，最多投入 N 件（N = 要生產的組數）
  站前在製品   每站前面的緩衝區（前站做好、本站還沒拿的半成品），每一站可以分別設定：
               上限       = station_wip 的「ST05_LIMIT」，沒設定用 2（同老師網頁）；可改成不限制
               開始時件數 = 0（空的產線開始）；可在進階設定手動填。
                            不讀 station_wip「ST05」列的 input_wip：那是生產時掃碼留下的計數（做完後的狀態），
                            當成開始時件數會讓產線一開始就塞滿
  阻塞         做完時下一站的緩衝區滿了 → 拿著成品等（佔住人手），直到有空位
  人數         每站幾個人（同時能做幾件），預設 1
  結束         終點站完成 N 組
  一次模擬 = 一次假想的生產（事件驅動：時間直接跳到下一個「某站做完」的時刻）；
  重複 R 次（亂數不同），取平均與 90% 範圍（第 5～95 百分位）。

只用 Python 內建模組，可以在瀏覽器（Pyodide）裡執行。
"""
from __future__ import annotations

import heapq
import random
from collections import defaultdict, deque

from simulation import analyze_line, edges_of, flow_for, round_label, round_of, round_sort_key, terminal_station

DEFAULT_WIP_LIMIT = 2
MIN_SAMPLES = 30     # 實務起點
GOOD_SAMPLES = 100   # 理想
DEFAULT_FLOW_9 = [("ST01", "ST05"), ("ST02", "ST05"), ("ST03", "ST06"), ("ST04", "ST06"),
                  ("ST05", "ST07"), ("ST06", "ST07"), ("ST07", "ST08"), ("ST08", "ST09")]
SOURCE_LABEL = {"round": "只用本場已完成資料", "group": "本場 + 本組流程相同的場次",
                "auto30": f"自動補到 {MIN_SAMPLES} 筆（本組流程相同的場次，近的優先）"}


# ---------------------------------------------------------------- 1. 經驗分布
def empirical_continuous(sorted_vals: list[float], u: float) -> float:
    """連續型經驗分布（分段線性）的反函數：u ∈ [0,1) → 加工時間。sorted_vals 要先由小到大排好。"""
    n = len(sorted_vals)
    if n == 1:
        return sorted_vals[0]
    p = (n - 1) * u
    i = min(int(p), n - 2)          # 程式的索引從 0 開始：i = I − 1
    return sorted_vals[i] + (p - i) * (sorted_vals[i + 1] - sorted_vals[i])


def empirical_discrete(vals: list[float], u: float) -> float:
    """離散型經驗分布（重抽樣）：每筆機率 1/n。"""
    return vals[min(int(u * len(vals)), len(vals) - 1)]


def level_of(n: int) -> dict:
    """資料量等級：<10 僅供參考、10~29 初步、30 以上達實務起點、100 以上理想"""
    if n >= GOOD_SAMPLES:
        return {"code": "best", "label": f"≥{GOOD_SAMPLES} 理想"}
    if n >= MIN_SAMPLES:
        return {"code": "ok", "label": f"≥{MIN_SAMPLES} 實務起點"}
    if n >= 10:
        return {"code": "low", "label": "10~29 初步參考"}
    return {"code": "few", "label": "<10 僅供參考"}


def _quart(v: list[float]) -> dict:
    v = sorted(v)
    q = lambda p: round(empirical_continuous(v, p), 1) if v else None   # 分位數也用分段線性
    return {"n": len(v), "mean": round(sum(v) / len(v), 1) if v else None, "min": v[0] if v else None,
            "p25": q(0.25), "median": q(0.5), "p75": q(0.75), "max": v[-1] if v else None}


# ---------------------------------------------------------------- 2. 建立模型
def _durations(rows: list[dict], station: str) -> list[float]:
    out = []
    for r in rows:
        if (r.get("station_id") or "").strip() == station:
            try:
                d = float(r.get("duration_sec") or 0)
            except (TypeError, ValueError):
                d = 0
            if d > 0:
                out.append(d)
    return out


def build_model(events: list[dict], flows: list[dict], limits: list[dict], group: str, rnd: str,
                source: str = "round") -> dict:
    """從資料庫的資料建立某組某場次的模型（工站、流程、各站經驗分布、緩衝區上限、實際結果）。"""
    source = source if source in SOURCE_LABEL else ("group" if source == "class" else "round")
    done = [e for e in events if (e.get("status") or "COMPLETED") == "COMPLETED"]
    mine = [e for e in done if (e.get("group_id") or "").strip() == group]          # 只用本組
    rows = [e for e in mine if round_of(e.get("product_id")) == rnd]               # 本場
    if not rows:
        return {"ok": False, "error": f"{group} {round_label(rnd)} 還沒有完工紀錄，無法建立模型"}

    flows_by_key: dict[str, list[dict]] = defaultdict(list)
    for f in flows or []:
        flows_by_key[(f.get("group_id") or "").strip()].append(f)
    key, flow = flow_for(flows_by_key, group, rnd)
    real_edges = edges_of(flow)
    with_data = sorted({(r.get("station_id") or "").strip() for r in rows if _durations([r], (r.get("station_id") or "").strip())})

    if real_edges:
        edges = [(a, b) for a, b in real_edges if b]
        flow_src = f"老師設定的流程（station_flow：{key}）"
    elif "ST09" in with_data:
        edges = list(DEFAULT_FLOW_9)
        flow_src = "沒有設定流程 → 用老師網頁預設的 9 站組裝流程"
    else:
        edges = list(zip(with_data, with_data[1:]))
        flow_src = "沒有設定流程 → 依工站編號串聯"
    nodes = sorted({a for a, _ in edges} | {b for _, b in edges} | (set() if edges else set(with_data)))
    preds = {s: sorted(a for a, b in edges if b == s) for s in nodes}
    succs = {s: sorted(b for a, b in edges if a == s) for s in nodes}
    terminal = terminal_station([(a, b) for a, b in edges] + [(s, "") for s in nodes if not succs[s]])

    # 本組其他場次：只有「流程跟本場完全相同」的才可以加入（場次近的排前面）
    my_sig = _flow_signature(real_edges)
    other_rounds = sorted({round_of(e.get("product_id")) for e in mine} - {rnd},
                          key=lambda r: (abs(round_sort_key(r) - round_sort_key(rnd)), round_sort_key(r)))
    rounds_info = []
    for r in other_rounds:
        k_r, f_r = flow_for(flows_by_key, group, r)
        sig_r = _flow_signature(edges_of(f_r))
        if not my_sig:
            same, why = False, "本場沒有設定流程，無法確認相同"
        elif not sig_r:
            same, why = False, "這一場沒有設定流程，無法確認相同"
        elif sig_r == my_sig:
            same, why = True, f"流程相同（{k_r}）"
        else:
            same, why = False, f"流程不同（{k_r}：{_flow_text(edges_of(f_r))}）"
        r_rows = [e for e in mine if round_of(e.get("product_id")) == r]
        rounds_info.append({"round": r, "label": round_label(r), "same_flow": same, "reason": why, "records": len(r_rows), "rows": r_rows})
    usable = [ri for ri in rounds_info if ri["same_flow"]]

    # 各站的經驗分布資料：本場 + 依「資料來源」加入的場次
    times: dict[str, list[float]] = {}
    stations = []
    lim = _wip_limits(limits, group, rnd)
    init: dict[str, int] = {}                          # 開始時站前在製品：預設 0（空的產線）
    for s in nodes:
        own = _durations(rows, s)
        added, used = [], ["本場"]
        if source in ("group", "auto30"):
            for ri in usable:                                   # 場次近的先加
                if source == "auto30" and len(own) + len(added) >= MIN_SAMPLES:
                    break                                       # 自動補：已經夠 30 筆就不再加
                d = _durations(ri["rows"], s)
                if d:
                    added += d
                    used.append(ri["label"])
        pool = own + added
        times[s] = sorted(pool)
        o, a = _quart(own), _quart(added)
        diff = (abs(a["mean"] - o["mean"]) / o["mean"] * 100) if own and added and o["mean"] else None
        stations.append({
            "station": s, "preds": preds[s], "succs": succs[s],
            "own": o, "added": a, "pool": _quart(pool), "used": used,
            "level": level_of(len(pool)),
            "diff_pct": round(diff, 0) if diff is not None else None,
            "diff_warn": diff is not None and diff > 30 and len(own) >= 3,   # 流程相同但平均差超過 30%：可能做法改了，提醒確認
            "no_data": not pool,
            "wip_limit_in": lim.get(s, DEFAULT_WIP_LIMIT) if preds[s] else None,
            "init_wip_in": init.get(s, 0) if preds[s] else None,
            "cdf": [round(x, 1) for x in sorted(pool)] if len(pool) <= 300 else
                   [round(empirical_continuous(sorted(pool), i / 100), 1) for i in range(101)],
        })
    # 完全沒有資料的工站（流程有、但還沒做到、也沒有可加入的資料）：暫用全部資料中位數
    all_t = sorted(t for v in times.values() for t in v)
    median = all_t[len(all_t) // 2] if all_t else 1.0
    missing = [s for s in nodes if not times[s]]
    for s in missing:
        times[s] = [median]

    actual = analyze_line(rows, real_edges)
    return {
        "ok": True, "group_id": group, "round": rnd, "round_label": round_label(rnd),
        "source": source, "source_label": SOURCE_LABEL[source],
        "flow_source": flow_src, "edges": [list(e) for e in edges], "terminal": terminal,
        "roots": [s for s in nodes if not preds[s]], "stations": stations, "times": times,
        "wip_limits": {s: lim.get(s, DEFAULT_WIP_LIMIT) for s in nodes if preds[s]},
        "wip_limit_source": "station_wip 的 _LIMIT 設定" if lim else f"沒有設定 → 預設 {DEFAULT_WIP_LIMIT}",
        "init_wip": {s: init.get(s, 0) for s in nodes if preds[s]},
        "init_wip_source": "從空的產線開始（各站前 0 件）；可在進階設定手動填",
        "missing_data": missing, "ignored_stations": [s for s in with_data if s not in nodes],
        "other_rounds": [{k: v for k, v in ri.items() if k != "rows"} for ri in rounds_info],   # 本組其他場次：能不能加入、原因
        "min_samples": min((len(times[s]) for s in nodes if s not in missing), default=0),
        "actual": {k: actual[k] for k in ("output_sets", "total_sec", "takt_sec", "steady_sec", "bottleneck",
                                          "bottleneck_ct", "terminal_reached", "output_station", "events")},
    }


def _flow_signature(edges: list[tuple[str, str]]) -> tuple:
    """流程的「指紋」：（所有「工站 → 下一站」連線, 所有工站）；順序不影響，終點站有沒有單獨寫一列也不影響。
    沒有流程 = 空的"""
    links = frozenset((a, b) for a, b in edges if a and b)
    stations = frozenset({a for a, _ in edges if a} | {b for _, b in edges if b})
    return (links, stations) if stations else ()


def _flow_text(edges: list[tuple[str, str]]) -> str:
    return "、".join(f"{a}→{b}" for a, b in sorted(edges) if b) or "無"


def _wip_limits(limits: list[dict], group: str, rnd: str) -> dict[str, int]:
    """station_wip 的「ST05_LIMIT」= 送進 ST05 的緩衝區上限（同老師網頁 ApiFlow；0 或空白 = 沒設定）"""
    lim: dict[str, int] = {}
    for want in (f"{group}-OFFICIAL" if rnd == "FORMAL" else f"{group}-T{rnd[4:]}", group):
        for r in limits or []:
            sid = (r.get("station_id") or "").strip()
            if (r.get("group_id") or "").strip() == want and sid.endswith("_LIMIT"):
                try:
                    v = int(float(r.get("input_wip")))
                except (TypeError, ValueError):
                    v = 0
                lim.setdefault(sid[:-6], v if v > 0 else DEFAULT_WIP_LIMIT)
        if lim:
            break
    return lim


# ---------------------------------------------------------------- 3. 模擬引擎（一次假想的生產）
class LineSim:
    """事件驅動：時間直接跳到下一個「某站做完」的時刻，在那一刻更新所有狀態。"""

    def __init__(self, model: dict, n_sets: int, rng: random.Random, factor: dict, servers: dict,
                 cap: dict, mode: str, init: dict | None = None, record: bool = False, line_cap: int | None = None):
        self.m, self.n, self.rng, self.mode = model, n_sets, rng, mode
        self.nodes = [s["station"] for s in model["stations"]]
        self.preds = {s["station"]: s["preds"] for s in model["stations"]}
        self.succs = {s["station"]: s["succs"] for s in model["stations"]}
        self.term = model["terminal"]
        self.times = model["times"]
        self.mean = {s: sum(v) / len(v) for s, v in self.times.items()}
        self.factor = {s: factor.get(s, 1.0) for s in self.nodes}
        self.k = {s: max(1, int(servers.get(s, 1))) for s in self.nodes}
        self.cap = cap                                     # cap[下一站] = 上限；None = 不限制
        self.buf = {(a, b): 0 for a, b in model["edges"]}   # 站間緩衝區目前件數
        self.busy = defaultdict(int)                        # 正在加工的件數
        self.blocked: dict[str, deque] = defaultdict(deque)  # 做完但送不出去的件（記下開始等的時間）
        self.released = defaultdict(int)                    # 起點站已投入件數
        self.proc_time = defaultdict(float)                 # 各站加工時間合計
        self.block_time = defaultdict(float)                # 各站阻塞時間合計
        self.done_times: list[float] = []
        self.heap: list[tuple[float, int, str]] = []
        self.seq = 0
        self.t = 0.0
        self.buf_area = defaultdict(float)
        self.buf_max = defaultdict(int)
        self.last_t = 0.0
        # 站前在製品：每一件半成品放進緩衝區的時刻（先進先出），用來算「在站前等了多久」
        self.arr: dict[tuple, deque] = {e: deque() for e in self.buf}
        self.wait_sum = defaultdict(float)                  # 各站前半成品等待時間合計
        self.wait_n = defaultdict(int)                      # 各站拿走幾件
        for v, k in (init or {}).items():                   # 開始時站前已經有 k 件（合流站：每個前站各 k 件 = k 套）
            for p in self.preds.get(v, []):
                self.buf[(p, v)] = int(k)
                self.buf_max[(p, v)] = int(k)
                self.arr[(p, v)].extend([0.0] * int(k))
        self.st_max = {v: self.st_wip(v) for v in self.nodes if self.preds[v]}
        self.record = record                                # 只有第 1 次模擬記錄在製品隨時間的變化（畫圖用）
        self.timeline = {v: [(0.0, self.st_wip(v))] for v in self.nodes if self.preds[v]} if record else None
        # 甘特圖（只有第 1 次模擬記錄）：每一件在每一站「開始、結束、第幾件」，以及阻塞（做完送不出去）的時段
        self.gantt_jobs: list[tuple[str, float, float, int]] = []
        self.gantt_blk: list[tuple[str, float, float]] = []
        self.count = defaultdict(int)                       # 各站開工的第幾件
        # 產線 WIP 上限（CONWIP）：整條線「已投入、還沒在終點做完」的件數到上限，起點站就先停，等終點做完一件再投入
        #   每個起點站分開算：這站投入的件數 + 開始時就放在它下游站前的件數 − 終點已完成組數
        self.line_cap = line_cap if line_cap and line_cap > 0 else None
        self.roots = [v for v in self.nodes if not self.preds[v]]
        self.init_on: dict[str, int] = {}
        for r in self.roots:
            down, stack = set(), [r]                        # r 的所有下游站
            while stack:
                for v in self.succs[stack.pop()]:
                    if v not in down:
                        down.add(v); stack.append(v)
            self.init_on[r] = sum(int((init or {}).get(v, 0)) * sum(1 for p in self.preds[v] if p == r or p in down)
                                  for v in down)
        self.line_area, self.line_last, self.line_max = 0.0, 0.0, self.line_wip()
        self.line_tl = [(0.0, self.line_max)] if record else None

    def line_wip(self) -> int:
        """整條產線目前的在製品件數（已投入、還沒在終點做完）"""
        if not self.roots:
            return 0
        return max(self.released[r] + self.init_on[r] for r in self.roots) - len(self.done_times)

    def _line_note(self, before: int) -> None:              # 產線 WIP 變了：累計時間加權、最多件數、時間軸
        self.line_area += before * (self.t - self.line_last)
        self.line_last = self.t
        w = self.line_wip()
        self.line_max = max(self.line_max, w)
        if self.record:
            self.line_tl.append((self.t, w))

    def st_wip(self, v: str) -> int:
        """v 站前的在製品件數 = 每個前站送來、還沒被拿走的件數加總"""
        return sum(self.buf[(p, v)] for p in self.preds[v])

    def _note(self, v: str) -> None:                        # v 站前在製品有變化：更新最多件數、記錄時間軸
        w = self.st_wip(v)
        self.st_max[v] = max(self.st_max[v], w)
        if self.record:
            self.timeline[v].append((self.t, w))

    def sample(self, s: str) -> float:
        """從這站的經驗分布抽一個加工時間，再乘上作業時間倍率"""
        if self.mode == "mean":
            base = self.mean[s]
        elif self.mode == "disc":
            base = empirical_discrete(self.times[s], self.rng.random())
        else:
            base = empirical_continuous(self.times[s], self.rng.random())
        return max(0.001, base * self.factor[s])

    def _acc(self) -> None:                                 # 緩衝區件數 × 經過時間（算時間加權平均 WIP）
        dt = self.t - self.last_t
        if dt > 0:
            for e, q in self.buf.items():
                self.buf_area[e] += q * dt
            self.last_t = self.t

    def _has_space(self, s: str) -> bool:
        return all(self.cap.get(v) is None or self.buf[(s, v)] < self.cap[v] for v in self.succs[s])

    def _push(self, s: str) -> None:                        # 做好的件放進每個下一站的緩衝區
        self._acc()
        for v in self.succs[s]:
            self.buf[(s, v)] += 1
            self.buf_max[(s, v)] = max(self.buf_max[(s, v)], self.buf[(s, v)])
            self.arr[(s, v)].append(self.t)
            self._note(v)
        for v in self.succs[s]:
            self.try_start(v)

    def try_start(self, s: str) -> None:
        if len(self.done_times) >= self.n:                         # 已經完成 N 組：不再開新的工作
            return
        while self.busy[s] + len(self.blocked[s]) < self.k[s]:      # 還有空的人手
            if not self.preds[s]:                                  # 起點站：原料無限，最多投入 N 件
                if self.released[s] >= self.n:
                    return
                if self.line_cap and self.released[s] + self.init_on[s] - len(self.done_times) >= self.line_cap:
                    return                                         # 產線 WIP 已到上限：等終點做完一件
                before = self.line_wip()
                self.released[s] += 1
                self._line_note(before)
            else:                                                  # 齊套：每個前站都要有 1 件
                if any(self.buf[(p, s)] < 1 for p in self.preds[s]):
                    return
                self._acc()
                for p in self.preds[s]:
                    self.buf[(p, s)] -= 1
                    self.wait_sum[s] += self.t - self.arr[(p, s)].popleft()   # 這件在站前等了多久
                    self.wait_n[s] += 1
                self._note(s)
            d = self.sample(s)
            self.count[s] += 1
            if self.record:
                self.gantt_jobs.append((s, self.t, self.t + d, self.count[s]))
            self.proc_time[s] += d
            self.busy[s] += 1
            self.seq += 1
            heapq.heappush(self.heap, (self.t + d, self.seq, s))
            for p in self.preds[s]:                                # 緩衝區空出位置 → 上游被擋住的件可以送出
                self.try_unblock(p)

    def try_unblock(self, s: str) -> None:
        while self.blocked[s] and self._has_space(s):
            t0 = self.blocked[s].popleft()
            self.block_time[s] += self.t - t0
            if self.record and self.t > t0:
                self.gantt_blk.append((s, t0, self.t))
            self._push(s)
        self.try_start(s)

    def finish(self, s: str) -> None:
        self.busy[s] -= 1
        if s == self.term:
            before = self.line_wip()
            self.done_times.append(self.t)
            self._line_note(before)
            if self.line_cap:                                      # 空出一個名額 → 起點站可以再投入
                for r in self.roots:
                    self.try_start(r)
        elif self.succs[s]:
            if self._has_space(s):
                self._push(s)
            else:
                self.blocked[s].append(self.t)                     # 下一站滿了：拿著等
        self.try_start(s)

    def run(self) -> dict:
        for s in self.nodes:
            self.try_start(s)
        while self.heap and len(self.done_times) < self.n:
            t, _, s = heapq.heappop(self.heap)
            self.t = t
            self.finish(s)
        end = self.t
        self._acc()
        for tf, _, s in self.heap:                                 # 結束時還在加工的件：超過結束時間的部分不算
            self.proc_time[s] -= max(0.0, tf - end)
        for s, q in self.blocked.items():
            for t0 in q:
                self.block_time[s] += end - t0
                if self.record and end > t0:
                    self.gantt_blk.append((s, t0, end))
        stats = {}
        for s in self.nodes:
            cap_time = self.k[s] * end if end > 0 else 1.0
            util = self.proc_time[s] / cap_time
            blk = self.block_time[s] / cap_time
            stats[s] = {"util": util, "blocked": blk, "starved": max(0.0, 1 - util - blk)}
            if self.preds[s]:                                       # 站前在製品：時間加權平均、最多、結束時、平均等待
                stats[s].update({
                    "wip_avg": sum(self.buf_area[(p, s)] for p in self.preds[s]) / end if end > 0 else 0.0,
                    "wip_max": self.st_max[s], "wip_end": self.st_wip(s),
                    "wait_avg": self.wait_sum[s] / self.wait_n[s] if self.wait_n[s] else None})
        return {
            "finished": len(self.done_times), "makespan": end,
            "first_out": self.done_times[0] if self.done_times else None,
            "done_times": self.done_times,
            "stations": stats,
            "buffers": {f"{a}→{b}": {"avg": (self.buf_area[(a, b)] / end) if end > 0 else 0,
                                     "max": self.buf_max[(a, b)]} for a, b in self.buf},
            "timeline": ({v: pts + [(end, pts[-1][1])] for v, pts in self.timeline.items()} if self.record else None),
            "line": {"avg": (self.line_area + self.line_wip() * (end - self.line_last)) / end if end > 0 else 0.0,
                     "max": self.line_max,
                     "timeline": (self.line_tl + [(end, self.line_tl[-1][1])]) if self.record else None},
            "gantt": ({"end": end,
                       "jobs": [(s, a, min(b, end), k) for s, a, b, k in self.gantt_jobs if a < end],   # 結束時還在做的件，畫到結束為止
                       "blocked": list(self.gantt_blk)} if self.record else None),
        }


# ---------------------------------------------------------------- 4. 重複模擬、統計
def _q(vals: list[float], p: float) -> float:
    v = sorted(vals)
    if not v:
        return 0.0
    i = (len(v) - 1) * p
    lo, hi = int(i), min(int(i) + 1, len(v) - 1)
    return v[lo] + (v[hi] - v[lo]) * (i - lo)


def _summ(vals: list[float], nd: int = 1) -> dict:
    return {"mean": round(sum(vals) / len(vals), nd), "p5": round(_q(vals, 0.05), nd),
            "p95": round(_q(vals, 0.95), nd), "min": round(min(vals), nd), "max": round(max(vals), nd)}


def _merge_same_time(pts: list[tuple[float, int]]) -> list[list]:
    """同一時刻有好幾個變化（例如一件送到、馬上被拿走）只留最後的件數，圖上才不會出現瞬間的尖刺"""
    merged: list[list] = []
    for t, w in pts:                                    # 1. 同一時刻只留最後的件數
        t = round(t, 1)
        if merged and merged[-1][0] == t:
            merged[-1][1] = w
        else:
            merged.append([t, w])
    out = merged[:1]
    for t, w in merged[1:-1]:                           # 2. 件數沒有變的點不用畫
        if w != out[-1][1]:
            out.append([t, w])
    if len(merged) > 1:
        out.append(merged[-1])                          # 3. 保留結束時刻
    return out


def simulate(model: dict, n_sets: int = 10, reps: int = 200, seed: int = 2026, mode: str = "cont",
             factor: dict | None = None, servers: dict | None = None, wip: str | int | dict = "db",
             init: dict | None = None, line_wip: int | None = None) -> dict:
    """跑 reps 次模擬。
    line_wip（產線 WIP 上限）：整條線同時最多幾件在做；None 或 0 = 不限
    wip（站前上限）："db" = 資料庫設定（沒有用 2）；整數 = 每一站同一個上限；"none" = 不限制；
                     {工站: 上限} = 每一站分別設定（None 或 0 = 不限制）
    init（開始時站前在製品）：{工站: 件數}；沒給 = 0（空的產線開始）"""
    if not model.get("ok"):
        return model
    mode = {"sample": "disc"}.get(mode, mode) if mode in ("cont", "disc", "mean", "sample") else "cont"
    n_sets, reps = max(1, int(n_sets)), max(1, min(int(reps), 2000))
    factor = {k: float(v) for k, v in (factor or {}).items()}
    servers = {k: int(v) for k, v in (servers or {}).items()}
    if isinstance(wip, dict):
        cap = dict(model["wip_limits"])
        for s, v in wip.items():
            if s in cap:
                cap[s] = int(v) if v not in (None, "", "none") and int(v) > 0 else None
    elif wip == "none":
        cap = {s: None for s in model["wip_limits"]}
    elif wip == "db":
        cap = dict(model["wip_limits"])
    else:
        cap = {s: max(1, int(wip)) for s in model["wip_limits"]}
    init_wip = dict(model.get("init_wip", {}))
    for s, v in (init or {}).items():
        if s in init_wip:
            init_wip[s] = max(0, int(v or 0))

    line_wip = int(line_wip) if line_wip not in (None, "", "none") and int(line_wip) > 0 else None
    runs = [LineSim(model, n_sets, random.Random(seed + i), factor, servers, cap, mode, init_wip, record=(i == 0),
                    line_cap=line_wip).run()
            for i in range(reps)]
    ok = [r for r in runs if r["finished"] >= n_sets]
    if not ok:
        return {"ok": False, "error": "模擬無法完成（流程可能有斷點），請檢查流程設定"}
    nodes = [s["station"] for s in model["stations"]]
    mk = [r["makespan"] for r in ok]
    ct = [r["makespan"] / n_sets for r in ok]
    first = [r["first_out"] for r in ok]
    steady = [(r["makespan"] - r["first_out"]) / (n_sets - 1) for r in ok] if n_sets > 1 else []
    bott_count: dict[str, int] = defaultdict(int)
    for r in ok:
        bott_count[max(nodes, key=lambda s: r["stations"][s]["util"])] += 1
    bottleneck = max(bott_count, key=bott_count.get)
    # 理論下限：最慢的站（平均作業時間 ÷ 人數）決定每組最少要多久
    eff = {s: (sum(model["times"][s]) / len(model["times"][s]) * factor.get(s, 1.0)) / max(1, servers.get(s, 1))
           for s in nodes}
    bound_st = max(nodes, key=lambda s: eff[s])

    stations = []
    for s in nodes:
        u = [r["stations"][s]["util"] * 100 for r in ok]
        b = [r["stations"][s]["blocked"] * 100 for r in ok]
        w = [r["stations"][s]["starved"] * 100 for r in ok]
        row = {"station": s, "util_pct": round(sum(u) / len(u), 1), "blocked_pct": round(sum(b) / len(b), 1),
               "starved_pct": round(sum(w) / len(w), 1),
               "bottleneck_share_pct": round(bott_count.get(s, 0) / len(ok) * 100, 1),
               "factor": factor.get(s, 1.0), "servers": max(1, servers.get(s, 1)),
               "eff_time": round(eff[s], 1)}
        if "wip_avg" in ok[0]["stations"][s]:                       # 站前在製品（起點站沒有）
            waits = [r["stations"][s]["wait_avg"] for r in ok if r["stations"][s]["wait_avg"] is not None]
            row.update({"init_wip": init_wip.get(s, 0), "wip_limit": cap.get(s),
                        "wip_avg": round(sum(r["stations"][s]["wip_avg"] for r in ok) / len(ok), 2),
                        "wip_max": max(r["stations"][s]["wip_max"] for r in ok),
                        "wip_end": round(sum(r["stations"][s]["wip_end"] for r in ok) / len(ok), 1),
                        "wait_avg": round(sum(waits) / len(waits), 1) if waits else None})
        stations.append(row)
    buffers = []
    for name in ok[0]["buffers"]:
        a = [r["buffers"][name]["avg"] for r in ok]
        buffers.append({"buffer": name, "avg_wip": round(sum(a) / len(a), 2),
                        "max_wip": max(r["buffers"][name]["max"] for r in ok),
                        "limit": cap.get(name.split("→")[1])})
    return {
        "ok": True, "group_id": model["group_id"], "round": model["round"], "round_label": model["round_label"],
        "params": {"n_sets": n_sets, "reps": reps, "seed": seed, "mode": mode, "wip": wip,
                   "factor": factor, "servers": servers, "init": init_wip, "line_wip": line_wip},
        "completed_reps": len(ok),
        "makespan_sec": _summ(mk), "line_ct_sec": _summ(ct), "first_out_sec": _summ(first),
        "steady_sec": _summ(steady) if steady else None,
        "throughput_per_hr": round(3600 / (sum(ct) / len(ct)), 1),
        "bottleneck": bottleneck, "bottleneck_share_pct": round(bott_count[bottleneck] / len(ok) * 100, 1),
        "bound_station": bound_st, "bound_ct_sec": round(eff[bound_st], 1),
        "stations": stations, "buffers": buffers,
        # 每一次模擬的結果（第幾次、亂數種子、完成時間、產線 Cycle Time、瓶頸）：畫「每一次模擬的結果」線圖、存紀錄用
        "reps_detail": [{"i": i + 1, "seed": seed + i, "makespan": round(r["makespan"], 1),
                         "ct": round(r["makespan"] / n_sets, 2),
                         "bottleneck": max(nodes, key=lambda s, r=r: r["stations"][s]["util"])}
                        for i, r in enumerate(runs) if r["finished"] >= n_sets],
        # 第 1 次模擬：各站前在製品隨時間的變化 [[時間, 件數], …]（畫階梯圖用）
        "wip_timeline": {v: _merge_same_time(pts) for v, pts in (runs[0]["timeline"] or {}).items()},
        # 整條產線的在製品：上限、平均（時間加權）、最多；第 1 次模擬的時間軸
        "line_wip": {"limit": line_wip, "avg": round(sum(r["line"]["avg"] for r in ok) / len(ok), 2),
                     "max": max(r["line"]["max"] for r in ok),
                     "timeline": _merge_same_time(runs[0]["line"]["timeline"] or [])},
        # 甘特圖（第 1 次模擬）：[工站, 開始秒, 結束秒, 第幾件]、阻塞 [工站, 開始秒, 結束秒]
        "gantt": ({"stations": nodes, "end": round(runs[0]["gantt"]["end"], 1),
                   "jobs": [[s, round(a, 1), round(b, 1), k] for s, a, b, k in runs[0]["gantt"]["jobs"]],
                   "blocked": [[s, round(a, 1), round(b, 1)] for s, a, b in runs[0]["gantt"]["blocked"]]}
                  if runs[0]["gantt"] else None),
        "actual": model["actual"], "flow_source": model["flow_source"],
        "data_source": model["source_label"], "min_samples": model["min_samples"],
        "samples": {st["station"]: st["pool"]["n"] for st in model["stations"]},
    }


# ---------------------------------------------------------------- 5. 變異與緩衝實驗
# 老師要示範的定律：變異越大 → 需要越多緩衝（站前在製品）→ 才能維持相同的名義產出速率
#   變異   每站加工時間的標準差 σ；用變異係數 CV = σ ÷ 平均 比較不同工站
#   緩衝   每站前面最多能放幾件（站前上限）
#   名義產出速率 = 3600 ÷ 最慢站的平均時間（沒有變異時理論上的產出，組/小時）
#   變異倍率 k：每一筆 = 平均 + k ×（原值 − 平均）→ 平均不變（名義產出不變），標準差變成 k 倍
#   k = 0 沒有變異；k = 1 實際資料；k = 2 快慢差距變兩倍
#   緩衝 b：每站前面最多放 b 件，而且一開始就放滿 b 件（緩衝 = 手上真的有的在製品，才能在前站慢的時候頂上）
#   產出：只算中間 80% 的完成（第 10%～90% 組），避開開頭填滿、結尾把緩衝用完的影響
EXP_MULTS = [0, 0.5, 1, 2, 3]
EXP_BUFFERS = [1, 2, 3, 5, 10]


def dist_mean(vals: list[float], mode: str) -> float:
    """模擬實際使用的分布的平均：離散型 = 原始平均；連續型（分段線性）= 每一段中點的平均"""
    v = sorted(vals)
    if mode == "disc" or len(v) == 1:
        return sum(v) / len(v)
    return sum((v[i] + v[i + 1]) / 2 for i in range(len(v) - 1)) / (len(v) - 1)


def dist_sd(vals: list[float], mode: str) -> float:
    """模擬實際使用的分布的標準差（連續型：每一段是均勻分布，機率各 1/(n−1)）"""
    v = sorted(vals)
    mu = dist_mean(v, mode)
    if len(v) == 1:
        return 0.0
    if mode == "disc":
        ex2 = sum(x * x for x in v) / len(v)
    else:
        ex2 = sum((v[i] ** 2 + v[i] * v[i + 1] + v[i + 1] ** 2) / 3 for i in range(len(v) - 1)) / (len(v) - 1)
    return max(0.0, ex2 - mu * mu) ** 0.5


def scale_times(vals: list[float], k: float, mode: str, center: float | None = None) -> list[float]:
    """變異倍率 k：以平均為中心把每一筆拉開或縮小（k 倍）；center 有給 = 平衡產線，把平均移到 center。
    太小的值（低於平均的 5%）截掉後，再整體乘一個係數，讓平均剛好不變。"""
    v = sorted(vals)
    c = dist_mean(v, mode)
    target = c if center is None else center
    w = [max(0.05 * target, target + k * (x - c)) for x in v]
    m = dist_mean(w, mode)
    return sorted(x * target / m for x in w) if m > 0 else w


def variability_experiment(model: dict, n_sets: int = 100, reps: int = 30, seed: int = 2026, mode: str = "cont",
                           balanced: bool = True, target_pct: float = 95, factor: dict | None = None,
                           servers: dict | None = None, mults: list | None = None, buffers: list | None = None) -> dict:
    """變異倍率 × 緩衝大小，每一格跑 reps 次（每一格用同一組亂數），算穩定期的產出達成率（實際 ÷ 名義）。"""
    if not model.get("ok"):
        return model
    mode = mode if mode in ("cont", "disc") else "cont"       # 固定平均值沒有變異，實驗用連續型
    n_sets, reps = max(20, int(n_sets)), max(5, min(int(reps), 500))
    i1, i2 = int(n_sets * 0.1), int(n_sets * 0.9) - 1             # 量產出的區間：第 10%～90% 組
    factor = {k: float(v) for k, v in (factor or {}).items()}
    servers = {k: max(1, int(v)) for k, v in (servers or {}).items()}
    mults = [float(m) for m in (mults or EXP_MULTS)]
    buffers = buffers or EXP_BUFFERS
    nodes = [s["station"] for s in model["stations"]]
    base = {s: [x * factor.get(s, 1.0) for x in model["times"][s]] for s in nodes}   # 先套用作業時間倍率
    means = {s: dist_mean(base[s], mode) for s in nodes}
    eff = {s: means[s] / servers.get(s, 1) for s in nodes}                         # 每站「每組」平均要多久
    slow = max(nodes, key=lambda s: eff[s])
    center = {s: eff[slow] * servers.get(s, 1) for s in nodes} if balanced else {s: None for s in nodes}
    nominal = 3600 / eff[slow]                                                      # 名義產出速率（組/小時）
    stations = [{"station": s, "mean": round(means[s], 1), "sd": round(dist_sd(base[s], mode), 1),
                 "cv": round(dist_sd(base[s], mode) / means[s], 2) if means[s] else 0,
                 "balanced_mean": round(center[s], 1) if balanced else None} for s in nodes]
    rows = []
    for k in mults:
        times = {s: scale_times(base[s], k, mode, center[s]) for s in nodes}
        m2 = {**model, "times": times}
        cvs = [dist_sd(times[s], mode) / dist_mean(times[s], mode) for s in nodes]
        cells = []
        for b in buffers:
            cap = {s: b for s in model["wip_limits"]}               # 每站前最多 b 件
            init = {s: b for s in model["wip_limits"]}              # 一開始就放滿 b 件
            th, wip = [], []
            for i in range(reps):                                  # 每一格用同一組亂數（seed + i），差別只來自設定
                r = LineSim(m2, n_sets, random.Random(seed + i), {}, servers, cap, mode, init).run()
                d = r["done_times"]
                if r["finished"] < n_sets or d[i2] <= d[i1]:
                    continue
                th.append((i2 - i1) / (d[i2] - d[i1]) * 3600)      # 穩定期產出（組/小時）
                wip.append(sum(st.get("wip_avg", 0) for st in r["stations"].values()))
            mean_th = sum(th) / len(th) if th else 0
            cells.append({"buffer": b, "th": round(mean_th, 1), "pct": round(mean_th / nominal * 100, 1),
                          "wip": round(sum(wip) / len(wip), 2) if wip else 0})
        need = next((c["buffer"] for c in cells if c["pct"] >= target_pct), None)   # None = 測到的緩衝都還不夠
        rows.append({"mult": k, "cv_avg": round(sum(cvs) / len(cvs), 2), "cv_max": round(max(cvs), 2),
                     "cells": cells, "need": need})
    return {"ok": True, "group_id": model["group_id"], "round": model["round"], "round_label": model["round_label"],
            "nominal": round(nominal, 1), "nominal_station": slow, "nominal_ct": round(eff[slow], 1),
            "balanced": balanced, "target_pct": target_pct, "mode": mode, "n_sets": n_sets, "reps": reps, "seed": seed,
            "buffers": buffers, "stations": stations, "rows": rows,
            "flow_source": model["flow_source"], "data_source": model["source_label"], "min_samples": model["min_samples"]}
