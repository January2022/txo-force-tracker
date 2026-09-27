#!/usr/bin/env node
// Downloads TAIFEX's "期貨商買賣日報表－選擇權" CSVs for TXO, aggregates them with
// the same logic as the browser dashboard, and writes JSON snapshots under
// docs/data/ for the static site to read. Runs unattended in GitHub Actions.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import iconv from 'iconv-lite';
import { computeBatch, buildSnapshotForExp, parseCSV } from './lib.mjs';

const BASE = 'https://www.taifex.com.tw';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Referer': BASE + '/cht/3/dailyOptions',
};

let cookieJar = {};
function cookieHeader() { return Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; '); }
function absorbCookies(res) {
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const sc of setCookies) {
    const first = sc.split(';')[0];
    const eq = first.indexOf('=');
    if (eq > 0) cookieJar[first.slice(0, eq)] = first.slice(eq + 1);
  }
}
async function httpGet(url) {
  const res = await fetch(url, { headers: { ...HEADERS, Cookie: cookieHeader() } });
  absorbCookies(res);
  return res;
}
async function httpPost(url, fields) {
  const body = new URLSearchParams(fields).toString();
  const res = await fetch(url, { method: 'POST', headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader() }, body });
  absorbCookies(res);
  return res;
}

async function getQueryDates() {
  const res = await httpGet(BASE + '/cht/3/dailyOptions');
  const html = await res.text();
  const m1 = html.match(/id="queryDate"[^>]*value="(\d{8})"/);
  const m2 = html.match(/id="queryDateAh"[^>]*value="(\d{8})"/);
  if (!m1 || !m2) throw new Error('找不到目前交易日期，期交所頁面格式可能已變更');
  return [m1[1], m2[1]];
}
async function getSettlemonList(queryDate, marketcode) {
  const res = await httpGet(`${BASE}/cht/3/getFcmOptSetMonth.do?queryDate=${queryDate}&marketcode=${marketcode}&commodityId=TXO`);
  const data = await res.json();
  let items = null;
  for (const v of Object.values(data)) if (Array.isArray(v) && v.length && typeof v[0] === 'object') { items = v; break; }
  if (!items) throw new Error('getFcmOptSetMonth.do 回傳格式無法解析：' + JSON.stringify(data));
  const out = [];
  for (const it of items) {
    let val = null;
    for (const [k, v] of Object.entries(it)) if (k.toUpperCase().includes('SETTLE')) { val = String(v).trim(); break; }
    if (val && !out.includes(val)) out.push(val);
  }
  return out;
}
async function downloadOne(queryDate, queryDateAh, marketcode, settlemon, pccode) {
  const fields = { queryDate, queryDateAh, commodityId: 'TXO', commodityId2: '', marketcode, doQuery: '1', doQueryPage: '', totalpage: '', curpage: '1', MarketCode: marketcode, commodity_idt: 'TXO', commodity_id2t: '', settlemon, pccode };
  await httpPost(BASE + '/cht/3/dailyOptions', fields);
  const res = await httpPost(BASE + '/cht/3/dailyOptionsDown', fields);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const session = process.argv[2];
  if (session !== 'day' && session !== 'night') { console.error('用法: node fetch_and_build.mjs day|night [期別數]'); process.exit(1); }
  const periodsCount = parseInt(process.argv[3] || '4', 10);
  const marketcode = session === 'day' ? '0' : '1';

  const [queryDate, queryDateAh] = await getQueryDates();
  const reportDate = session === 'day' ? queryDate : queryDateAh;
  console.log(`查詢日期：一般=${queryDate} 盤後=${queryDateAh}（本次抓取：${session}，報表日期 ${reportDate}）`);

  const settlemons = (await getSettlemonList(reportDate, marketcode)).slice(0, periodsCount);
  if (!settlemons.length) { console.log('找不到可用期別，可能當天尚無資料。'); return; }
  console.log('本次期別：' + settlemons.join(', '));

  const brokerDirectory = {};
  const filesByKey = {};
  for (const sm of settlemons) {
    for (const pc of ['C', 'P']) {
      let buf;
      try { buf = await downloadOne(queryDate, queryDateAh, marketcode, sm, pc); }
      catch (e) { console.log(`  [失敗] ${sm} ${pc}：${e.message}`); continue; }
      if (buf.length < 50 || buf.subarray(0, 200).toString('latin1').includes('<html')) {
        console.log(`  [略過] ${sm} ${pc}：尚無資料`); continue;
      }
      const text = iconv.decode(buf, 'big5');
      const parsed = parseCSV(text);
      if (parsed) { filesByKey[parsed.exp + '_' + parsed.cp] = parsed; console.log(`  [完成] ${sm} ${pc} (${buf.length.toLocaleString()} bytes)`); }
    }
  }
  if (!Object.keys(filesByKey).length) { console.log('本次沒有抓到任何有效資料，不更新快照。'); return; }

  const exps = computeBatch(filesByKey, brokerDirectory).map(buildSnapshotForExp);
  const snapshot = { date: reportDate, session, exps, uploadedAt: Date.now(), schema: 2, source: 'github-actions' };

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const snapDir = path.join(root, 'docs', 'data', 'snapshots');
  await fs.mkdir(snapDir, { recursive: true });
  const fname = `${reportDate}_${session}.json`;
  await fs.writeFile(path.join(snapDir, fname), JSON.stringify(snapshot));
  console.log('已寫入 ' + fname);

  const indexPath = path.join(root, 'docs', 'data', 'index.json');
  let index = [];
  try { index = JSON.parse(await fs.readFile(indexPath, 'utf8')); } catch (e) { index = []; }
  const key = reportDate + '_' + session;
  index = index.filter(e => e.key !== key);
  index.push({ key, date: reportDate, session, file: 'snapshots/' + fname, uploadedAt: snapshot.uploadedAt });
  index.sort((a, b) => a.key < b.key ? 1 : -1);
  await fs.writeFile(indexPath, JSON.stringify(index, null, 1));
  console.log(`共 ${Object.keys(filesByKey).length} 個檔案，${exps.length} 個期別，已更新 index.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
