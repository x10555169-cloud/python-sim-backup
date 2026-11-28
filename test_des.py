"""經驗分布模擬（des.py）驗證：用「固定作業時間」的小例子，答案可以用手算（寫在註解裡）。

用法（在 backend 資料夾）：python test_des.py
"""
from __future__ import annotations

import random
import sys

from des import (build_model, dist_mean, dist_sd, empirical_continuous, empirical_discrete, level_of, scale_times,
                 simulate, variability_experiment)

results: list[tuple[str, bool, str]] = []


def check(name: str, got, want, tol: float = 1e-6) -> None:
    ok = abs(got - want) <= tol if isinstance(want, (int, float)) and not isinstance(want, bool) else got == want
    results.append((name, ok, f"得到 {got!r}，應為 {want!r}"))


def ev(st: str, i: int, dur: float, g: str = "G01", rnd: str = "TEST1") -> dict:
    s = f"2026-01-01T00:{i:02d}:00+00:00"
    return {"group_id": g, "product_id": f"{rnd}-P{i:02d}", "station_id": st, "status": "COMPLETED",
            "duration_sec": dur, "start_time": s, "finish_time": s}


def flow(key: str, *edges: tuple[str, str]) -> list[dict]:
    return [{"group_id": key, "station_id": a, "next_station_id": b} for a, b in edges]


def model(times: dict[str, float], edges, limits=None):
    events = [ev(st, i, d) for st, d in times.items() for i in range(3)]
    return build_model(events, flow("G01-T1", *edges), limits or [], "G01", "TEST1")


def run(m, n, **kw):
    return simulate(m, n_sets=n, reps=3, mode="mean", **kw)


# 1. 單站：每件 10 秒，做 5 組 → 50 秒；產線 Cycle Time 10 秒；利用率 100%
m = model({"ST01": 10}, [("ST01", "")])
r = run(m, 5)
check("1 單站 完成時間", r["makespan_sec"]["mean"], 50)
check("1 單站 Cycle Time", r["line_ct_sec"]["mean"], 10)
check("1 單站 利用率", r["stations"][0]["util_pct"], 100)

# 2. 串聯 ST01(10 秒) → ST02(20 秒)，不限 WIP，做 5 組：
#    ST02 從 10 秒開始一直忙：10 + 20×5 = 110 秒；穩態間隔 = 20 秒（瓶頸 ST02）
m = model({"ST01": 10, "ST02": 20}, [("ST01", "ST02")])
r = run(m, 5, wip="none")
check("2 串聯 完成時間", r["makespan_sec"]["mean"], 110)
check("2 串聯 穩態間隔", r["steady_sec"]["mean"], 20)
check("2 串聯 瓶頸", r["bottleneck"], "ST02")
check("2 串聯 ST02 利用率", r["stations"][1]["util_pct"], round(100 / 110 * 100, 1))   # 100 秒 ÷ 110 秒

# 3. 同上但 WIP 上限 1：ST01 第 3 件做完時 ST02 還在做第 1 件、緩衝區已有第 2 件 → ST01 被擋住（阻塞）
#    完成時間不變（還是被 ST02 卡住）= 110 秒；ST01 的阻塞時間 > 0
r = run(m, 5, wip=1)
check("3 WIP=1 完成時間", r["makespan_sec"]["mean"], 110)
check("3 WIP=1 ST01 有阻塞", r["stations"][0]["blocked_pct"] > 0, True)
check("3 WIP=1 緩衝區最多 1 件", r["buffers"][0]["max_wip"], 1)

# 4. 合流（組裝）：ST01(10 秒)、ST02(30 秒) → ST03(5 秒)，做 4 組：
#    ST03 要等 ST02 的料：第 k 組在 30k 秒到齊，做 5 秒 → 第 4 組 125 秒完成；瓶頸 ST02
m = model({"ST01": 10, "ST02": 30, "ST03": 5}, [("ST01", "ST03"), ("ST02", "ST03")])
r = run(m, 4, wip="none")
check("4 合流 完成時間", r["makespan_sec"]["mean"], 125)
check("4 合流 瓶頸", r["bottleneck"], "ST02")

