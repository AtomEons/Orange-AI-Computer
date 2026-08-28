// trajectory.mjs — the chain becomes a TREE.
//
// Orange5's chain is append-only and hash-linked, which makes it tamper-evident.
// It is NOT amendable — and those are different properties. When AEyes-1 seq 170
// was overturned, the only available move was to append seq 171 saying "regard 170
// as preliminary." The chain still carries 170 as current. Ask it "what do we
// believe?" and it answers with the wrong claim included.
//
// This module adds the missing structure WITHOUT rewriting history:
//   campaign_id      which trajectory this receipt belongs to
//   parent_receipt   what this step followed from
//   supersedes[]     seqs this receipt overturns
//   evidence_refs[]  what this claim rests on
//   epistemic_score  how well-founded the claim was (from loom-epistemic)
//
// Supersession is DERIVED, never written backwards. A superseded receipt keeps
// its bytes and its hash; the tree simply knows a later receipt overturned it.
// Tamper-evidence is preserved; amendability is gained.
//
// Backward compatible: receipts predating these fields read as a flat campaign
// with no parents and no supersession. Nothing breaks.

import fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TRAJECTORY_SCHEMA_ID = 'orange5.trajectory.v1';
const ROOT = resolve(process.env.ORANGE5_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const DEFAULT_CHAIN = resolve(ROOT, '10-RECEIPTS', 'spine-chain.jsonl');

export function loadChain(chainPath = DEFAULT_CHAIN) {
  if (!fs.existsSync(chainPath)) return [];
  return fs.readFileSync(chainPath, 'utf-8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/**
 * buildTrajectory(chain) — derive the tree from a flat chain.
 * Supersession is computed forward-only: a receipt declaring supersedes:[N]
 * marks N superseded. N itself is never rewritten.
 */
export function buildTrajectory(chain) {
  const bySeq = new Map();
  for (const r of chain) bySeq.set(r.seq, { ...r, superseded_by: null, children: [] });

  const campaigns = new Map();
  for (const node of bySeq.values()) {
    // forward-derive supersession
    for (const target of node.supersedes || []) {
      const victim = bySeq.get(target);
      if (victim) victim.superseded_by = node.seq;
    }
    // attach to parent
    if (node.parent_receipt != null) {
      const parent = bySeq.get(node.parent_receipt);
      if (parent) parent.children.push(node.seq);
    }
    // group into campaigns
    const cid = node.campaign_id || '_unassigned';
    if (!campaigns.has(cid)) campaigns.set(cid, []);
    campaigns.get(cid).push(node.seq);
  }

  return { nodes: bySeq, campaigns, size: bySeq.size };
}

/**
 * liveClaims(traj) — every receipt NOT overturned by a later one.
 * This is the answer to "what do we currently believe?" — a question the flat
 * chain cannot answer.
 */
export function liveClaims(traj, { campaign = null } = {}) {
  const out = [];
  for (const node of traj.nodes.values()) {
    if (node.superseded_by != null) continue;
    if (campaign && node.campaign_id !== campaign) continue;
    out.push(node);
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** supersededClaims(traj) — the graveyard. What we used to believe, and what replaced it. */
export function supersededClaims(traj) {
  const out = [];
  for (const node of traj.nodes.values()) {
    if (node.superseded_by == null) continue;
    const by = traj.nodes.get(node.superseded_by);
    out.push({
      seq: node.seq, action: node.action, summary: node.summary,
      superseded_by: node.superseded_by,
      superseded_by_summary: by?.summary ?? null,
      lifetime_receipts: node.superseded_by - node.seq,
      epistemic_score: node.epistemic_score ?? null,
    });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** walkCampaign(traj, campaignId) — ordered trajectory with live/dead status. */
export function walkCampaign(traj, campaignId) {
  const seqs = traj.campaigns.get(campaignId) || [];
  return seqs.map(s => traj.nodes.get(s)).filter(Boolean).sort((a, b) => a.seq - b.seq)
    .map(n => ({
      seq: n.seq, action: n.action, summary: n.summary,
      status: n.superseded_by == null ? 'LIVE' : `SUPERSEDED by ${n.superseded_by}`,
      epistemic_score: n.epistemic_score ?? null,
      parent: n.parent_receipt ?? null,
      evidence_refs: n.evidence_refs ?? [],
    }));
}

/**
 * campaignHealth(traj, campaignId) — how sound was this line of work?
 * Supersession rate is the honest measure of how often the campaign was wrong.
 */
export function campaignHealth(traj, campaignId) {
  const seqs = traj.campaigns.get(campaignId) || [];
  const nodes = seqs.map(s => traj.nodes.get(s)).filter(Boolean);
  if (nodes.length === 0) return null;
  const superseded = nodes.filter(n => n.superseded_by != null);
  const scored = nodes.filter(n => Number.isFinite(n.epistemic_score));
  const meanScore = scored.length
    ? scored.reduce((s, n) => s + n.epistemic_score, 0) / scored.length : null;
  return {
    campaign_id: campaignId,
    receipts: nodes.length,
    live: nodes.length - superseded.length,
    superseded: superseded.length,
    supersession_rate: superseded.length / nodes.length,
    mean_epistemic_score: meanScore,
    scored_receipts: scored.length,
    seq_range: [Math.min(...nodes.map(n => n.seq)), Math.max(...nodes.map(n => n.seq))],
  };
}

/** chainIntegrity(chain) — prev_hash linkage audit. Unchanged semantics, exposed as a tool. */
export function chainIntegrity(chain) {
  let checked = 0, broken = [];
  for (let i = 1; i < chain.length; i++) {
    if (chain[i].prev_hash === undefined) continue;
    checked++;
    if (chain[i].prev_hash !== chain[i - 1].hash) {
      broken.push({ seq: chain[i].seq, expected: chain[i - 1].hash, found: chain[i].prev_hash });
    }
  }
  return { entries: chain.length, links_checked: checked, broken: broken.length, breaks: broken.slice(0, 5) };
}

export const __trajectoryInternals = Object.freeze({ DEFAULT_CHAIN });
