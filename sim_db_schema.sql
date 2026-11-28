-- =====================================================================================
-- 模擬結果資料庫（新的 Supabase 專案用，跟老師收集資料的資料庫分開）
--
-- 用法：Supabase 專案 → 左邊 SQL Editor → New query → 整份貼上 → Run（只要執行一次；重跑也不會壞）
--
-- 三張表：
--   sim_run      每存一次 = 一筆（組別、場次、設定、完成時間、產線 Cycle Time、瓶頸、產線 WIP…）
--   sim_station  那一次模擬每一站的結果（利用率、阻塞、閒置、站前在製品…）
--   sim_rep      那一次模擬「每一次重複」的結果（第幾次、完成時間、產線 CT、瓶頸）
--
-- 權限（防止學生改資料）：
--   學生用公開金鑰（publishable key）只能「讀」三張表，不能新增、修改、刪除
--   要存資料只能呼叫 save_simulation()：資料庫會先檢查格式和數字合不合理，三張表一起寫入（要嘛全部成功、要嘛全部不寫）
--   同一個結果存第二次不會重複，會回傳之前那一筆的編號
-- =====================================================================================

create table if not exists public.sim_run (
  id                   bigint generated always as identity primary key,
  created_at           timestamptz not null default now(),
  group_id             text    not null check (group_id ~ '^G[0-9]{1,3}$'),
  round                text    not null check (round ~ '^(TEST[0-9]{1,2}|FORMAL)$'),
  round_label          text,
  data_source          text,                       -- 加工時間資料來源（只用本場／加入流程相同的場次…）
  dist_mode            text    not null check (dist_mode in ('cont', 'disc', 'mean')),
  n_sets               int     not null check (n_sets between 1 and 200),       -- 要生產幾組
  reps                 int     not null check (reps between 10 and 2000),       -- 模擬幾次
  seed                 int     not null,                                        -- 亂數種子
  line_wip_limit       int     check (line_wip_limit is null or line_wip_limit between 1 and 99),  -- 產線 WIP 上限（空 = 不限）
  settings_text        text,                       -- 跟現況不一樣的設定（文字，例如「ST03 2 人」）
  settings             jsonb   not null default '{}'::jsonb,  -- 完整設定（人數、作業時間倍率、站前上限、開始時站前在製品）
  makespan_mean        numeric not null check (makespan_mean > 0),   -- 完成 N 組要多久（秒，平均）
  makespan_p5          numeric,
  makespan_p95         numeric,
  line_ct_mean         numeric not null check (line_ct_mean > 0),    -- 產線 Cycle Time（秒/組，平均）
  line_ct_p5           numeric,
  line_ct_p95          numeric,
  throughput_per_hr    numeric,                    -- 每小時產出（組）
  bottleneck           text    not null,           -- 瓶頸站
  bottleneck_share_pct numeric,                    -- 幾 % 的模擬中是它
  bound_station        text,                       -- 理論最快受限的站
  bound_ct_sec         numeric,                    -- 理論最快 Cycle Time
  line_wip_avg         numeric,                    -- 整條產線 WIP（時間加權平均）
  line_wip_max         int,                        -- 整條產線 WIP（最多）
  actual_sets          int,                        -- 實際：本場完成幾組
  actual_total_sec     numeric,                    -- 實際：總耗時（秒）
  actual_ct_sec        numeric,                    -- 實際：產線 Cycle Time
  actual_bottleneck    text,
  min_samples          int,                        -- 資料最少的工站有幾筆
  data_events          int,                        -- 本場用了幾筆完工紀錄
  gantt                jsonb,                      -- 第 1 次模擬的甘特圖資料
  fingerprint          text    not null unique     -- 防止同一個結果存兩次（資料庫自己算）
);