# 5. 增加人數：同 4，但 ST02 兩個人 → ST02 每 30 秒出 2 件：第 1、2 組 30 秒到齊，第 3、4 組 60 秒
#    ST03 在 30、35 秒做完第 1、2 組；60 → 65、70 秒 → 完成時間 70 秒
r = run(m, 4, wip="none", servers={"ST02": 2})
check("5 ST02 兩人 完成時間", r["makespan_sec"]["mean"], 70)

# 6. 作業時間倍率：同 2，ST02 改成 50%（10 秒）→ 兩站都 10 秒：10 + 10×5 = 60 秒
m = model({"ST01": 10, "ST02": 20}, [("ST01", "ST02")])
r = run(m, 5, wip="none", factor={"ST02": 0.5})
check("6 倍率 50% 完成時間", r["makespan_sec"]["mean"], 60)

# 7. 阻塞會拖慢上游：ST01(10) → ST02(30) → ST03(10)，WIP=1，做 3 組（ST02 是瓶頸）：
#    ST03 在 ST02 做完後 10 秒完成：ST02 完成 40、70、100 → ST03 完成 110 秒
m = model({"ST01": 10, "ST02": 30, "ST03": 10}, [("ST01", "ST02"), ("ST02", "ST03")])
r = run(m, 3, wip=1)
check("7 三站 完成時間", r["makespan_sec"]["mean"], 110)

# 8. 資料庫的 WIP 上限：ST02_LIMIT = 3 會被讀進來
m = model({"ST01": 10, "ST02": 20}, [("ST01", "ST02")],
          limits=[{"group_id": "G01-T1", "station_id": "ST02_LIMIT", "input_wip": 3}])
check("8 讀到 ST02_LIMIT", m["wip_limits"]["ST02"], 3)
m = model({"ST01": 10, "ST02": 20}, [("ST01", "ST02")],
          limits=[{"group_id": "G01-T1", "station_id": "ST02_LIMIT", "input_wip": 0}])
check("8 LIMIT = 0 視為沒設定（用 2，同老師網頁）", m["wip_limits"]["ST02"], 2)

# 9. 隨機抽樣：同一個亂數種子結果相同（可重現）；抽樣的平均 CT 要接近實際平均
m = build_model([ev("ST01", i, d) for i, d in enumerate([5, 10, 15, 20])], flow("G01-T1", ("ST01", "")), [], "G01", "TEST1")
a = simulate(m, n_sets=200, reps=50, seed=7)
b = simulate(m, n_sets=200, reps=50, seed=7)
check("9 同種子結果相同", a["makespan_sec"], b["makespan_sec"])
check("9 抽樣平均接近 12.5 秒", abs(a["line_ct_sec"]["mean"] - 12.5) < 0.5, True)

# 10. 連續型經驗分布（分段線性，Law & Kelton）：G23 第 1 次測試 ST08 的 4 筆 54.4、71.7、79.2、119.3
#     U = 0.5 → P = (4−1)×0.5 = 1.5 → I = 2 → 71.7 + (1.5−2+1)×(79.2−71.7) = 75.45
x = [54.4, 71.7, 79.2, 119.3]
check("10 連續型 U=0.5", empirical_continuous(x, 0.5), 75.45)
check("10 連續型 U=0 = 最小值", empirical_continuous(x, 0.0), 54.4)
check("10 連續型 U→1 = 最大值", empirical_continuous(x, 0.999999), 119.3, tol=1e-3)
check("10 連續型 U=1/3 = 第 2 筆", empirical_continuous(x, 1 / 3), 71.7, tol=1e-9)
#     只有 1 筆：每次都是那 1 筆
check("10 連續型 只有 1 筆", empirical_continuous([42.0], 0.7), 42.0)

