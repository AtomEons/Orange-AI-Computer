#!/usr/bin/env bun
// collision-audit.mjs — governing-charter §4.2 (cross-illuminant) + §4.3 (collision) on wide-IT cache.
// Read-only. Written from L8 review lane 2026-07-11.
// Answers charter finish-line questions: d_intra, d_inter, margin, reciprocal-NN, cross-illuminant 6×6.

import fs from "node:fs"; import path from "node:path";
const CACHE_DIR = "C:/AtomEons/Orange5/07-VISUAL/ten-k-x-100/cache-wide";
const rng = (s, i) => { const x = Math.sin(s * 9301 + i * 49297) * 233280; return x - Math.floor(x); };
const shuf = (a, s) => { const o = a.slice(); for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(rng(s, i) * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; } return o; };

const files = fs.readdirSync(CACHE_DIR).filter(f => f.startsWith("wide_"));
const lens = new Map();
for (const f of files) try {
  for (const c of JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), "utf8")).classes)
    if (c.its) for (const it of c.its) lens.set(it.v.length, (lens.get(it.v.length) || 0) + 1);
} catch {}
let modeL = 286, mc = 0;
for (const [L, c] of lens) if (c > mc) { mc = c; modeL = L; }

const raw = new Map();
for (const f of files) try {
  for (const c of JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), "utf8")).classes) {
    if (!c.its) continue;
    const k = c.its.filter(x => x.v.length === modeL);
    if (k.length >= 2) raw.set(c.id, { id: c.id, its: k });
  }
} catch {}
console.log(`loaded ${raw.size} classes @ D=${modeL}`);

const san = v => { const o = new Float32Array(v.length); for (let d = 0; d < v.length; d++) { const x = v[d]; o[d] = Number.isFinite(x) ? Math.sign(x) * Math.log1p(Math.abs(x)) : 0; } return o; };

function stdSlice(D0, D1) {
  const D = D1 - D0;
  const cls = Array.from(raw.values());
  const all = [], lig = [];
  for (const c of cls) for (const it of c.its) {
    const s = san(it.v);
    const n = new Float32Array(D);
    for (let d = 0; d < D; d++) n[d] = s[D0 + d];
    all.push(n);
    lig.push(it.light || "raw");
  }
  const mean = new Float32Array(D), std = new Float32Array(D), M = all.length;
  for (let d = 0; d < D; d++) {
    let m = 0; for (const v of all) m += v[d]; m /= M;
    let s2 = 0; for (const v of all) s2 += (v[d] - m) ** 2;
    mean[d] = m; std[d] = Math.sqrt(s2 / M) || 1;
  }
  let ix = 0; const out = [];
  for (const c of cls) {
    const its = [];
    for (let k = 0; k < c.its.length; k++) {
      const nv = new Float32Array(D);
      for (let d = 0; d < D; d++) nv[d] = (all[ix][d] - mean[d]) / std[d];
      its.push({ v: nv, light: lig[ix] });
      ix++;
    }
    out.push({ id: c.id, its });
  }
  return { D, cls: out };
}

function fisher({ D, cls }) {
  const cd = cls.map(c => {
    const cm = new Float64Array(D);
    for (const it of c.its) for (let d = 0; d < D; d++) cm[d] += it.v[d];
    for (let d = 0; d < D; d++) cm[d] /= c.its.length;
    return { cm, its: c.its, n: c.its.length };
  });
  const gm = new Float64Array(D); let T = 0;
  for (const c of cd) { for (let d = 0; d < D; d++) gm[d] += c.cm[d] * c.n; T += c.n; }
  for (let d = 0; d < D; d++) gm[d] /= T;
  const bw = new Float64Array(D), wi = new Float64Array(D);
  for (const c of cd) for (let d = 0; d < D; d++) {
    const df = c.cm[d] - gm[d];
    bw[d] += c.n * df * df;
    for (const it of c.its) { const w = it.v[d] - c.cm[d]; wi[d] += w * w; }
  }
  const w = new Float32Array(D);
  for (let d = 0; d < D; d++) w[d] = bw[d] / (wi[d] + 1e-9);
  return w;
}

const l1w = (a, b, w, D) => { let s = 0; for (let d = 0; d < D; d++) s += Math.abs(a[d] - b[d]) * w[d]; return s; };

