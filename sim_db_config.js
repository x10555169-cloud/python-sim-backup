// ===== 模擬結果資料庫（新的 Supabase 專案，只放模擬結果；跟老師收集資料的資料庫分開）=====
// 建好 Supabase 專案、執行 sim_db_schema.sql 之後，把下面兩行換成那個專案的網址和 publishable key：
//   Supabase → Project Settings → API Keys（或 Data API）→ Project URL、Publishable key（sb_publishable_ 開頭）
// publishable key 可以公開：資料庫設定成「只能讀、只能透過存檔函式寫入」，學生拿到也不能改或刪資料
// 絕對不要放 secret key（sb_secret_ 開頭）或 service_role key
window.SIM_DB = {
  URL: "",
  KEY: "",
};