create table if not exists public.sim_station (
  run_id               bigint  not null references public.sim_run(id) on delete cascade,
  station              text    not null check (station ~ '^ST[0-9]{1,3}$'),
  servers              int     not null default 1,     -- 人數
  time_factor          numeric not null default 1,     -- 作業時間倍率（1 = 照實際）
  eff_time_sec         numeric,                        -- 有效加工時間（平均 × 倍率 ÷ 人數）
  samples              int,                            -- 資料筆數
  util_pct             numeric,                        -- 利用率（在加工）
  blocked_pct          numeric,                        -- 阻塞（做完送不出去）
  starved_pct          numeric,                        -- 閒置（等料）
  bottleneck_share_pct numeric,                        -- 當瓶頸的比例
  init_wip             int,                            -- 開始時站前在製品（起點站沒有）
  wip_limit            int,                            -- 站前上限（空 = 不限）
  wip_avg              numeric,                        -- 站前在製品平均（時間加權）
  wip_max              int,                            -- 站前在製品最多
  wip_end              numeric,                        -- 結束時站前還剩
  wait_avg_sec         numeric,                        -- 每件平均在站前等待（秒）
  primary key (run_id, station)
);

create table if not exists public.sim_rep (
  run_id               bigint  not null references public.sim_run(id) on delete cascade,
  rep_no               int     not null check (rep_no >= 1),   -- 第幾次模擬
  seed                 int,
  makespan_sec         numeric not null,
  ct_sec               numeric not null,
  bottleneck           text,
  primary key (run_id, rep_no)
);

create index if not exists sim_run_group_round on public.sim_run (group_id, round, created_at desc);

-- ---------------------------------------------------------------- 權限：大家都能讀，不能直接寫
alter table public.sim_run     enable row level security;
alter table public.sim_station enable row level security;
alter table public.sim_rep     enable row level security;

drop policy if exists "所有人可以讀" on public.sim_run;
drop policy if exists "所有人可以讀" on public.sim_station;
drop policy if exists "所有人可以讀" on public.sim_rep;
create policy "所有人可以讀" on public.sim_run     for select to anon, authenticated using (true);
create policy "所有人可以讀" on public.sim_station for select to anon, authenticated using (true);
create policy "所有人可以讀" on public.sim_rep     for select to anon, authenticated using (true);

revoke insert, update, delete, truncate on public.sim_run, public.sim_station, public.sim_rep from anon, authenticated;
grant select on public.sim_run, public.sim_station, public.sim_rep to anon, authenticated;

