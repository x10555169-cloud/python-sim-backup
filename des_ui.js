// 「經驗分布模擬」區塊：選好組別 + 場次 → 每站的經驗分布（已完成資料）→ 調參數 → 跑模擬（Python des.py 在瀏覽器裡執行）
(() => {
  const C = window.APP_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const card = $("desCard");
  if (!card || C.MODE !== "browser" || !window.BrowserEngine) return;   // 只有不用 Render 的瀏覽器模式才有
  card.hidden = false;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtSec = (s) => (s == null ? "—" : s < 60 ? `${s.toFixed(1)} 秒` : `${Math.floor(s / 60)} 分 ${String(Math.round(s % 60)).padStart(2, "0")} 秒`);
  const roundLabel = (r) => (r === "FORMAL" ? "正式實作" : `第 ${String(r).slice(4)} 次測試`);
  const bar = (pct, color) => `<span class="des-bar"><i style="width:${Math.min(100, Math.max(0, pct))}%;background:${color}"></i></span>${pct.toFixed(1)}%`;
  const LEVEL_ICON = { few: "🔴", low: "🟡", ok: "🟢", best: "⭐" };

  let key = "", model = null, loading = false, version = -1, runBusy = false;

  function target() {
    const g = $("groupSel") ? $("groupSel").value : "ALL";
    const r = $("batchSel") ? $("batchSel").value : "ALL";
    return { g, r, src: $("desSource").value, ok: /^G\d+$/.test(g) && /^(TEST\d+|FORMAL)$/.test(r) };
  }

  // 小圖：這站的經驗分布（累積分布 CDF）。連續型 = 各點之間連直線；離散型 = 階梯
  function cdfSvg(vals, mode) {
    const n = vals.length;
    if (!n) return "";
    const W = 120, H = 30, lo = vals[0], hi = vals[n - 1], span = hi - lo || 1;
    const x = (v) => (n === 1 ? W / 2 : 4 + ((v - lo) / span) * (W - 8));
    let d;
    if (mode === "disc") {
      d = `M4 ${H - 3}` + vals.map((v, i) => ` H${x(v).toFixed(1)} V${(H - 3 - ((i + 1) / n) * (H - 6)).toFixed(1)}`).join("") + ` H${W - 4}`;
    } else {
      d = vals.map((v, i) => `${i ? "L" : "M"}${x(v).toFixed(1)} ${(H - 3 - (n === 1 ? 1 : i / (n - 1)) * (H - 6)).toFixed(1)}`).join(" ");
    }
    const dots = n <= 40 ? vals.map((v) => `<circle cx="${x(v).toFixed(1)}" cy="${H - 2}" r="1.6"/>`).join("") : "";
    return `<svg class="des-cdf" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="經驗分布 ${lo}～${hi} 秒">
      <path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6"/><g fill="currentColor" opacity=".55">${dots}</g></svg>`;
  }

  function keepInputs() {   // 重新整理表格時，保留使用者改過的倍率、人數、站前在製品、站前上限
    const keep = {};
    card.querySelectorAll("input[data-f],input[data-k],input[data-i],input[data-c]").forEach((el) => {
      const [k, v] = Object.entries(el.dataset)[0];
      keep[k + ":" + v] = el.value;
    });
    return keep;
  }
  // 站前上限的預設值：依上方「站前上限」選單（資料庫設定／全部同一個數字／不限制）
  function capDefault(s) {
    const g = $("desWip").value;
    if (g === "none") return "";
    if (/^\d+$/.test(g)) return g;
    return s.wip_limit_in ?? "";
  }

  // 快慢範圍：最快 ─●─ 最慢（● = 平均），所有工站用同一把尺，方便互相比較
  function rangeSvg(p, lo, hi) {
    if (p.min == null) return '<span class="muted">—</span>';
    const W = 200, H = 18, x = (v) => 6 + (hi > lo ? (v - lo) / (hi - lo) : 0.5) * (W - 12);
    return `<svg class="des-range" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="最快 ${p.min} 秒、平均 ${p.mean} 秒、最慢 ${p.max} 秒">
      <line x1="${x(p.min).toFixed(1)}" x2="${Math.max(x(p.max), x(p.min) + 1).toFixed(1)}" y1="9" y2="9" class="rangeln"/>
      <circle cx="${x(p.mean).toFixed(1)}" cy="9" r="5" class="rangedot"><title>平均 ${p.mean} 秒</title></circle></svg>
      <small class="muted">${p.min}～${p.max} 秒</small>`;
  }

  function renderParams(keep = {}) {
    const m = model, mode = $("desMode").value;
    const lo = Math.min(...m.stations.filter((s) => s.pool.min != null).map((s) => s.pool.min));
    const hi = Math.max(...m.stations.filter((s) => s.pool.max != null).map((s) => s.pool.max));
    // 主表：學生只看每站平均和快慢範圍
    $("desStations").innerHTML = `<thead><tr><th>工站</th><th>平均 CT</th><th>快慢範圍（最快 ─●─ 最慢）</th></tr></thead><tbody>` +
      m.stations.map((s) => `<tr><td><b>${esc(s.station)}</b>${s.station === m.terminal ? ' <span class="tag">終點</span>' : ""}</td>
        <td>${s.pool.mean ?? "—"} 秒</td><td>${rangeSvg(s.pool, lo, hi)}</td></tr>`).join("") + "</tbody>";
    // 進階：資料筆數與來源、經驗分布圖、人數、作業時間倍率、站前在製品、站前上限
    $("desAdvStations").innerHTML = `<thead><tr><th>工站</th><th>前站（齊套）</th><th>資料筆數（本場 + 加入）</th>
      <th>經驗分布（累積分布）</th><th>人數</th><th>作業時間<br><small>100% = 照實際</small></th><th>站前在製品<br><small>開始時（件／套）</small></th><th>站前上限<br><small>空白 = 不限</small></th></tr></thead><tbody>` +
      m.stations.map((s) => {
        const o = s.own, a = s.added, p = s.pool;
        const addTxt = a.n ? ` + 加入 ${a.n}<br><small>${esc(s.used.slice(1).join("、"))}：平均 ${a.mean}（本場 ${o.mean ?? "—"}）</small>${s.diff_warn ? ` <span class="tag warn" title="加入的資料平均跟本場差 ${s.diff_pct}%，請確認做法相同再合併">差 ${s.diff_pct}%</span>` : ""}` : "";
        return `<tr>
        <td><b>${esc(s.station)}</b>${s.no_data ? ' <span class="tag warn">無資料</span>' : ""}</td>
        <td>${s.preds.length ? esc(s.preds.join(" + ")) : '<span class="muted">起點</span>'}</td>
        <td><b>${p.n}</b> <span class="des-lv des-lv-${s.level.code}">${LEVEL_ICON[s.level.code]} ${esc(s.level.label)}</span><br><small>本場 ${o.n}${addTxt}</small></td>
        <td>${cdfSvg(s.cdf, mode)}<br><small>${p.min ?? "—"}～${p.max ?? "—"} 秒｜平均 ${p.mean ?? "—"}｜中位數 ${p.median ?? "—"}</small></td>
        <td><input class="des-in" type="number" min="1" max="5" step="1" value="${keep["k:" + s.station] ?? 1}" data-k="${esc(s.station)}" aria-label="${esc(s.station)} 人數"></td>
        <td><input class="des-in" type="number" min="10" max="500" step="10" value="${keep["f:" + s.station] ?? 100}" data-f="${esc(s.station)}" aria-label="${esc(s.station)} 作業時間倍率"> %</td>
        ${s.preds.length ? `<td><input class="des-in" type="number" min="0" max="50" step="1" value="${keep["i:" + s.station] ?? s.init_wip_in ?? 0}" data-i="${esc(s.station)}" aria-label="${esc(s.station)} 開始時站前在製品"></td>
        <td><input class="des-in" type="number" min="1" max="50" step="1" value="${keep["c:" + s.station] ?? capDefault(s)}" data-c="${esc(s.station)}" placeholder="不限" aria-label="${esc(s.station)} 站前上限"></td>`
        : '<td colspan="2"><span class="muted">起點：原料無限，沒有站前在製品</span></td>'}</tr>`;
      }).join("") + "</tbody>";
    // 主畫面只留一行重點
    $("desDataLine").textContent = `資料：每站 ${m.min_samples} 筆以上${m.min_samples < 30 ? "（未達 30 筆，結果僅供參考）" : ""}｜流程：${m.flow_source.replace(/^沒有設定流程 → /, "沒有設定，")}`;
    const minN = m.min_samples;
    const notes = [`資料來源：${m.source_label}（只用已完成的紀錄）`, `資料最少的工站 ${minN} 筆${minN < 30 ? "，未達實務起點 30 筆，結果僅供參考；可在「資料來源」加入之前的資料" : ""}`,
      `流程：${m.flow_source}`, `站前上限：${m.wip_limit_source}`, `開始時站前在製品：${m.init_wip_source}`];
    if (m.other_rounds.length) {
      notes.push("本組其他場次：" + m.other_rounds.map((r) => `${r.label}（${r.records} 筆）${r.same_flow ? "✓ " : "✗ 不加入："}${r.reason}`).join("；"));
    } else {
      notes.push("本組沒有其他場次的資料");
    }
    if (m.missing_data.length) notes.push(`${m.missing_data.join("、")} 沒有任何資料，暫用全部資料的中位數`);
    if (m.ignored_stations.length) notes.push(`${m.ignored_stations.join("、")} 有紀錄但不在流程裡，模擬不使用`);
    $("desModelNote").textContent = notes.join("｜");
  }

  async function loadModel(force = false) {
    const t = target();
    const k = `${t.g}|${t.r}|${t.src}`;
    if (!force && k === key) return;
    const sameLine = key.split("|").slice(0, 2).join("|") === `${t.g}|${t.r}`;
    const keep = sameLine ? keepInputs() : {};
    key = k;
    if (!sameLine) $("desResult").hidden = true;
    if (!t.ok) {
      model = null;
      $("desTarget").textContent = "請先在上方「選擇組別」選一組、「選擇場次」選一個場次（例如 G23、第 1 次測試），就會用那一場已完成的加工時間建立經驗分布。";
      $("desStations").innerHTML = ""; $("desModelNote").textContent = "";
      $("desRun").disabled = true;
      return;
    }
    if (!model || !sameLine) $("desTarget").textContent = `模型：${t.g} ${roundLabel(t.r)}（讀取中…）`;
    loading = true;
    try {
      const m = await BrowserEngine.desModel(t.g, t.r, t.src);
      version = BrowserEngine.dataVersion();   // 這個模型用的是第幾版資料
      if (`${t.g}|${t.r}|${t.src}` !== key) return;   // 讀取途中又換了選擇
      if (!m.ok) { model = null; $("desTarget").textContent = m.error; $("desStations").innerHTML = ""; $("desModelNote").textContent = ""; $("desRun").disabled = true; return; }
      const firstLoad = !model || !sameLine;
      model = m;
      const a = m.actual;
      $("desTarget").innerHTML = `模型：<b>${esc(t.g)} ${roundLabel(t.r)}</b>　本場已完成：${a.output_sets} 組、總耗時 ${fmtSec(a.total_sec)}、產線 Cycle Time ${a.takt_sec ?? "—"} 秒/組、瓶頸 ${esc(a.bottleneck)}`;
      if (firstLoad) $("desN").value = a.output_sets || 10;
      renderParams(keep);
      $("desRun").disabled = false;
    } catch (e) {
      $("desTarget").textContent = `建立模型失敗：${e.message}`;
    } finally { loading = false; }
  }

  function params() {
    const factor = {}, servers = {};
    card.querySelectorAll("input[data-f]").forEach((el) => { const v = Number(el.value); if (v > 0 && v !== 100) factor[el.dataset.f] = v / 100; });
    card.querySelectorAll("input[data-k]").forEach((el) => { const v = Math.round(Number(el.value)); if (v > 1) servers[el.dataset.k] = v; });
    const wip = {}, init = {};   // 每一站分別設定：站前上限（空白 = 不限）、開始時站前在製品
    card.querySelectorAll("input[data-c]").forEach((el) => { const v = Math.round(Number(el.value)); wip[el.dataset.c] = el.value.trim() !== "" && v > 0 ? v : null; });
    card.querySelectorAll("input[data-i]").forEach((el) => { init[el.dataset.i] = Math.max(0, Math.round(Number(el.value) || 0)); });
    return { n_sets: Math.max(1, Math.round(Number($("desN").value) || 10)), reps: Math.max(10, Math.min(2000, Math.round(Number($("desR").value) || 200))),
      seed: Math.round(Number($("desSeed").value) || 2026), mode: $("desMode").value, wip, init, factor, servers,
      line_wip: Math.round(Number($("desLineWip").value)) > 0 ? Math.round(Number($("desLineWip").value)) : null };
  }

  // ---------- 簡化版的三張圖 ----------
  // 圖的寬度跟著畫面寬度（手機上字才不會縮得太小）
  const chartW = () => Math.max(300, Math.min(640, $("desResult").clientWidth || 640));
  // 1. 現況 vs 這次設定：兩根橫條（產線 CT，越短越快）
  function compareChart(r, base) {
    const same = !base || base === r;
    const rows = same ? [["現況", r.line_ct_sec.mean, "var(--muted)"]]
      : [["現況", base.line_ct_sec.mean, "var(--muted)"], ["這次設定", r.line_ct_sec.mean, "var(--accent)"]];
    const max = Math.max(...rows.map((x) => x[1]));
    const W = chartW(), L = 80, R = W < 480 ? 120 : 150, row = 36, H = rows.length * row + 6;
    const x = (v) => (v / max) * (W - L - R);
    let note = "";
    if (!same) {
      const d = (base.line_ct_sec.mean - r.line_ct_sec.mean) / base.line_ct_sec.mean * 100;
      note = d >= 0.5 ? `快了 ${d.toFixed(0)}%` : d <= -0.5 ? `慢了 ${(-d).toFixed(0)}%` : "差不多";
    }
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="現況與這次設定的產線 Cycle Time 比較">
      ${rows.map(([lab, v, c], i) => { const y = 4 + i * row; return `<text x="${L - 10}" y="${y + 20}" class="lb2" text-anchor="end">${lab}</text>
        <rect x="${L}" y="${y + 4}" width="${Math.max(2, x(v)).toFixed(1)}" height="22" rx="4" fill="${c}"><title>${lab}：${v} 秒/組</title></rect>
        <text x="${(L + x(v) + 8).toFixed(1)}" y="${y + 20}" class="vlb">${v} 秒/組${i === 1 ? `　${note}` : ""}</text>`; }).join("")}
    </svg>${same ? '<p class="hint">改上面的「人數」或「作業時間」再按「跑模擬」，這裡就會出現「這次設定」跟現況比較。</p>' : ""}`;
  }
  // 2. 甘特圖（第 1 次模擬）：每一列是一站、橫軸是時間；藍色格子 = 在加工（數字 = 第幾件），橘色 = 做完送不出去，空白 = 等料
  //    最上面一條 = 整條產線的在製品（WIP，數字 = 線上同時有幾件，顏色越深越多）
  function ganttChart(r) {
    const g = r.gantt, bott = r.bottleneck, servers = r.params.servers || {}, reps = r.completed_reps;
    if (!g || !g.jobs.length) return "";
    const line = r.line_wip || null;
    const W = chartW(), L = 78, R = 14, T = 6, B = 34, row = 36, end = g.end || 1;
    const lineH = line && line.timeline && line.timeline.length ? 30 : 0;
    const tops = g.stations.map((st, i) => T + lineH + i * row);
    const ay = T + lineH + g.stations.length * row + 4, H = ay + B, x = (t) => L + (Math.min(t, end) / end) * (W - L - R);
    const steps = [5, 10, 15, 20, 30, 60, 120, 300, 600, 900, 1800];
    const step = steps.find((v) => end / v <= (W < 480 ? 5 : 8)) || 3600;
    const tlab = (t) => (end < 120 ? `${t}` : `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, "0")}`);
    const ticks = []; for (let t = 0; t <= end + 0.01; t += step) ticks.push(t);
    // 產線 WIP 細條：件數一樣的時段畫成一格，0 件不畫
    const wipStrip = (pts, y, h, who) => {
      let out = "";
      for (let i = 0; i < pts.length - 1; i++) {
        const [a, w] = pts[i], b = pts[i + 1][0];
        if (w <= 0 || b <= a) continue;
        const x0 = x(a), wd = Math.max(1, x(b) - x(a) - 1);
        out += `<rect x="${x0.toFixed(1)}" y="${y.toFixed(1)}" width="${wd.toFixed(1)}" height="${h}" rx="2" class="gwip" fill-opacity="${Math.min(0.6, 0.18 + 0.1 * w).toFixed(2)}"><title>${who}：${a}～${b} 秒有 ${w} 件</title></rect>`;
        if (wd >= String(w).length * 6 + 3) out += `<text x="${(x0 + wd / 2).toFixed(1)}" y="${(y + h / 2 + 3.5).toFixed(1)}" class="wlb" text-anchor="middle">${w}</text>`;
      }
      return out;
    };
    // 先畫背景跑道和時間格線，再畫格子（格線才不會蓋住數字）
    let svg = g.stations.map((st, i) => `<rect x="${L}" y="${tops[i] + 5}" width="${W - L - R}" height="${row - 10}" rx="4" class="gtrack"/>`).join("") +
      ticks.map((t) => `<line x1="${x(t).toFixed(1)}" x2="${x(t).toFixed(1)}" y1="${T}" y2="${ay}" class="grid"/><text x="${x(t).toFixed(1)}" y="${ay + 13}" class="lb" text-anchor="middle">${tlab(t)}</text>`).join("");
    if (lineH) {   // 最上面：整條產線的在製品
      svg += `<text x="${L - 8}" y="${T + 12}" class="lb2" text-anchor="end">產線 WIP</text>
        <text x="${L - 8}" y="${T + 24}" class="lb" text-anchor="end">${line.limit ? `上限 ${line.limit} 件` : "不限"}</text>
        <rect x="${L}" y="${T + 3}" width="${W - L - R}" height="22" rx="3" class="gtrack"/>` + wipStrip(line.timeline, T + 3, 22, "整條產線");
    }
    g.stations.forEach((st, i) => {
      const y = tops[i];
      svg += `<text x="${L - 8}" y="${y + row / 2 + 4}" class="lb2" text-anchor="end">${esc(st)}${st === bott ? " ★" : ""}</text>`;
      // 好幾個人同時做：分成好幾條小跑道，避免格子疊在一起
      const k = Math.max(1, servers[st] || 1), lane = (row - 10) / k, laneEnd = Array(k).fill(-1);
      g.jobs.filter((j) => j[0] === st).sort((p, q) => p[1] - q[1]).forEach(([, a, b, num]) => {
        let li = laneEnd.findIndex((e) => e <= a + 1e-6); if (li < 0) li = 0; laneEnd[li] = b;
        const x0 = x(a), w = Math.max(1, x(b) - x(a) - 1.5), yy = y + 5 + li * lane;
        svg += `<rect x="${x0.toFixed(1)}" y="${yy.toFixed(1)}" width="${w.toFixed(1)}" height="${(lane - 1).toFixed(1)}" rx="3" class="gjob"><title>${esc(st)} 第 ${num} 件：${a}～${b} 秒（${(b - a).toFixed(1)} 秒）</title></rect>` +
          (w >= String(num).length * (lane >= 14 ? 6.4 : 5.2) + 3 && lane >= 10
            ? `<text x="${(x0 + w / 2).toFixed(1)}" y="${(yy + lane / 2 + (lane >= 14 ? 3.5 : 3)).toFixed(1)}" class="${lane >= 14 ? "seglb" : "seglb sm"}" text-anchor="middle">${num}</text>` : "");
      });
      g.blocked.filter((bk) => bk[0] === st).forEach(([, a, b]) => {
        svg += `<rect x="${x(a).toFixed(1)}" y="${(y + 5).toFixed(1)}" width="${Math.max(1, x(b) - x(a) - 1.5).toFixed(1)}" height="${row - 10}" rx="3" class="gblk"><title>${esc(st)} 做完送不出去（阻塞）：${a}～${b} 秒</title></rect>`;
      });
    });
    svg += `<text x="${(L + W - R) / 2}" y="${H - 2}" class="lb" text-anchor="middle">時間（${end < 120 ? "秒" : "分:秒"}）</text>`;
    const wipTxt = line ? `${reps} 次模擬合計：整條產線 WIP 平均 ${line.avg} 件、最多 ${line.max} 件${line.limit ? `（上限 ${line.limit} 件）` : ""}。` : "";
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="生產過程甘特圖：各站每一件的開始與結束時間，以及整條產線的在製品">${svg}</svg>
      <div class="des-legend"><span><i class="busy"></i>在加工（數字 = 第幾件）</span><span><i class="blk"></i>做完送不出去（阻塞）</span><span><i class="gap"></i>空白 = 等料（閒置）</span><span><i class="wip"></i>產線 WIP：線上同時有幾件（越深越多）</span><span>★ 瓶頸站</span></div>
      <p class="hint">這是 ${reps} 次模擬裡的第 1 次。每次抽到的加工時間不同，圖會有一點不一樣；上面的數字是 ${reps} 次的平均。${wipTxt}</p>`;
  }

  let lastRes = null, resizeT = null;
  function drawSimple() {
    if (!lastRes) return;
    const [r, base] = lastRes;
    $("desCompareBox").hidden = !base || base === r;   // 進階設定有改才比較
    $("desCompare").innerHTML = compareChart(r, base);
    $("desGantt").innerHTML = ganttChart(r);
  }
  window.addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(drawSimple, 150); });   // 轉向、縮放視窗時重畫

  function renderResult(r, base) {
    const a = model.actual, p = r.params;
    const range = (x, sec = false) => `<small>90% 落在 ${sec ? x.p5 : fmtSec(x.p5)}～${sec ? x.p95 + " 秒" : fmtSec(x.p95)}</small>`;
    const sameN = p.n_sets === a.output_sets && a.total_sec > 0;
    $("desResult").hidden = false;                 // 先顯示，圖才量得到寬度
    // 主畫面：4 張卡片
    $("desStats").innerHTML = [
      [`完成 ${p.n_sets} 組要多久（預測）`, fmtSec(r.makespan_sec.mean)],
      ["產線 Cycle Time（預測）", `${r.line_ct_sec.mean} 秒/組`],
      ["瓶頸站", esc(r.bottleneck)],
      [`實際（本場完成 ${a.output_sets} 組）`, `${fmtSec(a.total_sec)}<br><small>產線 Cycle Time ${a.takt_sec ?? "—"} 秒/組</small>`],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
    // 進階：範圍、每小時產出、理論最快
    $("desAdvStats").innerHTML = [
      [`完成 ${p.n_sets} 組要多久`, range(r.makespan_sec)],
      ["產線 Cycle Time", range(r.line_ct_sec, true)],
      ["每小時產出（預測）", `${r.throughput_per_hr} 組`],
      ["瓶頸站", `${esc(r.bottleneck)}<br><small>${r.bottleneck_share_pct}% 的模擬中是它</small>`],
      ["理論最快 Cycle Time", `${r.bound_ct_sec} 秒/組<br><small>受限於 ${esc(r.bound_station)}（平均加工時間 ÷ 人數）</small>`],
      ["整條產線 WIP", `平均 ${r.line_wip.avg} 件、最多 ${r.line_wip.max} 件<br><small>${r.line_wip.limit ? `上限 ${r.line_wip.limit} 件` : "不限"}（時間加權平均）</small>`],
    ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
    lastRes = [r, base];
    drawSimple();

    $("desStTable").innerHTML = `<thead><tr><th>工站</th><th>資料筆數</th><th>有效加工時間</th><th>利用率（在加工）</th><th>阻塞（做完送不出去）</th><th>閒置（等料）</th><th>當瓶頸的比例</th></tr></thead><tbody>` +
      r.stations.map((s) => `<tr${s.station === r.bottleneck ? ' class="des-bn"' : ""}><td>${esc(s.station)}${s.factor !== 1 ? ` <span class="tag">×${Math.round(s.factor * 100)}%</span>` : ""}${s.servers > 1 ? ` <span class="tag">${s.servers} 人</span>` : ""}</td>
        <td>${r.samples[s.station] ?? "—"}</td><td>${s.eff_time} 秒</td><td>${bar(s.util_pct, "var(--accent)")}</td><td>${bar(s.blocked_pct, "#a855f7")}</td><td>${bar(s.starved_pct, "#eab308")}</td><td>${s.bottleneck_share_pct}%</td></tr>`).join("") + "</tbody>";
    // 各站站前在製品（起點站原料無限，不列）
    const ws = r.stations.filter((s) => s.wip_avg !== undefined);
    $("desWipTable").innerHTML = `<thead><tr><th>工站</th><th>開始時</th><th>上限</th><th>平均在製品（時間加權）</th><th>最多同時</th><th>結束時還剩</th><th>每件平均在站前等待</th></tr></thead><tbody>` +
      ws.map((s) => `<tr${s.station === r.bottleneck ? ' class="des-bn"' : ""}><td>${esc(s.station)} 前</td><td>${s.init_wip}</td><td>${s.wip_limit ?? "不限"}</td>
        <td>${s.wip_avg} 件</td><td>${s.wip_max} 件</td><td>${s.wip_end} 件</td><td>${s.wait_avg == null ? "—" : fmtSec(s.wait_avg)}</td></tr>`).join("") + "</tbody>";
    $("desWipChart").innerHTML = wipCharts(r.wip_timeline, r.bottleneck);
    $("desBufTable").innerHTML = `<thead><tr><th>站間緩衝區</th><th>上限</th><th>平均 WIP（時間加權）</th><th>最多同時</th></tr></thead><tbody>` +
      r.buffers.map((b) => `<tr><td>${esc(b.buffer)}</td><td>${b.limit ?? "不限制"}</td><td>${b.avg_wip}</td><td>${b.max_wip}</td></tr>`).join("") + "</tbody>";

    const modeTxt = { cont: "連續型經驗分布（分段線性）", disc: "離散型經驗分布（重抽樣）", mean: "固定用平均值（沒有波動）" }[p.mode];
    const notes = [`加工時間：${modeTxt}｜資料來源：${r.data_source}，最少的工站 ${r.min_samples} 筆${r.min_samples < 30 ? "（未達 30 筆，僅供參考）" : ""}`,
      `重複 ${r.completed_reps} 次（亂數種子 ${p.seed}，同樣設定再跑一次結果會一樣）`];
    if (sameN) {
      const gap = (a.total_sec - r.makespan_sec.mean) / a.total_sec * 100;
      notes.push(gap > 0
        ? `實際比模擬多花 ${gap.toFixed(0)}% 的時間：模擬只算「加工 + 排隊等料 + 阻塞」，實際還有傳遞、溝通、走動、掃碼等時間`
        : `實際比模擬快 ${(-gap).toFixed(0)}%`);
    }
    $("desNote").textContent = notes.join("｜");
    // 圖 B：每一次模擬的結果
    $("desRepChart").innerHTML = repChart(r.reps_detail);
    $("desRepNote").textContent = repNote(r.reps_detail);
    $("desResult").hidden = false;
  }

  // 各站前在製品隨時間的變化（第 1 次模擬）：每一站一張小階梯圖，縱軸刻度相同方便比較
  function wipCharts(tl, bott) {
    const sts = Object.keys(tl || {}).sort();
    if (!sts.length) return "";
    const end = Math.max(...sts.map((s) => tl[s][tl[s].length - 1][0]), 1);
    const top = Math.max(1, ...sts.flatMap((s) => tl[s].map((p) => p[1])));
    const W = 260, H = 70, L = 22, B = 14;
    const x = (t) => L + (t / end) * (W - L - 4), y = (v) => 4 + (1 - v / top) * (H - B - 4);
    return sts.map((s) => {
      const pts = tl[s];
      let d = `M${x(0).toFixed(1)} ${y(pts[0][1]).toFixed(1)}`;
      for (let i = 1; i < pts.length; i++) d += ` H${x(pts[i][0]).toFixed(1)} V${y(pts[i][1]).toFixed(1)}`;
      const mx = Math.max(...pts.map((p) => p[1]));
      return `<figure class="des-wipfig${s === bott ? " bn" : ""}"><figcaption>${esc(s)} 前${s === bott ? "（瓶頸）" : ""}<span>最多 ${mx} 件</span></figcaption>
        <svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(s)} 前在製品隨時間變化，最多 ${mx} 件">
          <line x1="${L}" y1="${y(0)}" x2="${W - 4}" y2="${y(0)}" class="ax"/><text x="${L - 4}" y="${y(top) + 4}" class="lb" text-anchor="end">${top}</text>
          <text x="${L - 4}" y="${y(0) + 4}" class="lb" text-anchor="end">0</text><text x="${W - 4}" y="${H - 1}" class="lb" text-anchor="end">${fmtSec(end)}</text>
          <path d="${d}" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></figure>`;
    }).join("");
  }

  // ---------------- 圖 B：每一次模擬的結果（灰點 = 每一次的產線 CT；藍線 = 累積平均）
  function repChart(det) {
    if (!det || !det.length) return "";
    const ys = det.map((d) => d.ct), R = ys.length;
    const cum = []; let acc = 0;
    ys.forEach((y, i) => { acc += y; cum.push(acc / (i + 1)); });
    const fin = cum[R - 1];
    let lo = Math.min(...ys), hi = Math.max(...ys);
    const pad = (hi - lo || 1) * 0.08; lo -= pad; hi += pad;
    const W = 640, H = 240, L = 46, Rm = 14, T = 12, B = 34;
    const x = (i) => L + (R === 1 ? 0.5 : i / (R - 1)) * (W - L - Rm);
    const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const ticks = [0, 1, 2, 3, 4].map((k) => lo + (hi - lo) * k / 4);
    const xt = [...new Set([0, Math.round((R - 1) / 4), Math.round((R - 1) / 2), Math.round(3 * (R - 1) / 4), R - 1])];
    const dots = R <= 600
      ? ys.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${R > 200 ? 1.6 : 2.2}" class="dot"/>`).join("")
      : `<polyline points="${ys.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}" class="raw"/>`;
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${R} 次模擬的產線 Cycle Time 與累積平均，最後平均 ${fin.toFixed(1)} 秒/組">
      <rect x="${L}" y="${y(fin * 1.01).toFixed(1)}" width="${W - L - Rm}" height="${Math.max(1, y(fin * 0.99) - y(fin * 1.01)).toFixed(1)}" class="band"/>
      ${ticks.map((v) => `<line x1="${L}" x2="${W - Rm}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="grid"/><text x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" class="lb" text-anchor="end">${v.toFixed(1)}</text>`).join("")}
      ${xt.map((i) => `<text x="${x(i).toFixed(1)}" y="${H - 16}" class="lb" text-anchor="middle">${i + 1}</text>`).join("")}
      <text x="${(L + W - Rm) / 2}" y="${H - 2}" class="lb" text-anchor="middle">第幾次模擬</text>
      <text x="12" y="${(T + H - B) / 2}" class="lb" text-anchor="middle" transform="rotate(-90 12 ${(T + H - B) / 2})">產線 CT（秒/組）</text>
      ${dots}
      <line x1="${L}" x2="${W - Rm}" y1="${y(fin).toFixed(1)}" y2="${y(fin).toFixed(1)}" class="fin"/>
      <polyline points="${cum.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}" class="cum"/>
    </svg>
    <div class="des-legend"><span><i class="dot"></i>每一次的產線 CT</span><span><i class="cum"></i>累積平均（前 k 次的平均）</span><span><i class="band"></i>最後平均 ±1%</span></div>`;
  }
  // 累積平均從第幾次之後一直落在最後平均的 ±1% 以內 → 大概要跑幾次才夠
  function repNote(det) {
    if (!det || det.length < 2) return "";
    const ys = det.map((d) => d.ct), R = ys.length;
    const cum = []; let acc = 0;
    ys.forEach((y, i) => { acc += y; cum.push(acc / (i + 1)); });
    const fin = cum[R - 1];
    let k = R;
    for (let i = R - 1; i >= 0 && Math.abs(cum[i] - fin) <= fin * 0.01; i--) k = i + 1;
    const first10 = cum[Math.min(9, R - 1)];
    return `共 ${R} 次：每一次的產線 CT 介於 ${Math.min(...ys).toFixed(1)}～${Math.max(...ys).toFixed(1)} 秒/組（每次抽到的加工時間不同）。` +
      `前 ${Math.min(10, R)} 次的平均是 ${first10.toFixed(1)}，全部 ${R} 次是 ${fin.toFixed(1)}；` +
      (k < R ? `從第 ${k} 次之後，累積平均就一直在 ±1% 以內，代表跑 ${k} 次左右結果就穩定了。` : `累積平均還沒穩定在 ±1% 以內，建議增加模擬次數。`);
  }

  // ---------------- 模擬紀錄：每按一次「跑模擬」存一筆（存在這台電腦的瀏覽器裡）
  const REC_KEY = "des-records-v1", REC_MAX = 50;
  let records = [];
  try { records = JSON.parse(localStorage.getItem(REC_KEY) || "[]"); } catch { records = []; }
  const checked = new Set(records.slice(-5).map((r) => r.id));
  function persist() {
    try { localStorage.setItem(REC_KEY, JSON.stringify(records)); }
    catch {   // 瀏覽器空間不夠：舊紀錄只留摘要，不留每一次的結果
      records.forEach((r, i) => { if (i < records.length - 5) delete r.cts; });
      try { localStorage.setItem(REC_KEY, JSON.stringify(records)); } catch {}
    }
  }
  // 這一次跟預設不一樣的設定（倍率、人數、站前在製品、站前上限）
  function settingsText(p) {
    const out = [];
    Object.entries(p.factor || {}).forEach(([st, f]) => out.push(`${st} 時間×${Math.round(f * 100)}%`));
    Object.entries(p.servers || {}).forEach(([st, k]) => out.push(`${st} ${k} 人`));
    model.stations.forEach((s) => {
      if (!s.preds.length) return;
      const i = p.init?.[s.station] ?? 0, c = p.wip?.[s.station];
      if (i !== (s.init_wip_in ?? 0)) out.push(`${s.station} 前開始 ${i} 件`);
      if ((c ?? null) !== (s.wip_limit_in ?? null)) out.push(`${s.station} 前上限 ${c ?? "不限"}`);
    });
    if (p.line_wip) out.push(`產線 WIP 上限 ${p.line_wip} 件`);
    return out.length ? out.join("、") : "現況（預設設定）";
  }
  function saveRecord(r, t, base) {
    const p = params();
    const modeTxt = { cont: "連續型", disc: "離散型", mean: "固定平均" }[r.params.mode];
    const rec = {
      id: (records.length ? records[records.length - 1].id : 0) + 1, at: new Date().toISOString(),
      line: `${t.g} ${roundLabel(t.r)}`, source: model.source_label, dist: modeTxt, minSamples: r.min_samples,
      n: r.params.n_sets, reps: r.completed_reps, seed: r.params.seed, settings: settingsText(p),
      makespan: r.makespan_sec, ct: r.line_ct_sec, tp: r.throughput_per_hr, bott: r.bottleneck, bshare: r.bottleneck_share_pct,
      actual: { n: model.actual.output_sets, total: model.actual.total_sec, ct: model.actual.takt_sec },
      cts: r.reps_detail.map((d) => d.ct), seeds: [r.reps_detail[0]?.seed ?? r.params.seed],
      baseCt: base ? base.line_ct_sec.mean : null,
    };
    records.push(rec);
    while (records.length > REC_MAX) records.shift();
    checked.add(rec.id);
    persist();
    renderRecords();
  }
  const fmtAt = (iso) => new Date(iso).toLocaleString("zh-TW", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const fasterText = (r) => {
    if (r.baseCt == null || r.settings === "現況（預設設定）") return '<span class="muted">（現況）</span>';
    const d = (r.baseCt - r.ct.mean) / r.baseCt * 100;
    return d >= 0.5 ? `<b>快了 ${d.toFixed(0)}%</b>` : d <= -0.5 ? `慢了 ${(-d).toFixed(0)}%` : "差不多";
  };
  function renderRecords() {
    $("desHistBox").hidden = !records.length;
    $("desRecentBox").hidden = !records.length;
    if (!records.length) return;
    // 主畫面：最近 5 筆
    $("desRecent").innerHTML = `<thead><tr><th>時間</th><th>組別場次</th><th>模擬幾次</th><th>完成要多久</th><th>產線 Cycle Time</th><th>瓶頸</th></tr></thead><tbody>` +
      records.slice(-5).reverse().map((r) => `<tr><td>${fmtAt(r.at)}</td><td>${esc(r.line)}${r.settings !== "現況（預設設定）" ? `<br><small class="muted">改了：${esc(r.settings)}（${fasterText(r)}）</small>` : ""}</td>
        <td>${r.reps} 次</td><td>${r.n} 組：${fmtSec(r.makespan.mean)}</td><td>${r.ct.mean} 秒/組</td><td>${esc(r.bott)}</td></tr>`).join("") + "</tbody>";
    $("desHistTable").innerHTML = `<thead><tr><th></th><th>#</th><th>時間</th><th>組別場次</th><th>設定</th><th>資料、分布</th><th>做幾組</th><th>模擬次數</th>
      <th>完成時間（90% 範圍）</th><th>產線 CT（90% 範圍）</th><th>每小時</th><th>瓶頸</th></tr></thead><tbody>` +
      records.slice().reverse().map((r) => `<tr><td><input type="checkbox" data-rec="${r.id}" ${checked.has(r.id) ? "checked" : ""} aria-label="比較紀錄 ${r.id}"></td>
        <td>${r.id}</td><td>${fmtAt(r.at)}</td><td>${esc(r.line)}</td><td class="des-set">${esc(r.settings)}</td>
        <td><small>${esc(r.source)}，最少 ${r.minSamples} 筆；${esc(r.dist)}</small></td><td>${r.n}</td><td>${r.reps}</td>
        <td>${fmtSec(r.makespan.mean)}<br><small>${fmtSec(r.makespan.p5)}～${fmtSec(r.makespan.p95)}</small></td>
        <td><b>${r.ct.mean}</b> 秒/組<br><small>${r.ct.p5}～${r.ct.p95}</small></td><td>${r.tp} 組</td><td>${esc(r.bott)}<br><small>${r.bshare}%</small></td></tr>`).join("") + "</tbody>";
    $("desCmpChart").innerHTML = cmpChart(records.filter((r) => checked.has(r.id)));
  }
  // 比較勾選的紀錄：一般橫條圖，每筆一根（產線 CT 平均）
  function cmpChart(rs) {
    if (!rs.length) return '<p class="hint">勾選上表的紀錄，就會畫在這裡比較。</p>';
    const max = Math.max(...rs.map((r) => r.ct.mean));
    const W = 640, L = 230, R = 90, row = 30, H = rs.length * row + 4;
    const x = (v) => (v / max) * (W - L - R);
    const lab = (r) => { const s = `#${r.id} ${r.line}｜${r.settings}`; return s.length > 26 ? s.slice(0, 25) + "…" : s; };
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="比較 ${rs.length} 筆模擬紀錄的產線 Cycle Time">
      ${rs.map((r, i) => { const y = 2 + i * row; return `<text x="${L - 8}" y="${y + 16}" class="lb2" text-anchor="end"><title>#${r.id} ${esc(r.line)}｜${esc(r.settings)}</title>${esc(lab(r))}</text>
        <rect x="${L}" y="${y + 4}" width="${Math.max(2, x(r.ct.mean)).toFixed(1)}" height="20" rx="4" style="fill:var(--accent)"></rect>
        <text x="${(L + x(r.ct.mean) + 8).toFixed(1)}" y="${y + 18}" class="vlb">${r.ct.mean} 秒/組</text>`; }).join("")}
    </svg>`;
  }
  function csvDownload(name, rows) {
    const text = "﻿" + rows.map((r) => r.map((c) => { const v = String(c ?? ""); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }).join(",")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  $("desHistTable").addEventListener("change", (e) => {
    const id = Number(e.target.dataset.rec);
    if (!id) return;
    e.target.checked ? checked.add(id) : checked.delete(id);
    $("desCmpChart").innerHTML = cmpChart(records.filter((r) => checked.has(r.id)));
  });
  $("desHistCsv").onclick = () => csvDownload("模擬紀錄.csv", [["#", "時間", "組別場次", "設定", "資料來源", "經驗分布", "資料最少的工站筆數", "做幾組", "模擬次數", "亂數種子",
    "完成時間平均(秒)", "完成時間5%", "完成時間95%", "產線CT平均(秒/組)", "產線CT 5%", "產線CT 95%", "每小時產出(組)", "瓶頸", "瓶頸比例(%)", "實際組數", "實際總耗時(秒)", "實際產線CT"],
    ...records.map((r) => [r.id, fmtAt(r.at), r.line, r.settings, r.source, r.dist, r.minSamples, r.n, r.reps, r.seed,
      r.makespan.mean, r.makespan.p5, r.makespan.p95, r.ct.mean, r.ct.p5, r.ct.p95, r.tp, r.bott, r.bshare, r.actual.n, r.actual.total, r.actual.ct])]);
  $("desHistRepCsv").onclick = () => {
    const rs = records.filter((r) => checked.has(r.id) && r.cts);
    if (!rs.length) { alert("請先勾選要下載的紀錄"); return; }
    csvDownload("每一次模擬的結果.csv", [["紀錄#", "組別場次", "設定", "第幾次模擬", "亂數種子", "產線CT(秒/組)"],
      ...rs.flatMap((r) => r.cts.map((ct, i) => [r.id, r.line, r.settings, i + 1, r.seed + i, ct]))]);
  };
  $("desHistDel").onclick = () => {
    if (!checked.size) return;
    if (!confirm(`刪除勾選的 ${checked.size} 筆紀錄？`)) return;
    records = records.filter((r) => !checked.has(r.id)); checked.clear(); persist(); renderRecords();
  };
  $("desHistClear").onclick = () => {
    if (!confirm("清除全部模擬紀錄？（只會清這台電腦瀏覽器裡的紀錄）")) return;
    records = []; checked.clear(); persist(); renderRecords();
  };
  renderRecords();

  async function run() {
    if (!model || runBusy) return;
    const t = target();
    runBusy = true;
    $("desRun").disabled = true;
    $("desMsg").textContent = "模擬中…（第一次要先下載 Python）";
    const t0 = performance.now();
    try {
      const p = params();
      const r = await BrowserEngine.simulate(t.g, t.r, t.src, p);
      if (!r.ok) { $("desMsg").textContent = r.error; return; }
      // 有改設定時，用同樣的組數、次數、亂數種子再跑一次「現況」（不改任何設定）當比較基準
      let base = r;
      if (settingsText(p) !== "現況（預設設定）") {
        base = await BrowserEngine.simulate(t.g, t.r, t.src, { n_sets: p.n_sets, reps: p.reps, seed: p.seed, mode: p.mode, wip: "db", factor: {}, servers: {} });
        if (!base.ok) base = r;
      }
      renderResult(r, base);
      saveRecord(r, t, base);
      $("desMsg").textContent = `完成：${r.completed_reps} 次模擬，用了 ${((performance.now() - t0) / 1000).toFixed(1)} 秒`;
    } catch (e) {
      $("desMsg").textContent = `模擬失敗：${e.message}`;
    } finally { runBusy = false; $("desRun").disabled = !model; }
  }

  // ================= 變異與緩衝實驗（變異越大 → 需要越多緩衝 → 才能維持相同名義產出速率）
  const expCard = $("expCard");
  let expBusy = false, lastExp = null;
  if (expCard) expCard.hidden = false;
  const vColor = (i) => `var(--v${Math.min(i, 4)})`;
  const multLabel = (row) => `×${row.mult}（CV ${row.cv_avg}）`;
  const needText = (n) => (n == null ? "超過 10 件" : `${n} 件`);

  function expChart(x) {
    const bufs = x.buffers, rows = x.rows, tgt = x.target_pct;
    const all = rows.flatMap((r) => r.cells.map((c) => c.pct));
    const step = Math.min(...all, tgt) < 60 ? 10 : 5;                       // 刻度：5% 或 10% 一格
    const lo = Math.max(0, Math.floor((Math.min(...all, tgt) - 1) / step) * step), hi = Math.max(101, Math.ceil(Math.max(...all)));
    const W = 640, H = 270, L = 48, R = 16, T = 12, B = 44;
    const x0 = (i) => L + (i + 0.5) / bufs.length * (W - L - R);
    const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const ticks = []; for (let v = lo; v <= 100; v += step) ticks.push(v);
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="不同變異程度下，緩衝大小與產出達成率的關係">
      ${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="grid"/><text x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" class="lb" text-anchor="end">${v.toFixed(0)}%</text>`).join("")}
      ${bufs.map((b, i) => `<text x="${x0(i).toFixed(1)}" y="${H - 26}" class="lb" text-anchor="middle">${b}</text>`).join("")}
      <text x="${(L + W - R) / 2}" y="${H - 8}" class="lb" text-anchor="middle">緩衝（每站前最多放幾件，開始時放滿）</text>
      <text x="12" y="${(T + H - B) / 2}" class="lb" text-anchor="middle" transform="rotate(-90 12 ${(T + H - B) / 2})">產出達成率（實際 ÷ 名義）</text>
      <line x1="${L}" x2="${W - R}" y1="${y(tgt).toFixed(1)}" y2="${y(tgt).toFixed(1)}" class="tgt"/>
      <text x="${W - R}" y="${(y(tgt) - 5).toFixed(1)}" class="lb" text-anchor="end">目標 ${tgt}%</text>
      ${rows.map((r, ri) => `<polyline points="${r.cells.map((c, i) => `${x0(i).toFixed(1)},${y(c.pct).toFixed(1)}`).join(" ")}" fill="none" stroke="${vColor(ri)}" stroke-width="2"/>
        ${r.cells.map((c, i) => `<circle cx="${x0(i).toFixed(1)}" cy="${y(c.pct).toFixed(1)}" r="4.5" fill="${vColor(ri)}" stroke="var(--card)" stroke-width="2"><title>變異 ${multLabel(r)}，緩衝 ${c.buffer} 件：達成 ${c.pct}%（${c.th} 組/時），站前在製品合計 ${c.wip} 件</title></circle>`).join("")}`).join("")}
    </svg>
    <div class="des-legend">${rows.map((r, ri) => `<span><i style="background:${vColor(ri)};height:3px"></i>變異 ${multLabel(r)}${r.mult === 1 ? "＝實際資料" : ""}</span>`).join("")}</div>`;
  }

  function needChart(x) {
    const rows = x.rows, maxB = Math.max(...x.buffers);
    const W = 640, H = 220, L = 48, R = 16, T = 18, B = 46;
    const top = maxB + 1, bw = Math.min(70, (W - L - R) / rows.length * 0.55);
    const xc = (i) => L + (i + 0.5) / rows.length * (W - L - R);
    const y = (v) => T + (1 - v / top) * (H - T - B);
    const ticks = [0, maxB / 2, maxB];
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="各變異程度達到目標需要的緩衝件數">
      ${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="grid"/><text x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" class="lb" text-anchor="end">${v}</text>`).join("")}
      <text x="12" y="${(T + H - B) / 2}" class="lb" text-anchor="middle" transform="rotate(-90 12 ${(T + H - B) / 2})">需要的緩衝（件）</text>
      ${rows.map((r, i) => {
        const v = r.need == null ? top : r.need, h = y(0) - y(v), cx = xc(i);
        return `<path d="M${(cx - bw / 2).toFixed(1)} ${y(0).toFixed(1)} V${(y(v) + 4).toFixed(1)} q0 -4 4 -4 H${(cx + bw / 2 - 4).toFixed(1)} q4 0 4 4 V${y(0).toFixed(1)} Z" class="bar"${r.need == null ? ' opacity=".35"' : ""}><title>變異 ${multLabel(r)}：需要 ${needText(r.need)}</title></path>
          <text x="${cx.toFixed(1)}" y="${(y(v) - 6).toFixed(1)}" class="lb2" text-anchor="middle">${needText(r.need)}</text>
          <text x="${cx.toFixed(1)}" y="${H - 28}" class="lb" text-anchor="middle">×${r.mult}</text>
          <text x="${cx.toFixed(1)}" y="${H - 14}" class="lb" text-anchor="middle">CV ${r.cv_avg}</text>`;
      }).join("")}
    </svg>`;
  }

  function renderExp(x) {
    lastExp = x;
    const rows = x.rows, first = rows[0], last = rows[rows.length - 1];
    const needs = rows.map((r) => (r.need == null ? 99 : r.need));
    let concl;
    if (needs[needs.length - 1] > needs[0]) {
      concl = `變異從 ${multLabel(first)} 增加到 ${multLabel(last)}，要維持名義產出的 ${x.target_pct}%，需要的緩衝從 <b>${needText(first.need)}</b> 增加到 <b>${needText(last.need)}</b>：變異越大，需要越多緩衝。`;
    } else {
      concl = `在這些設定下，各種變異需要的緩衝都是 ${needText(first.need)}，看不出差別。`;
      if (!x.balanced) concl += "實際產線的瓶頸很明顯時，瓶頸前面永遠有料，緩衝的影響很小；可以改成「平衡產線」再跑一次。";
    }
    $("expConcl").innerHTML = concl;
    $("expStations").innerHTML = `<thead><tr><th>工站</th><th>平均（秒）</th><th>標準差 σ（秒）</th><th>變異係數 CV = σ ÷ 平均</th>${x.balanced ? "<th>平衡後的平均（秒）</th>" : ""}</tr></thead><tbody>` +
      x.stations.map((s) => `<tr${s.station === x.nominal_station ? ' class="des-bn"' : ""}><td>${esc(s.station)}${s.station === x.nominal_station ? ' <span class="tag">最慢</span>' : ""}</td><td>${s.mean}</td><td>${s.sd}</td><td>${s.cv}</td>${x.balanced ? `<td>${s.balanced_mean}</td>` : ""}</tr>`).join("") + "</tbody>";
    $("expChart").innerHTML = expChart(x);
    $("expNeedChart").innerHTML = needChart(x);
    $("expTable").innerHTML = `<thead><tr><th>變異</th>${x.buffers.map((b) => `<th>緩衝 ${b}</th>`).join("")}<th>達到 ${x.target_pct}% 需要</th></tr></thead><tbody>` +
      rows.map((r) => `<tr><td>${multLabel(r)}${r.mult === 1 ? "<br><small>實際資料</small>" : ""}</td>${r.cells.map((c) => `<td${c.buffer === r.need ? ' class="ok des-bn"' : ""}>${c.pct}%<br><small>${c.wip} 件</small></td>`).join("")}<td><b>${needText(r.need)}</b></td></tr>`).join("") + "</tbody>";
    $("expNote").textContent = [`名義產出速率 ${x.nominal} 組/小時（最慢站 ${x.nominal_station} 平均 ${x.nominal_ct} 秒/組${x.balanced ? "，平衡產線把各站平均都調成這個值" : ""}）`,
      `每一格跑 ${x.reps} 次、每次做 ${x.n_sets} 組，只算中間 80% 的產出；每一格用同一組亂數，差別只來自變異和緩衝`,
      `加工時間：${x.mode === "disc" ? "離散型" : "連續型"}經驗分布｜資料來源：${x.data_source}，最少的工站 ${x.min_samples} 筆`,
      `流程：${x.flow_source}`].join("｜");
    $("expResult").hidden = false;
  }

  $("expRun").onclick = async () => {
    if (!model || expBusy) return;
    const t = target(), p = params();
    expBusy = true; $("expRun").disabled = true;
    const reps = Math.max(5, Math.min(200, Math.round(Number($("expReps").value) || 30)));
    const n = Math.max(20, Math.min(500, Math.round(Number($("expN").value) || 100)));
    $("expMsg").textContent = `實驗中…共 5 種變異 × 5 種緩衝 = 25 格，每格 ${reps} 次（約 5～20 秒，畫面會暫停一下）`;
    await new Promise((ok) => setTimeout(ok, 60));      // 先讓提示文字顯示出來
    const t0 = performance.now();
    try {
      const x = await BrowserEngine.experiment(t.g, t.r, t.src, { n_sets: n, reps, seed: p.seed, mode: p.mode === "disc" ? "disc" : "cont",
        balanced: $("expBalanced").value === "1", target_pct: Number($("expTarget").value), factor: p.factor, servers: p.servers });
      if (!x.ok) { $("expMsg").textContent = x.error; return; }
      renderExp(x);
      $("expMsg").textContent = `完成：25 格 × ${reps} 次，用了 ${((performance.now() - t0) / 1000).toFixed(1)} 秒`;
    } catch (e) {
      $("expMsg").textContent = `實驗失敗：${e.message}`;
    } finally { expBusy = false; $("expRun").disabled = !model; }
  };
  $("expCsv").onclick = () => {
    if (!lastExp) return;
    const x = lastExp, t = target();
    csvDownload("變異與緩衝實驗.csv", [["組別場次", "產線", "變異倍率", "平均CV", "最大CV", "緩衝(件)", "產出(組/時)", "名義產出(組/時)", "達成率(%)", "站前在製品合計(件)", `達到${x.target_pct}%需要的緩衝`],
      ...x.rows.flatMap((r) => r.cells.map((c) => [`${t.g} ${roundLabel(t.r)}`, x.balanced ? "平衡" : "實際", r.mult, r.cv_avg, r.cv_max, c.buffer, c.th, x.nominal, c.pct, c.wip, r.need ?? "超過10"]))]);
  };
  setInterval(() => { if (!expBusy) $("expRun").disabled = !model; }, 800);

  $("desRun").onclick = () => run();
  $("desSource").onchange = () => loadModel(true);
  $("desMode").onchange = () => { if (model) renderParams(keepInputs()); };
  // 上方「站前上限」選單：一次把每一站的上限設成同一個（之後還可以個別修改）
  $("desWip").onchange = () => {
    if (!model) return;
    card.querySelectorAll("input[data-c]").forEach((el) => { el.value = capDefault(model.stations.find((s) => s.station === el.dataset.c) || {}); });
  };
  $("desReset").onclick = () => {
    $("desR").value = 200; $("desLineWip").value = ""; $("desSeed").value = 2026; $("desMode").value = "cont"; $("desWip").value = "db"; $("desSource").value = "round";
    $("desMsg").textContent = "";
    key = ""; model = null;
    loadModel(true);
  };
  // 上方的組別、場次一改就重建模型（app.js 也可能用網址參數設定選擇，所以定時檢查）
  setInterval(() => { if (!loading) loadModel(); }, 800);
  // 每 5 秒輕量檢查一次資料庫，有新完成的紀錄就更新各站經驗分布（保留改過的倍率、人數）
  let checking = false, checkAgain = false;
  async function checkData() {
    if (checking || loading) { checkAgain = true; return; }
    if (!target().ok) return;
    checking = true;
    try {
      const v = await BrowserEngine.desRefresh();
      if (v !== version) await loadModel(true);   // 資料有新版本 → 重建模型
    } catch {}
    finally {
      checking = false;
      if (checkAgain) { checkAgain = false; setTimeout(checkData, 0); }
    }
  }
  setInterval(checkData, 5000);
})();
