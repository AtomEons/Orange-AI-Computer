// G14 — Soul Genome JSON exists and is well-formed.

import { ensureSoulGenome, soulGenomeIsHealthy } from "../lib/soul-genome.mjs";

export async function run() {
  const genome = ensureSoulGenome();
  const h = soulGenomeIsHealthy(genome);
  if (!h.ok) {
    return {
      pass: false,
      details: { reason: h.reason, schema: genome?.schema || null },
    };
  }
  return {
    pass: true,
    details: {
      schema: genome.schema,
      operator: genome.operator?.name,
      intent_anchors: genome.intent_anchors?.length || 0,
      updated_at: genome.updated_at,
    },
  };
}