# 11. 離散型經驗分布（重抽樣）：每筆機率 1/4；U=0.5 → 第 3 筆 79.2；U=0.24 → 第 1 筆
check("11 離散型 U=0.5", empirical_discrete(x, 0.5), 79.2)
check("11 離散型 U=0.24", empirical_discrete(x, 0.24), 54.4)
import random
rng = random.Random(1)
cont = [empirical_continuous(x, rng.random()) for _ in range(200000)]
check("11 連續型抽樣都在最小～最大之間", min(cont) >= 54.4 and max(cont) <= 119.3, True)
#     分段線性的平均 = 各段中點的平均 = (63.05 + 75.45 + 99.25) / 3 = 79.25
check("11 連續型抽樣平均 ≈ 79.25", abs(sum(cont) / len(cont) - 79.25) < 0.2, True)
rng = random.Random(1)
disc = [empirical_discrete(x, rng.random()) for _ in range(200000)]
check("11 離散型只會抽到原始值", set(disc) == set(x), True)
check("11 離散型抽樣平均 ≈ 原始平均 81.15", abs(sum(disc) / len(disc) - 81.15) < 0.3, True)

# 12. 資料量等級：<10、10~29、≥30、≥100
check("12 等級 9 筆", level_of(9)["code"], "few")
check("12 等級 29 筆", level_of(29)["code"], "low")
check("12 等級 30 筆", level_of(30)["code"], "ok")
check("12 等級 100 筆", level_of(100)["code"], "best")

# 13. 資料來源：只用本組，而且只加「流程相同」的場次
#     本場（第 1 次）3 筆 10 秒；第 2 次 5 筆 12 秒（沒有自己的流程 → 沿用 G01-T1，流程相同）；
#     別組 G02 40 筆 30 秒（不管選什麼都不會加入）
evs = [ev("ST01", i, 10) for i in range(3)] + [ev("ST01", i, 12, rnd="TEST2") for i in range(5)] \
    + [ev("ST01", i % 60, 30, g="G02") for i in range(40)]
fl = flow("G01-T1", ("ST01", ""))
n_of = lambda e, f, src, rnd="TEST1": build_model(e, f, [], "G01", rnd, source=src)["stations"][0]["pool"]["n"]
check("13 只用本場 = 3 筆", n_of(evs, fl, "round"), 3)
check("13 本場 + 本組流程相同 = 3 + 5 = 8 筆（別組不加）", n_of(evs, fl, "group"), 8)
check("13 自動補到 30：只加本組，別組不加 = 8 筆", n_of(evs, fl, "auto30"), 8)
check("13 舊選項「全班」改成只用本組", n_of(evs, fl, "class"), 8)
m = build_model(evs, fl, [], "G01", "TEST1", source="group")
check("13 第 2 次測試標示為流程相同", m["other_rounds"][0]["same_flow"], True)
check("13 實際結果只算本場", m["actual"]["events"], 3)

# 14. 流程不同的場次不加入：第 2 次測試的流程是 ST02 → ST01（跟第 1 次的 ST01 → ST02 相反）
evs = [ev(st, i, 10) for st in ("ST01", "ST02") for i in range(3)] + \
      [ev(st, i, 99, rnd="TEST2") for st in ("ST01", "ST02") for i in range(5)]
fl = flow("G01-T1", ("ST01", "ST02")) + flow("G01-T2", ("ST02", "ST01"))
m = build_model(evs, fl, [], "G01", "TEST1", source="group")
check("14 流程不同 → 不加入（ST01 還是 3 筆）", m["stations"][0]["pool"]["n"], 3)
check("14 標示流程不同", m["other_rounds"][0]["same_flow"], False)
check("14 原因寫出對方的流程", "流程不同" in m["other_rounds"][0]["reason"], True)
fl2 = flow("G01-T1", ("ST01", "ST02")) + flow("G01-T2", ("ST01", "ST02"))
check("14 兩場各自設定、但連線一樣 → 視為相同、加入（3 + 5）", n_of(evs, fl2, "group"), 8)
fl3 = flow("G01-T1", ("ST01", "ST02"), ("ST02", "")) + flow("G01-T2", ("ST01", "ST02"))
check("14 終點站有沒有單獨寫一列不影響 → 視為相同", n_of(evs, fl3, "group"), 8)