function audit(label, sc) {
  const { D, cls } = sc, w = fisher(sc);
  const cent = cls.map(c => {
    const cm = new Float32Array(D);
    for (const it of c.its) for (let d = 0; d < D; d++) cm[d] += it.v[d];
    for (let d = 0; d < D; d++) cm[d] /= c.its.length;
    return { id: c.id, cm };
  });
  const dIntra = [], dIntraMax = new Map(), dIntraMean = new Map();
  for (const c of cls) {
    let sum = 0, cnt = 0, mx = 0;
    for (let i = 0; i < c.its.length; i++) for (let j = i + 1; j < c.its.length; j++) {
      const d = l1w(c.its[i].v, c.its[j].v, w, D);
      dIntra.push(d); sum += d; cnt++; if (d > mx) mx = d;
    }
    dIntraMean.set(c.id, cnt ? sum / cnt : 0);
    dIntraMax.set(c.id, mx);
  }
  const nearImp = [], dInter = new Map(), nnCls = new Map();
  for (const c of cls) {
    let cMin = Infinity, cMT = null;
    for (const it of c.its) {
      let mn = Infinity, mT = null;
      for (const oc of cent) if (oc.id !== c.id) {
        const d = l1w(it.v, oc.cm, w, D);
        if (d < mn) { mn = d; mT = oc.id; }
      }
      nearImp.push(mn);
      if (mn < cMin) { cMin = mn; cMT = mT; }
    }
    dInter.set(c.id, cMin);
    nnCls.set(c.id, cMT);
  }
  let recip = 0;
  for (const c of cls) {
    const t = nnCls.get(c.id);
    if (t && nnCls.get(t) === c.id) recip++;
  }
  const margins = cls.map(c => ({ id: c.id, m: dInter.get(c.id) - dIntraMax.get(c.id) }));
  margins.sort((a, b) => a.m - b.m);
  const neg = margins.filter(x => x.m < 0).length;
  const iS = dIntra.slice().sort((a, b) => a - b), imS = nearImp.slice().sort((a, b) => a - b);
  const q = (a, p) => a[Math.min(a.length - 1, Math.max(0, Math.floor(p * a.length)))];
  console.log(`\n══ ${label} (D=${D}) ══`);
  console.log(`  intra: med=${q(iS, 0.5).toFixed(3)} p95=${q(iS, 0.95).toFixed(3)}   nearestImp: med=${q(imS, 0.5).toFixed(3)} p05=${q(imS, 0.05).toFixed(3)}`);
  console.log(`  global margin min(imp)−max(intra) = ${(q(imS, 0) - q(iS, 1)).toFixed(3)}`);
  console.log(`  neg-margin classes: ${neg}/${cls.length} (${(100 * neg / cls.length).toFixed(1)}%)`);
  console.log(`  reciprocal-NN class collisions: ${recip}/${cls.length} (${(100 * recip / cls.length).toFixed(1)}%)`);
  console.log(`  top-20 hardest (most negative margin):`);
  for (const { id, m } of margins.slice(0, 20)) console.log(`    ${id.padEnd(12)} margin=${m.toFixed(3)}  NN→${nnCls.get(id)}`);
  let ac = 0, rj = 0, fw = 0;
  const flat = [];
  for (const c of cls) for (const it of c.its) flat.push({ id: c.id, v: it.v });
  for (const qv of shuf(flat, 99).slice(0, 500)) {
    const ds = [];
    for (const oc of cent) if (oc.id !== qv.id) ds.push({ id: oc.id, d: l1w(qv.v, oc.cm, w, D) });
    ds.sort((a, b) => a.d - b.d);
    const t1 = ds[0], t2 = ds[1];
    const mr = (t2.d - t1.d) / (t2.d + 1e-9);
    if (mr < 0.02) { rj++; continue; }
    if (t1.id === qv.id) ac++;
    else fw++;
  }
  console.log(`  open-set FAR proxy (500q, margin<0.02): acc=${ac} rej=${rj} forced-wrong=${fw}`);
  return { w };
}

function crossIllum(sc) {
  const { D, cls } = sc, w = fisher(sc);
  const L = ["raw", "sun", "candle", "moon", "crt", "neon"];
  const M = {};
  for (const rL of L) {
    M[rL] = {};
    const tr = new Map();
    for (const c of cls) {
      const r = c.its.filter(x => x.light === rL);
      if (r.length) tr.set(c.id, r[0].v);
    }
    for (const qL of L) {
      let ok = 0, tt = 0;
      for (const c of cls) {
        const qs = c.its.filter(x => x.light === qL);
        for (const q of qs) {
          let bi = null, bd = Infinity;
          for (const [tid, tv] of tr) {
            if (tid === c.id && qL === rL) continue;
            const d = l1w(q.v, tv, w, D);
            if (d < bd) { bd = d; bi = tid; }
          }
          tt++;
          if (bi === c.id) ok++;
        }
      }
      M[rL][qL] = tt ? ok / tt : null;
    }
  }
  console.log("\n══ §4.2 CROSS-ILLUMINANT (Ref\\Query) ══");
  console.log("       " + L.map(l => l.padEnd(7)).join(""));
  for (const r of L) console.log(r.padEnd(7) + L.map(qq => (M[r][qq] == null ? "n/a  " : (100 * M[r][qq]).toFixed(1) + "%").padEnd(7)).join(""));
}

const wide = stdSlice(0, modeL), it80 = stdSlice(0, 80);
audit("WIDE-286", wide);
audit("IT-80", it80);
crossIllum(wide);
