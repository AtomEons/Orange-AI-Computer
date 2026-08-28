// index.mjs — registry of the 27 guardrail check modules in G-order.
//
// Each entry: { num: 1..27, file: "NN-slug.mjs", g: "G-NN" }. The
// runtime enforcer imports this list and iterates in order; the first
// `block` failure short-circuits boot (per spec §5.3 step 2).

import g01 from "./01-moms-law-above-all.mjs";
import g02 from "./02-runtime-node-py-sole-authority.mjs";
import g03 from "./03-founder-salary-env-bound.mjs";
import g04 from "./04-gate-zero-lbce-first.mjs";
import g05 from "./05-human-final-stop-reachable.mjs";
import g06 from "./06-identity-secret-env-only.mjs";
import g07 from "./07-frontier-via-gateway.mjs";
import g08 from "./08-no-code-editor-in-app.mjs";
import g09 from "./09-four-lanes-immutable.mjs";
import g10 from "./10-receipts-hash-chained.mjs";
import g11 from "./11-no-fake-green-in-commits.mjs";
import g12 from "./12-no-real-person-simulation.mjs";
import g13 from "./13-search-before-present-claim.mjs";
import g14 from "./14-ledger-or-it-didnt-ship.mjs";
import g15 from "./15-one-writer-per-overlap.mjs";
import g16 from "./16-read-before-broad-edits.mjs";
import g17 from "./17-scope-before-implementation.mjs";
import g18 from "./18-soul-genome-single-source.mjs";
import g19 from "./19-continuity-packet-loaded-at-boot.mjs";
import g20 from "./20-continuity-packet-cron-written.mjs";
import g21 from "./21-idempotency-on-autonomous.mjs";
import g22 from "./22-retry-caps-on-outbound.mjs";
import g23 from "./23-deterministic-validators.mjs";
import g24 from "./24-explicit-model-routing.mjs";
import g25 from "./25-no-silent-routing-bypass.mjs";
import g26 from "./26-separation-of-powers-release.mjs";
import g27 from "./27-held-area-isolation.mjs";

import * as m01 from "./01-moms-law-above-all.mjs";
import * as m02 from "./02-runtime-node-py-sole-authority.mjs";
import * as m03 from "./03-founder-salary-env-bound.mjs";
import * as m04 from "./04-gate-zero-lbce-first.mjs";
import * as m05 from "./05-human-final-stop-reachable.mjs";
import * as m06 from "./06-identity-secret-env-only.mjs";
import * as m07 from "./07-frontier-via-gateway.mjs";
import * as m08 from "./08-no-code-editor-in-app.mjs";
import * as m09 from "./09-four-lanes-immutable.mjs";
import * as m10 from "./10-receipts-hash-chained.mjs";
import * as m11 from "./11-no-fake-green-in-commits.mjs";
import * as m12 from "./12-no-real-person-simulation.mjs";
import * as m13 from "./13-search-before-present-claim.mjs";
import * as m14 from "./14-ledger-or-it-didnt-ship.mjs";
import * as m15 from "./15-one-writer-per-overlap.mjs";
import * as m16 from "./16-read-before-broad-edits.mjs";
import * as m17 from "./17-scope-before-implementation.mjs";
import * as m18 from "./18-soul-genome-single-source.mjs";
import * as m19 from "./19-continuity-packet-loaded-at-boot.mjs";
import * as m20 from "./20-continuity-packet-cron-written.mjs";
import * as m21 from "./21-idempotency-on-autonomous.mjs";
import * as m22 from "./22-retry-caps-on-outbound.mjs";
import * as m23 from "./23-deterministic-validators.mjs";
import * as m24 from "./24-explicit-model-routing.mjs";
import * as m25 from "./25-no-silent-routing-bypass.mjs";
import * as m26 from "./26-separation-of-powers-release.mjs";
import * as m27 from "./27-held-area-isolation.mjs";

