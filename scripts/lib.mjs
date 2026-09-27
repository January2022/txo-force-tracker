// Shared TXO parsing / classification / aggregation logic.
// Kept in exact numerical agreement with the CSV format TAIFEX publishes for
// "期貨商買賣日報表－選擇權" (per-broker trade detail). See README.md.

export const INST = ['外資', '自營', '八大行庫'];
export const COLS = ['外資', '自營', '八大行庫', '法人合計', '期貨經紀', '造市商'];
const FOREIGN = ['法銀巴黎', '摩根大通', '美林', '摩根士丹利', '高盛', '花旗', '瑞銀', '瑞士銀行', '麥格理', '德意志', '匯豐', '野村', '瑞士信貸', '瑞信', '巴克萊', '里昂', '荷蘭', '渣打', '港商', '新加坡商'];
const BANK = ['華南', '兆豐', '第一金', '合庫', '合作金庫', '臺銀', '台銀', '土銀', '土地銀', '彰銀', '彰化', '台企', '企銀'];

export function defCat(code, name) {
  if (code === 'F034') return '造市商';
  if (FOREIGN.some(k => (name || '').includes(k))) return '外資';
  if (BANK.some(k => (name || '').includes(k))) return '八大行庫';
  if (code[0] === 'S') return '自營';
  return '期貨經紀';
}

export function expInfo(exp) {
  const m = exp.match(/^(\d{4})(\d{2})([WF])?(\d)?$/);
  if (!m) return { label: exp, date: null, t: 9e15 };
  const y = +m[1], mo = +m[2] - 1;
  const nth = (dow, n) => { const d = new Date(Date.UTC(y, mo, 1)); const off = (dow - d.getUTCDay() + 7) % 7; return new Date(Date.UTC(y, mo, 1 + off + 7 * (n - 1))); };
  let dt, label;
  if (!m[3]) { dt = nth(3, 3); label = (mo + 1) + '月 月選'; }
  else if (m[3] === 'W') { dt = nth(3, +m[4]); label = (mo + 1) + '月 第' + m[4] + '週三'; }
  else { dt = nth(5, +m[4]); label = (mo + 1) + '月 第' + m[4] + '週五'; }
  const ds = (dt.getUTCMonth() + 1) + '/' + dt.getUTCDate();
  return { label, date: ds, t: dt.getTime() + (m[3] ? 0 : 1) };
}

// Parse one CSV's decoded text into {date, exp, cp, trades[]}
export function parseCSV(txt) {
  const lines = txt.replace(/^﻿/, '').split(/\r?\n/);
  const h = lines[0] || '';
  const m = h.match(/到期月份[：:]\s*(\S+?)\s/) || h.match(/到期月份[：:]\s*([0-9A-Z]+)/);
  const c = h.match(/買\/賣權[：:]\s*([CP])/);
  const d = h.match(/交易日期[：:]\s*(\d{8})/);
  const exp = m && m[1].replace(/,+$/, '');
  const cp = c && c[1];
  const date = (d && d[1]) || '';
  if (!exp || !cp || !date) return null;
  const trades = [];
  let cur = null;
  const brokers = {};
  for (let i = 2; i < lines.length; i++) {
    const r = lines[i].split(',').map(s => s.trim());
    if (r.length < 7) continue;
    if (r[1] !== '' && !isNaN(+r[1]) && r[0] !== '') { cur = { k: +r[0], p: +r[1], v: +r[2] || 0, b: [], s: [] }; trades.push(cur); }
    if (!cur) continue;
    if (r[3]) { cur.b.push(r[3]); brokers[r[3]] = r[4]; }
    if (r[5]) { cur.s.push(r[5]); brokers[r[5]] = r[6]; }
  }
  return { exp, cp, date, trades, brokers };
}

function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }

