// 「模擬資料 API」頁面：讓學生不用寫程式就能看到模擬資料庫裡的資料，並產生對應的 API 網址和程式碼
// 只讀取（GET），金鑰是公開的 publishable key（資料庫設定成只能讀）
(() => {
  const $ = (id) => document.getElementById(id);
  const C = window.SIM_DB || {};
  const BASE = (C.URL || "").replace(/\/$/, "") + "/rest/v1/";
  const KEY = C.KEY || "";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // 欄位說明（中文）
  const FIELDS = {
    sim_run: {
      id: "編號", created_at: "存檔時間（UTC，台灣時間 +8 小時）", group_id: "組別", round: "場次代碼（TEST2 / FORMAL）", round_label: "場次",
      data_source: "加工時間資料來源", dist_mode: "經驗分布（cont 連續型 / disc 離散型 / mean 固定平均）",
      n_sets: "要生產幾組", reps: "模擬幾次", seed: "亂數種子", line_wip_limit: "產線 WIP 上限（空 = 不限）",
      settings_text: "改了什麼（跟現況不一樣的設定）", settings: "完整設定（JSON：人數、作業時間倍率、站前上限…）",
      makespan_mean: "完成 N 組要多久（秒，平均）", makespan_p5: "完成時間 90% 範圍：下限", makespan_p95: "完成時間 90% 範圍：上限",
      line_ct_mean: "產線 Cycle Time（秒/組，平均）", line_ct_p5: "產線 CT 90% 範圍：下限", line_ct_p95: "產線 CT 90% 範圍：上限",
      throughput_per_hr: "每小時產出（組）", bottleneck: "瓶頸站", bottleneck_share_pct: "幾 % 的模擬中是瓶頸",
      bound_station: "理論最快受限的站", bound_ct_sec: "理論最快 Cycle Time（秒/組）",
      line_wip_avg: "整條產線 WIP 平均（件）", line_wip_max: "整條產線 WIP 最多（件）",
      actual_sets: "實際：完成幾組", actual_total_sec: "實際：總耗時（秒）", actual_ct_sec: "實際：產線 Cycle Time（秒/組）",
      actual_bottleneck: "實際：瓶頸站", min_samples: "資料最少的工站有幾筆", data_events: "用了幾筆完工紀錄",
      gantt: "第 1 次模擬的甘特圖（JSON）", fingerprint: "防止重複存檔的代碼",
    },
    sim_station: {
      run_id: "對應 sim_run 的編號", station: "工站", servers: "人數", time_factor: "作業時間倍率（1 = 照實際）",
      eff_time_sec: "有效加工時間（秒）", samples: "資料筆數", util_pct: "利用率 %（在加工）", blocked_pct: "阻塞 %（做完送不出去）",
      starved_pct: "閒置 %（等料）", bottleneck_share_pct: "當瓶頸的比例 %", init_wip: "開始時站前在製品（件）",
      wip_limit: "站前上限（空 = 不限）", wip_avg: "站前在製品平均（件）", wip_max: "站前在製品最多（件）",
      wip_end: "結束時站前還剩（件）", wait_avg_sec: "每件在站前平均等幾秒",
    },
    sim_rep: {
      run_id: "對應 sim_run 的編號", rep_no: "第幾次模擬", seed: "亂數種子", makespan_sec: "完成時間（秒）",
      ct_sec: "產線 Cycle Time（秒/組）", bottleneck: "這一次的瓶頸站",
    },
  };
  // 預設只拿常用欄位（勾「顯示全部欄位」= select=*）
  const DEFAULT_COLS = {
    sim_run: "id,created_at,group_id,round_label,n_sets,reps,line_wip_limit,settings_text,makespan_mean,line_ct_mean,throughput_per_hr,bottleneck,line_wip_avg,actual_ct_sec",
    sim_station: "run_id,station,servers,time_factor,util_pct,blocked_pct,starved_pct,bottleneck_share_pct,wip_avg,wip_max,wait_avg_sec",
    sim_rep: "run_id,rep_no,seed,makespan_sec,ct_sec,bottleneck",
  };

  let runs = [], rows = [], tab = "py";

  $("saUrl").textContent = C.URL ? BASE : "（還沒設定 sim_db_config.js）";
  $("saKey").textContent = KEY || "（還沒設定 sim_db_config.js）";

  // 目前的查詢條件 → [表名, {參數}]
  function query() {
    const t = $("saTable").value, q = { select: $("saAll").checked ? "*" : DEFAULT_COLS[t] };
    const dir = $("saOrder").value;
    if (t === "sim_run") {
      if ($("saGroup").value) q.group_id = `eq.${$("saGroup").value}`;
      if ($("saRound").value) q.round = `eq.${$("saRound").value}`;
      q.order = `created_at.${dir}`;
    } else {
      if ($("saRun").value) q.run_id = `eq.${$("saRun").value}`;
      q.order = t === "sim_station" ? `run_id.${dir},station.asc` : `run_id.${dir},rep_no.asc`;
    }
    if ($("saLimit").value) q.limit = $("saLimit").value;
    return [t, q];
  }
  const qs = (q) => Object.entries(q).map(([k, v]) => `${k}=${v}`).join("&");
  const apiUrl = () => { const [t, q] = query(); return `${BASE}${t}?${qs(q)}`; };

  function code() {
    const [t, q] = query();
    if (tab === "py") {
      const params = Object.entries(q).map(([k, v]) => `    "${k}": "${v}",`).join("\n");
      return `import requests

URL = "${BASE}${t}"
KEY = "${KEY}"

params = {
${params}
}
data = requests.get(URL, params=params, headers={"apikey": KEY}).json()

print(len(data), "筆")
for row in data:
    print(row)`;
    }
    return `const URL = "${apiUrl()}";
const KEY = "${KEY}";

const res = await fetch(URL, { headers: { apikey: KEY } });
const data = await res.json();

console.log(data.length, "筆");
console.table(data);`;
  }

  function refreshUI() {
    const t = $("saTable").value;
    $("saGroupL").hidden = $("saRoundL").hidden = t !== "sim_run";
    $("saRunL").hidden = t === "sim_run";
    $("saApi").textContent = apiUrl();
    $("saCode").textContent = code();
    $("saFieldsSub").textContent = `${t}（勾「顯示全部欄位」會拿到這些全部）`;
    $("saFields").innerHTML = `<thead><tr><th>欄位</th><th>意思</th></tr></thead><tbody>` +
      Object.entries(FIELDS[t]).map(([k, v]) => `<tr><td><code>${k}</code></td><td>${esc(v)}</td></tr>`).join("") + "</tbody>";
  }

  async function get(path, headers = {}) {
    const res = await fetch(BASE + path, { headers: { apikey: KEY, ...headers } });
    let j = null; try { j = await res.json(); } catch {}
    if (!res.ok) {
      const m = (j && (j.message || j.hint)) || `HTTP ${res.status}`;
      throw new Error(/does not exist|Could not find|PGRST205/.test(m) ? "資料庫還沒建表，請先在 Supabase 執行 sim_db_schema.sql" : m);
    }
    return { data: j, total: parseInt(((res.headers.get("content-range") || "").split("/")[1]), 10) };
  }

  const fmt = (k, v) => {
    if (v == null) return '<span class="muted">—</span>';
    if (k === "created_at") return esc(new Date(v).toLocaleString("zh-TW", { hour12: false }));
    if (typeof v === "object") return '<span class="muted" title="JSON 資料，展開下面的「看原始資料」">{…}</span>';
    return esc(v);
  };
  function render() {
    const t = $("saTable").value;
    if (!rows.length) {
      $("saTableOut").innerHTML = '<tbody><tr><td class="empty">沒有符合條件的資料。先到「經驗分布模擬」跑模擬、按「💾 存到資料庫」，這裡就會有資料。</td></tr></tbody>';
      $("saJson").textContent = "[]"; $("saCsv").disabled = true; return;
    }
    const cols = Object.keys(rows[0]);
    const label = (k) => (FIELDS[t][k] || "").replace(/（.*）$/, "");
    $("saTableOut").innerHTML = `<thead><tr>${cols.map((k) => `<th title="${esc(FIELDS[t][k] || "")}">${esc(label(k))}<br><code class="sa-col">${k}</code></th>`).join("")}</tr></thead><tbody>` +
      rows.map((r) => `<tr>${cols.map((k) => `<td>${fmt(k, r[k])}${t === "sim_run" && k === "id" ? ` <button class="sa-link" data-run="${r.id}" title="看這一筆每一站的結果">各站 ›</button>` : ""}</td>`).join("")}</tr>`).join("") + "</tbody>";
    $("saJson").textContent = JSON.stringify(rows.slice(0, 3), null, 2) + (rows.length > 3 ? `\n…（共 ${rows.length} 筆，這裡只顯示前 3 筆）` : "");
    $("saCsv").disabled = false;
  }

  async function run() {
    if (!C.URL || !KEY) { $("saMsg").textContent = "還沒設定模擬資料庫（sim_db_config.js）"; return; }
    refreshUI();
    $("saGo").disabled = true; $("saMsg").textContent = "查詢中…";
    try {
      const [t, q] = query();
      const r = await get(`${t}?${qs(q)}`, { Prefer: "count=exact" });
      rows = r.data || [];
      $("saCount").textContent = Number.isFinite(r.total) && r.total > rows.length ? `顯示 ${rows.length} 筆（符合條件共 ${r.total} 筆）` : `${rows.length} 筆`;
      $("saMsg").textContent = "";
      render();
    } catch (e) {
      $("saMsg").textContent = `查詢失敗：${e.message === "Failed to fetch" ? "連不到模擬資料庫，請檢查網路或 sim_db_config.js" : e.message}`;
    } finally { $("saGo").disabled = false; }
  }

  // 組別、場次、模擬紀錄的選單（從資料庫裡已經存的資料產生）
  async function loadRuns() {
    if (!C.URL || !KEY) { $("conn").textContent = "未設定"; $("conn").className = "pill bad"; return; }
    try {
      const r = await get("sim_run?select=id,created_at,group_id,round,round_label,settings_text&order=created_at.desc&limit=500", { Prefer: "count=exact" });
      runs = r.data || [];
      $("conn").textContent = `已連線｜共 ${Number.isFinite(r.total) ? r.total : runs.length} 筆模擬紀錄`; $("conn").className = "pill ok";
      const opts = (vals, cur) => '<option value="">全部</option>' + vals.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(l)}</option>`).join("");
      const groups = [...new Set(runs.map((x) => x.group_id))].sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));
      const rounds = [...new Map(runs.map((x) => [x.round, x.round_label || x.round])).entries()].sort();
      $("saGroup").innerHTML = opts(groups.map((g) => [g, g]), $("saGroup").value);
      $("saRound").innerHTML = opts(rounds, $("saRound").value);
      const cur = $("saRun").value;
      $("saRun").innerHTML = '<option value="">全部</option>' + runs.map((x) => `<option value="${x.id}"${String(x.id) === cur ? " selected" : ""}>#${x.id}　${esc(x.group_id)} ${esc(x.round_label || x.round)}｜${esc(x.settings_text || "")}</option>`).join("");
    } catch (e) {
      $("conn").textContent = "連線失敗"; $("conn").className = "pill bad";
      $("saMsg").textContent = `連線失敗：${e.message === "Failed to fetch" ? "連不到模擬資料庫，請檢查網路或 sim_db_config.js" : e.message}`;
    }
  }

  // 事件
  ["saTable", "saGroup", "saRound", "saRun", "saOrder", "saLimit", "saAll"].forEach((id) => $(id).addEventListener("change", refreshUI));
  $("saTable").addEventListener("change", () => { if ($("saTable").value === "sim_rep" && !$("saRun").value && runs[0]) $("saRun").value = runs[0].id; refreshUI(); });
  $("saGo").onclick = run;
  $("saTableOut").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-run]");
    if (!b) return;
    $("saTable").value = "sim_station"; $("saRun").value = b.dataset.run; run();
  });
  document.querySelectorAll(".sa-tab").forEach((b) => b.addEventListener("click", () => {
    tab = b.dataset.tab;
    document.querySelectorAll(".sa-tab").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    refreshUI();
  }));
  document.querySelectorAll("button[data-copy]").forEach((b) => b.addEventListener("click", async () => {
    const txt = $(b.dataset.copy).textContent;
    try { await navigator.clipboard.writeText(txt); } catch {
      const ta = document.createElement("textarea"); ta.value = txt; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch {} ta.remove();
    }
    const old = b.textContent; b.textContent = "已複製 ✓"; setTimeout(() => { b.textContent = old; }, 1200);
  }));
  $("saCsv").onclick = () => {
    if (!rows.length) return;
    const cols = Object.keys(rows[0]);
    const cell = (v) => { const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = "﻿" + [cols.join(","), ...rows.map((r) => cols.map((k) => cell(r[k])).join(","))].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `${$("saTable").value}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  refreshUI();
  loadRuns().then(run);
})();