# 15. 沒有設定流程：無法確認相同 → 不加入
evs = [ev("ST01", i, 10) for i in range(3)] + [ev("ST01", i, 12, rnd="TEST2") for i in range(5)]
m = build_model(evs, [], [], "G01", "TEST1", source="group")
check("15 沒有流程 → 不加入", m["stations"][0]["pool"]["n"], 3)
check("15 原因：無法確認", "無法確認" in m["other_rounds"][0]["reason"], True)

# 16. 自動補到 30：場次近的先加，夠 30 筆就停
#     本場 = 第 3 次 10 筆；第 2 次 25 筆；第 1 次 25 筆；三場流程都沿用 G01-T1（相同）
#     → 10 + 第 2 次 25 = 35 ≥ 30，就不再加第 1 次 → 35 筆
evs = [ev("ST01", i, 10, rnd="TEST3") for i in range(10)] + [ev("ST01", i, 12, rnd="TEST2") for i in range(25)] \
    + [ev("ST01", i, 14, rnd="TEST1") for i in range(25)]
fl = flow("G01-T1", ("ST01", ""))
m = build_model(evs, fl, [], "G01", "TEST3", source="auto30")
check("16 自動補到 30：只加最近的第 2 次 = 35 筆", m["stations"][0]["pool"]["n"], 35)
check("16 用到的場次", m["stations"][0]["used"], ["本場", "第 2 次測試"])
check("16 本場 + 本組全部（group）= 60 筆", n_of(evs, fl, "group", "TEST3"), 60)

# 17. 站前在製品（開始時件數）：ST01（10 秒）→ ST02（20 秒），ST02 前先放 1 件，做 3 組，不限上限
#     ST02 一開始就做那 1 件（0→20）；ST01 的第 1 件 10 秒到、等到 20 秒（等 10 秒）→ 40；
#     第 2 件 20 秒到、等到 40 秒（等 20 秒）→ 60 → 完成 3 組 60 秒（沒放的話是 10 + 20×3 = 70 秒）
#     第 3 件 30 秒到，那時第 2 件還在等 → ST02 前最多 2 件；完成 3 組就停，第 3 件留在 ST02 前面 → 結束時 1 件
#     ST02 前平均等待 =（0 + 10 + 20）÷ 3 = 10 秒
m = model({"ST01": 10, "ST02": 20}, [("ST01", "ST02")])
r = run(m, 3, wip="none", init={"ST02": 1})
st2 = r["stations"][1]
check("17 開始時站前 1 件 → 完成時間 60", r["makespan_sec"]["mean"], 60)
check("17 沒放 → 70", run(m, 3, wip="none")["makespan_sec"]["mean"], 70)
check("17 ST02 前平均等待 10 秒", st2["wait_avg"], 10)
check("17 結束時 ST02 前還有 1 件", st2["wip_end"], 1)
check("17 ST02 前最多 2 件", st2["wip_max"], 2)
check("17 時間軸：0 秒那 1 件馬上被拿走 → 從 0 件開始", r["wip_timeline"]["ST02"][0], [0.0, 0])
check("17 時間軸：10 秒 1 件、30 秒 2 件、40 秒 1 件、到 60 秒", r["wip_timeline"]["ST02"], [[0.0, 0], [10.0, 1], [30.0, 2], [40.0, 1], [60.0, 1]])
#     ST02 前在製品時間加權平均：0~10 秒 0 件（初始那件 0 秒就被拿走）、10~30 秒 1 件、30~40 秒 2 件、40~60 秒 1 件
#     =（0×10 + 1×20 + 2×10 + 1×20）÷ 60 = 60 ÷ 60 = 1.0
check("17 ST02 前平均在製品 = 60 ÷ 60 = 1.0", st2["wip_avg"], 1.0)