export const checks = [
  { num: 1, file: "01-moms-law-above-all.mjs", g: m01.id, slug: m01.slug, severity: m01.severity, check: g01 },
  { num: 2, file: "02-runtime-node-py-sole-authority.mjs", g: m02.id, slug: m02.slug, severity: m02.severity, check: g02 },
  { num: 3, file: "03-founder-salary-env-bound.mjs", g: m03.id, slug: m03.slug, severity: m03.severity, check: g03 },
  { num: 4, file: "04-gate-zero-lbce-first.mjs", g: m04.id, slug: m04.slug, severity: m04.severity, check: g04 },
  { num: 5, file: "05-human-final-stop-reachable.mjs", g: m05.id, slug: m05.slug, severity: m05.severity, check: g05 },
  { num: 6, file: "06-identity-secret-env-only.mjs", g: m06.id, slug: m06.slug, severity: m06.severity, check: g06 },
  { num: 7, file: "07-frontier-via-gateway.mjs", g: m07.id, slug: m07.slug, severity: m07.severity, check: g07 },
  { num: 8, file: "08-no-code-editor-in-app.mjs", g: m08.id, slug: m08.slug, severity: m08.severity, check: g08 },
  { num: 9, file: "09-four-lanes-immutable.mjs", g: m09.id, slug: m09.slug, severity: m09.severity, check: g09 },
  { num: 10, file: "10-receipts-hash-chained.mjs", g: m10.id, slug: m10.slug, severity: m10.severity, check: g10 },
  { num: 11, file: "11-no-fake-green-in-commits.mjs", g: m11.id, slug: m11.slug, severity: m11.severity, check: g11 },
  { num: 12, file: "12-no-real-person-simulation.mjs", g: m12.id, slug: m12.slug, severity: m12.severity, check: g12 },
  { num: 13, file: "13-search-before-present-claim.mjs", g: m13.id, slug: m13.slug, severity: m13.severity, check: g13 },
  { num: 14, file: "14-ledger-or-it-didnt-ship.mjs", g: m14.id, slug: m14.slug, severity: m14.severity, check: g14 },
  { num: 15, file: "15-one-writer-per-overlap.mjs", g: m15.id, slug: m15.slug, severity: m15.severity, check: g15 },
  { num: 16, file: "16-read-before-broad-edits.mjs", g: m16.id, slug: m16.slug, severity: m16.severity, check: g16 },
  { num: 17, file: "17-scope-before-implementation.mjs", g: m17.id, slug: m17.slug, severity: m17.severity, check: g17 },
  { num: 18, file: "18-soul-genome-single-source.mjs", g: m18.id, slug: m18.slug, severity: m18.severity, check: g18 },
  { num: 19, file: "19-continuity-packet-loaded-at-boot.mjs", g: m19.id, slug: m19.slug, severity: m19.severity, check: g19 },
  { num: 20, file: "20-continuity-packet-cron-written.mjs", g: m20.id, slug: m20.slug, severity: m20.severity, check: g20 },
  { num: 21, file: "21-idempotency-on-autonomous.mjs", g: m21.id, slug: m21.slug, severity: m21.severity, check: g21 },
  { num: 22, file: "22-retry-caps-on-outbound.mjs", g: m22.id, slug: m22.slug, severity: m22.severity, check: g22 },
  { num: 23, file: "23-deterministic-validators.mjs", g: m23.id, slug: m23.slug, severity: m23.severity, check: g23 },
  { num: 24, file: "24-explicit-model-routing.mjs", g: m24.id, slug: m24.slug, severity: m24.severity, check: g24 },
  { num: 25, file: "25-no-silent-routing-bypass.mjs", g: m25.id, slug: m25.slug, severity: m25.severity, check: g25 },
  { num: 26, file: "26-separation-of-powers-release.mjs", g: m26.id, slug: m26.slug, severity: m26.severity, check: g26 },
  { num: 27, file: "27-held-area-isolation.mjs", g: m27.id, slug: m27.slug, severity: m27.severity, check: g27 },
];

export const byG = Object.fromEntries(checks.map((c) => [c.g, c]));
export const bySlug = Object.fromEntries(checks.map((c) => [c.slug, c]));

export default checks;
