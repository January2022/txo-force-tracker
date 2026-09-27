# TXO 力道站（自動版）

追蹤台指選擇權（TXO）外資／自營／八大行庫在各履約價的買賣力道，資料來源為臺灣期貨交易所公開的
「期貨商買賣日報表－選擇權」。由 GitHub Actions 每天自動下載、分析並更新，任何人打開網站即可看到
最新結果，不需要手動上傳任何檔案。

**網站：** https://january2022.github.io/txo-force-tracker/

## 運作方式

1. `.github/workflows/update.yml` 每天約 18:30（日盤）、07:30（夜盤，台北時間）自動觸發，
   也可以在 GitHub 網頁的 Actions 分頁手動點「Run workflow」立即執行。
2. `scripts/fetch_and_build.mjs` 模擬期交所網頁「下載檔案」按鈕，下載當次各到期月份(週別)的
   Call/Put 成交明細，用 `scripts/lib.mjs` 的邏輯分類、彙總，寫成 JSON 存到 `docs/data/`。
3. `docs/index.html` 是純前端網頁，讀取 `docs/data/index.json` 與對應的快照 JSON 呈現畫面，
   由 GitHub Pages 直接以靜態網頁託管。

## 分類邏輯

依期貨商代號推估（非期交所官方「三大法人」統計）：

- `F034`（澳帝華期貨，主要造市商）→ 造市商，**不計入法人合計**
- 代號開頭 `S` 的證券商 → 自營
- 名稱包含外商券商關鍵字 → 外資
- 名稱包含公股行庫關鍵字 → 八大行庫
- 其餘期貨商 → 期貨經紀

如需調整分類，直接編輯 `scripts/lib.mjs` 裡的 `FOREIGN`／`BANK` 關鍵字清單或 `defCat()` 函式。

## 本機測試

```bash
npm install
node scripts/fetch_and_build.mjs day 4
```

會在 `docs/data/` 產生／更新快照，然後可以直接用瀏覽器打開 `docs/index.html` 預覽（部分瀏覽器
對 `file://` 開啟本地 fetch 有限制，建議用 `npx serve docs` 之類的本地伺服器預覽）。