// Aggregate a batch of parsed files (one date+session) into per-expiry structures.
export function computeBatch(filesByKey, brokerDirectory) {
  const exps = {};
  for (const key in filesByKey) {
    const f = filesByKey[key];
    Object.assign(brokerDirectory, f.brokers);
    const E = exps[f.exp] || (exps[f.exp] = { exp: f.exp, info: expInfo(f.exp), C: {}, P: {}, vol: { C: 0, P: 0 }, px: { C: {}, P: {} }, has: {} });
    E.has[f.cp] = true;
    for (const t of f.trades) {
      E.vol[f.cp] += t.v;
      const px = E.px[f.cp][t.k] || (E.px[f.cp][t.k] = { v: 0, a: 0 }); px.v += t.v; px.a += t.v * t.p;
      const S = E[f.cp][t.k] || (E[f.cp][t.k] = { vol: 0 }); S.vol += t.v;
      for (const [arr, sg] of [[t.b, 1], [t.s, -1]]) {
        if (!arr.length) continue;
        const sh = t.v / arr.length;
        for (const code of arr) {
          const g = defCat(code, brokerDirectory[code]); if (g === '排除') continue;
          const o = S[g] || (S[g] = { n: 0, m: 0, gr: 0 });
          o.n += sg * sh; o.m += sg * sh * t.p * 50; o.gr += sh;
          if (INST.includes(g)) { const q = S['法人合計'] || (S['法人合計'] = { n: 0, m: 0, gr: 0 }); q.n += sg * sh; q.m += sg * sh * t.p * 50; q.gr += sh; }
        }
      }
    }
  }
  for (const e in exps) {
    const E = exps[e]; let best = null;
    for (const k in E.px.C) {
      const c = E.px.C[k], p = E.px.P[k]; if (!p) continue;
      const cv = c.a / c.v, pv = p.a / p.v, diff = Math.abs(cv - pv);
      if (!best || diff < best.d) best = { d: diff, k: +k, F: +k + cv - pv };
    }
    E.atm = best;
  }
  return Object.values(exps);
}
function sideSumRaw(E, cp, g) { let n = 0, m = 0, gr = 0; for (const k in E[cp]) { const o = E[cp][k][g]; if (o) { n += o.n; m += o.m; gr += o.gr; } } return { n, m, gr }; }
function topMovesRaw(E, cp, g, sign, n) {
  const arr = []; for (const k in E[cp]) { const o = E[cp][k][g]; if (o && o.n * sign > 0) arr.push({ k: +k, n: o.n, m: o.m }); }
  return arr.sort((a, b) => Math.abs(b.n) - Math.abs(a.n)).slice(0, n);
}
// Build the compact, storage-ready snapshot for one expiry.
export function buildSnapshotForExp(E) {
  const totals = {};
  for (const g of COLS) totals[g] = { C: sideSumRaw(E, 'C', g), P: sideSumRaw(E, 'P', g) };
  const moversInst = {};
  for (const g of INST) moversInst[g] = { bc: topMovesRaw(E, 'C', g, 1, 2), sc: topMovesRaw(E, 'C', g, -1, 2), bp: topMovesRaw(E, 'P', g, 1, 2), sp: topMovesRaw(E, 'P', g, -1, 2) };
  const moversAll = {
    sc: topMovesRaw(E, 'C', '法人合計', -1, 1)[0] || null, sp: topMovesRaw(E, 'P', '法人合計', -1, 1)[0] || null,
    bc: topMovesRaw(E, 'C', '法人合計', 1, 1)[0] || null, bp: topMovesRaw(E, 'P', '法人合計', 1, 1)[0] || null,
  };
  const TOPN = 40;
  const allK = new Set([...Object.keys(E.C), ...Object.keys(E.P)].map(Number));
  let karr = [...allK].map(k => ({ k, vol: (E.C[k] ? E.C[k].vol : 0) + (E.P[k] ? E.P[k].vol : 0) }));
  karr.sort((a, b) => b.vol - a.vol); karr = karr.slice(0, TOPN);
  const keepK = new Set(karr.map(x => x.k));
  function sliceSide(side) {
    const out = {};
    for (const k of keepK) { const o = E[side][k]; if (!o) continue; const cats = {}; for (const g of COLS) if (o[g]) cats[g] = [round2(o[g].n), Math.round(o[g].m)]; out[k] = { vol: o.vol, cats }; }
    return out;
  }
  return { exp: E.exp, vol: E.vol, atm: E.atm ? { k: E.atm.k, F: round1(E.atm.F) } : null, has: E.has, totals, moversInst, moversAll, strikes: { C: sliceSide('C'), P: sliceSide('P') } };
}