-- ---------------------------------------------------------------- 存檔：唯一的寫入方式（含防呆檢查）
create or replace function public.save_simulation(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  rid      bigint;
  fp       text;
  n_st     int;
  n_rep    int;
  recent   int;
begin
  -- 1. 必要欄位與格式
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception '資料格式不對';
  end if;
  if coalesce(p->>'group_id', '') !~ '^G[0-9]{1,3}$' then
    raise exception '組別格式不對（應該像 G09）：%', p->>'group_id';
  end if;
  if coalesce(p->>'round', '') !~ '^(TEST[0-9]{1,2}|FORMAL)$' then
    raise exception '場次格式不對（應該像 TEST1 或 FORMAL）：%', p->>'round';
  end if;
  n_st  := coalesce(jsonb_array_length(p->'stations'), 0);
  n_rep := coalesce(jsonb_array_length(p->'reps'), 0);
  if n_st < 1 or n_st > 50 then
    raise exception '工站數不合理：%', n_st;
  end if;
  if n_rep <> (p->>'reps_count')::int then
    raise exception '每一次的結果筆數（%）跟模擬次數（%）對不上', n_rep, p->>'reps_count';
  end if;

  -- 2. 防止有人一直按（整個資料庫每分鐘最多 120 筆）
  select count(*) into recent from sim_run where created_at > now() - interval '1 minute';
  if recent >= 120 then
    raise exception '存檔太頻繁，請等一分鐘再試';
  end if;

  -- 3. 同一個結果（同組別場次、同設定、同亂數種子、同資料 → 結果一定一樣）只存一次
  fp := md5(concat_ws('|', p->>'group_id', p->>'round', p->>'data_source', p->>'dist_mode', p->>'n_sets',
                      p->>'reps_count', p->>'seed', p->>'line_wip_limit', (p->'settings')::text, p->>'data_events',
                      p->>'makespan_mean', p->>'line_ct_mean'));
  select id into rid from sim_run where fingerprint = fp;
  if rid is not null then
    return jsonb_build_object('id', rid, 'duplicate', true);
  end if;

  -- 4. 寫入三張表（數字範圍不合理時，表上的檢查會擋下來，三張表都不會寫）
  insert into sim_run (group_id, round, round_label, data_source, dist_mode, n_sets, reps, seed, line_wip_limit,
                       settings_text, settings, makespan_mean, makespan_p5, makespan_p95, line_ct_mean, line_ct_p5,
                       line_ct_p95, throughput_per_hr, bottleneck, bottleneck_share_pct, bound_station, bound_ct_sec,
                       line_wip_avg, line_wip_max, actual_sets, actual_total_sec, actual_ct_sec, actual_bottleneck,
                       min_samples, data_events, gantt, fingerprint)
  values (p->>'group_id', p->>'round', p->>'round_label', p->>'data_source', p->>'dist_mode',
          (p->>'n_sets')::int, (p->>'reps_count')::int, (p->>'seed')::int, nullif(p->>'line_wip_limit', '')::int,
          p->>'settings_text', coalesce(p->'settings', '{}'::jsonb),
          (p->>'makespan_mean')::numeric, (p->>'makespan_p5')::numeric, (p->>'makespan_p95')::numeric,
          (p->>'line_ct_mean')::numeric, (p->>'line_ct_p5')::numeric, (p->>'line_ct_p95')::numeric,
          (p->>'throughput_per_hr')::numeric, p->>'bottleneck', (p->>'bottleneck_share_pct')::numeric,
          p->>'bound_station', (p->>'bound_ct_sec')::numeric,
          (p->>'line_wip_avg')::numeric, (p->>'line_wip_max')::int,
          (p->>'actual_sets')::int, (p->>'actual_total_sec')::numeric, (p->>'actual_ct_sec')::numeric,
          p->>'actual_bottleneck', (p->>'min_samples')::int, (p->>'data_events')::int, p->'gantt', fp)
  returning id into rid;

  insert into sim_station (run_id, station, servers, time_factor, eff_time_sec, samples, util_pct, blocked_pct,
                           starved_pct, bottleneck_share_pct, init_wip, wip_limit, wip_avg, wip_max, wip_end, wait_avg_sec)
  select rid, x.station, coalesce(x.servers, 1), coalesce(x.time_factor, 1), x.eff_time_sec, x.samples, x.util_pct,
         x.blocked_pct, x.starved_pct, x.bottleneck_share_pct, x.init_wip, x.wip_limit, x.wip_avg, x.wip_max,
         x.wip_end, x.wait_avg_sec
  from jsonb_to_recordset(p->'stations') as x(station text, servers int, time_factor numeric, eff_time_sec numeric,
       samples int, util_pct numeric, blocked_pct numeric, starved_pct numeric, bottleneck_share_pct numeric,
       init_wip int, wip_limit int, wip_avg numeric, wip_max int, wip_end numeric, wait_avg_sec numeric);

  insert into sim_rep (run_id, rep_no, seed, makespan_sec, ct_sec, bottleneck)
  select rid, x.rep_no, x.seed, x.makespan_sec, x.ct_sec, x.bottleneck
  from jsonb_to_recordset(p->'reps') as x(rep_no int, seed int, makespan_sec numeric, ct_sec numeric, bottleneck text);

  return jsonb_build_object('id', rid, 'duplicate', false);
end;
$$;

revoke all on function public.save_simulation(jsonb) from public;
grant execute on function public.save_simulation(jsonb) to anon, authenticated;