# 18. 每一站分別設定上限：ST01(10) → ST02(30) → ST03(10)，ST02 前上限 1、ST03 前不限
m = model({"ST01": 10, "ST02": 30, "ST03": 10}, [("ST01", "ST02"), ("ST02", "ST03")])
r = run(m, 3, wip={"ST02": 1, "ST03": None})
check("18 ST02 前上限 1", r["stations"][1]["wip_limit"], 1)
check("18 ST03 前不限", r["stations"][2]["wip_limit"], None)
check("18 ST02 前最多 1 件", r["stations"][1]["wip_max"], 1)
check("18 ST01 被擋住（有阻塞）", r["stations"][0]["blocked_pct"] > 0, True)
check("18 完成時間 110 秒（同第 7 項）", r["makespan_sec"]["mean"], 110)

# 19. 從資料庫讀「開始時站前在製品」：station_wip 的 G01-T1 / ST02 列 input_wip = 2（老師網頁的站前半成品初始備料）
m = model({"ST01": 10, "ST02": 20}, [("ST01", "ST02")],
          limits=[{"group_id": "G01-T1", "station_id": "ST02", "input_wip": 2},
                  {"group_id": "G01-T1", "station_id": "ST02_LIMIT", "input_wip": 3}])
check("19 讀到 ST02 開始時 2 件", m["init_wip"]["ST02"], 2)
check("19 起點站 ST01 沒有站前在製品", "ST01" in m["init_wip"], False)
r = run(m, 3, wip="none")
check("19 沒指定 init 時用資料庫的 2 件", r["stations"][1]["init_wip"], 2)
check("19 ST02 前最多 2 件", r["stations"][1]["wip_max"] >= 2, True)
#     合流站：每個前站各放 k 件（= k 套）
m = model({"ST01": 10, "ST02": 30, "ST03": 5}, [("ST01", "ST03"), ("ST02", "ST03")])
r = run(m, 4, wip="none", init={"ST03": 1})
check("19 合流站開始時 1 套 = 2 件", r["stations"][2]["wip_max"] >= 2, True)

# 20. 每一次模擬的結果都保留：筆數 = 模擬次數；平均 = 整體平均；第 i 次用亂數種子 seed + i − 1
m = build_model([ev("ST01", i, d) for i, d in enumerate([5, 10, 15, 20])], flow("G01-T1", ("ST01", "")), [], "G01", "TEST1")
r = simulate(m, n_sets=10, reps=37, seed=100)
det = r["reps_detail"]
check("20 保留 37 次的結果", len(det), 37)
check("20 第 1 次用種子 100、第 37 次用 136", (det[0]["seed"], det[-1]["seed"]), (100, 136))
check("20 每次的完成時間平均 = 整體平均", abs(sum(d["makespan"] for d in det) / 37 - r["makespan_sec"]["mean"]) < 0.06, True)
check("20 每次 CT = 完成時間 ÷ 10", all(abs(d["ct"] - d["makespan"] / 10) < 0.01 for d in det), True)

# 21. 分布的平均與標準差（變異與緩衝實驗用）
x = [54.4, 71.7, 79.2, 119.3]
check("21 連續型平均 = 各段中點平均 = 79.25", dist_mean(x, "cont"), 79.25, tol=1e-9)
check("21 離散型平均 = 原始平均 = 81.15", dist_mean(x, "disc"), 81.15, tol=1e-9)
import statistics
check("21 離散型標準差 = 母體標準差", dist_sd(x, "disc"), statistics.pstdev(x), tol=1e-9)
rng = random.Random(3)
draws = [empirical_continuous(x, rng.random()) for _ in range(300000)]
check("21 連續型標準差公式 ≈ 抽樣結果", abs(dist_sd(x, "cont") - statistics.pstdev(draws)) < 0.1, True)

# 22. 變異倍率：平均不變、標準差變 k 倍
v = [10.0, 12.0, 14.0, 16.0, 18.0]
check("22 ×0：每一筆都等於平均（沒有變異）", scale_times(v, 0, "cont"), [14.0] * 5)
check("22 ×1：跟原始資料一樣", [round(a, 9) for a in scale_times(v, 1, "cont")], v)
w = scale_times(v, 2, "cont")
check("22 ×2：平均不變", dist_mean(w, "cont"), dist_mean(v, "cont"), tol=1e-9)
check("22 ×2：標準差變 2 倍", dist_sd(w, "cont"), 2 * dist_sd(v, "cont"), tol=1e-9)
check("22 平衡產線：平均移到 20 秒、標準差不變", (round(dist_mean(scale_times(v, 1, "cont", 20), "cont"), 9), round(dist_sd(scale_times(v, 1, "cont", 20), "cont"), 9)),
      (20.0, round(dist_sd(v, "cont"), 9)))
w = scale_times([1, 2, 30], 3, "disc")
check("22 變異太大時截掉負值，平均還是不變", (min(w) > 0, round(dist_mean(w, "disc"), 9)), (True, 11.0))

# 23. 變異與緩衝實驗：4 站平衡、變異很大的產線
evs = [ev(st, i, d) for st in ("ST01", "ST02", "ST03", "ST04") for i, d in enumerate([6, 8, 10, 12, 14])]
fl = flow("G01-T1", ("ST01", "ST02"), ("ST02", "ST03"), ("ST03", "ST04"))
m = build_model(evs, fl, [], "G01", "TEST1")
x = variability_experiment(m, n_sets=80, reps=15)
pct = {row["mult"]: [c["pct"] for c in row["cells"]] for row in x["rows"]}
check("23 名義產出 = 3600 ÷ 平均 10 秒 = 360 組/時", x["nominal"], 360.0)
check("23 沒有變異（×0）→ 不管緩衝多少都是 100%", pct[0.0], [100.0] * 5)
check("23 變異越大，緩衝 1 的達成率越低", pct[0.0][0] > pct[1.0][0] > pct[2.0][0] > pct[3.0][0], True)
check("23 同樣變異 ×2，緩衝越大達成率越高", pct[2.0][0] < pct[2.0][2] < pct[2.0][4], True)
needs = [row["need"] if row["need"] is not None else 99 for row in x["rows"]]
check("23 需要的緩衝隨變異增加（不會變少）", all(a <= b for a, b in zip(needs, needs[1:])), True)
check("23 需要的緩衝：×0 只要 1 件、×3 要超過 1 件", (needs[0], needs[-1] > 1), (1, True))
#     不平衡（ST04 慢很多）：瓶頸前面永遠有料，緩衝幾乎沒有差別
evs2 = [e for e in evs if e["station_id"] != "ST04"] + [ev("ST04", i, d) for i, d in enumerate([28, 29, 30, 31, 32])]
m2 = build_model(evs2, fl, [], "G01", "TEST1")
x2 = variability_experiment(m2, n_sets=80, reps=15, balanced=False)
row2 = next(r for r in x2["rows"] if r["mult"] == 2.0)
check("23 不平衡產線：緩衝 1 和 10 差不到 2%", abs(row2["cells"][0]["pct"] - row2["cells"][-1]["pct"]) < 2, True)

# 24. 甘特圖（第 1 次模擬）：ST01（10 秒）→ ST02（20 秒），做 3 組，固定平均值、不限上限
#     ST01：0~10 第 1 件、10~20 第 2 件、20~30 第 3 件
#     ST02：10~30 第 1 件、30~50 第 2 件、50~70 第 3 件
m = model({"ST01": 10, "ST02": 20}, [("ST01", "ST02")])
g = run(m, 3, wip="none")["gantt"]
check("24 甘特圖的工站", g["stations"], ["ST01", "ST02"])
check("24 ST01 的三件", [j for j in g["jobs"] if j[0] == "ST01"], [["ST01", 0.0, 10.0, 1], ["ST01", 10.0, 20.0, 2], ["ST01", 20.0, 30.0, 3]])
check("24 ST02 的三件", [j for j in g["jobs"] if j[0] == "ST02"], [["ST02", 10.0, 30.0, 1], ["ST02", 30.0, 50.0, 2], ["ST02", 50.0, 70.0, 3]])
check("24 結束時間 70 秒、沒有阻塞", (g["end"], g["blocked"]), (70.0, []))
#     ST01（10 秒）→ ST02（30 秒）→ ST03（10 秒），上限 1，做 3 組：ST01 第 3 件 30 秒做完，
#     ST02 前已經有第 2 件在等（滿了）→ 拿著等到 40 秒（ST02 拿走第 2 件才放得進去）
m = model({"ST01": 10, "ST02": 30, "ST03": 10}, [("ST01", "ST02"), ("ST02", "ST03")])
r = run(m, 3, wip=1)
check("24 阻塞時段：ST01 30~40 秒", r["gantt"]["blocked"], [["ST01", 30.0, 40.0]])
check("24 阻塞總時間 = 阻塞 % × 完成時間", abs(sum(b - a for _, a, b in r["gantt"]["blocked"]) - r["stations"][0]["blocked_pct"] / 100 * r["makespan_sec"]["mean"]) < 0.2, True)

# 25. 產線 WIP 上限（整條線同時最多幾件）：ST01（10 秒）→ ST02（20 秒），做 3 組，固定平均值、站前不限
#     上限 1：一次只能有 1 件在線上 → ST01 0~10、ST02 10~30 做完，30 秒才投入第 2 件 …… 完成 = 30 × 3 = 90 秒
m = model({"ST01": 10, "ST02": 20}, [("ST01", "ST02")])
r = run(m, 3, wip="none", line_wip=1)
check("25 上限 1：完成 90 秒", r["makespan_sec"]["mean"], 90.0)
check("25 上限 1：ST01 第 2、3 件在 30、60 秒才開始", [j[1] for j in r["gantt"]["jobs"] if j[0] == "ST01"], [0.0, 30.0, 60.0])
check("25 上限 1：產線 WIP 最多 1 件、平均 1 件", (r["line_wip"]["max"], r["line_wip"]["avg"]), (1, 1.0))
check("25 上限 1：產線 WIP 時間軸", r["line_wip"]["timeline"], [[0.0, 1], [90.0, 0]])
#     上限 2：ST01 0~10、10~20 投入 2 件後要等，第 1 組 30 秒做完才投入第 3 件（30~40）；ST02 一直忙 → 一樣 70 秒
r = run(m, 3, wip="none", line_wip=2)
check("25 上限 2：完成 70 秒（瓶頸一直有料，不會變慢）", r["makespan_sec"]["mean"], 70.0)
check("25 上限 2：ST01 第 3 件 30 秒才開始", [j[1] for j in r["gantt"]["jobs"] if j[0] == "ST01"], [0.0, 10.0, 30.0])
check("25 上限 2：產線 WIP 最多 2 件", r["line_wip"]["max"], 2)
#     不限：20 秒時 3 件都投入 → 最多 3 件
r = run(m, 3, wip="none")
check("25 不限：最多 3 件、70 秒", (r["line_wip"]["max"], r["makespan_sec"]["mean"], r["line_wip"]["limit"]), (3, 70.0, None))
#     開始時 ST02 前就有 1 件，上限 1：線上已經有 1 件 → ST01 要等它做完（20 秒）才投入
#     ST02 0~20（初始那件）、ST01 20~30、ST02 30~50、ST01 50~60、ST02 60~80 → 80 秒
r = run(m, 3, wip="none", init={"ST02": 1}, line_wip=1)
check("25 開始時站前 1 件也算在產線 WIP：完成 80 秒", r["makespan_sec"]["mean"], 80.0)
#     合流：ST01（10 秒）、ST02（30 秒）→ ST03（5 秒），做 4 組，上限 1：每組 35 秒做完才投入下一組 → 140 秒
m = model({"ST01": 10, "ST02": 30, "ST03": 5}, [("ST01", "ST03"), ("ST02", "ST03")])
r = run(m, 4, wip="none", line_wip=1)
check("25 合流、上限 1：每組 35 秒 × 4 = 140 秒", r["makespan_sec"]["mean"], 140.0)

fails = [x for x in results if not x[1]]
for name, ok, msg in results:
    print(("✅ " if ok else "❌ ") + name + ("" if ok else f"：{msg}"))
print(f"共 {len(results)} 項，失敗 {len(fails)} 項")
sys.exit(1 if fails else 0)
