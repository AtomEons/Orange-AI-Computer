import { loadStaffRoster } from "./staff-reactor.mjs";

const ROUTES = [
  [/\b(build|implement|code|patch|refactor|typescript|javascript)\b/i, "product-systems-builder"],
  [/\b(mcp|integration|connector|api|gateway|webhook)\b/i, "integration-engineer"],
  [/\b(bun|backend|runtime|server|service|database)\b/i, "product-systems-builder"],
  [/\b(react|frontend|interface|component|tauri|native app)\b/i, "interface-engineer"],
  [/\b(schema|contract|sqlite|data|equation|migration)\b/i, "data-contract-engineer"],
  [/\b(automation|workflow|scheduled|daemon|startup)\b/i, "automation-engineer"],
  [/\b(test|proof|harness|fixture|assertion)\b/i, "test-harness-engineer"],
  [/\b(performance|latency|throughput|memory|optimi[sz])\b/i, "performance-engineer"],
  [/\b(reliability|reconnect|uptime|recovery|orphan|restart)\b/i, "reliability-engineer"],
  [/\b(security|secret|threat|permission|auth|egress)\b/i, "security-boundary-engineer"],
  [/\b(accessibility|a11y|screen reader|keyboard navigation)\b/i, "accessibility-engineer"],
  [/\b(primary source|paper|arxiv|research|current|standard)\b/i, "primary-source-researcher"],
  [/\b(model|llm|inference|embedding|reranker|benchmark)\b/i, "model-evaluation-researcher"],
  [/\b(provenance|citation|license|lineage|source hash)\b/i, "provenance-researcher"],
  [/\b(ux|product experience|interaction|journey|workflow)\b/i, "product-experience-designer"],
  [/\b(brand|identity|logo|visual language)\b/i, "brand-identity-designer"],
  [/\b(typography|type system|font)\b/i, "typography-designer"],
  [/\b(information design|diagram|dashboard|data visual)\b/i, "information-designer"],
  [/\b(document|manual|copy|content|guide|publishing)\b/i, "content-designer"],
  [/\b(illustration|comic|drawing|artwork)\b/i, "illustration-artist"],
  [/\b(motion|animation|transition|framer)\b/i, "motion-designer"],
  [/\b(storyboard|shot list|sequence)\b/i, "storyboard-artist"],
  [/\b(camera|cinematography|lighting|lens|shot)\b/i, "cinematography-specialist"],
  [/\b(3d|three\.js|spatial|scene|mesh)\b/i, "three-d-scene-artist"],
  [/\b(image|flux|picture|photo|graphic generation)\b/i, "generative-image-artist"],
  [/\b(video|film|wan|render frames)\b/i, "video-synthesis-artist"],
  [/\b(sound|audio|mix|foley)\b/i, "sound-designer"],
  [/\b(music|score|song|composition)\b/i, "music-composer"],
  [/\b(voice|dialogue|speech|tts|narration)\b/i, "voice-dialogue-designer"],
  [/\b(browser|desktop|click|type|computer use|capture screen)\b/i, "human-interface-operator"],
  [/\b(capture|record|screenshot|obs)\b/i, "media-capture-operator"],
  [/\b(release|ship|package|installer|publish)\b/i, "release-acceptance-operator"],
];

const REVIEW_FOR = Object.freeze({
  builder: "behavior-reviewer",
  visual: "media-quality-reviewer",
  researcher: "evidence-auditor",
  "human-operator": "release-proof-reviewer",
});

function words(value) {
  return [...new Set(String(value || "").toLowerCase().match(/[a-z0-9][a-z0-9-]{1,}/g) || [])];
}

function scoreRole(role, text, queryWords) {
  const corpus = new Set(words([role.id, role.title, role.studio, role.purpose, ...(role.concreteOutputs || [])].join(" ")));
  let score = queryWords.reduce((sum, token) => sum + (corpus.has(token) ? 1 : 0), 0);
  for (const [pattern, roleId] of ROUTES) if (role.id === roleId && pattern.test(text)) score += 12;
  if (text.includes(role.id)) score += 20;
  if (text.includes(String(role.title).toLowerCase())) score += 20;
  return score;
}

export function compileStaffCrew(order = {}, options = {}) {
  const roster = options.roster || loadStaffRoster(options.rosterPath);
  const byId = new Map(roster.roles.map((role) => [role.id, role]));
  const navigator = roster.roles.find((role) => role.archetype === "navigator");
  const text = `${order.action || ""} ${order.intent || ""} ${order.payload?.intent || ""} ${order.scope || ""}`.toLowerCase();
  const queryWords = words(text);
  const maxAgents = Math.max(1, Math.min(12, Number(order.maxAgents || options.maxAgents || 5)));
  const requested = [...new Set([...(order.staffRoles || []), ...(order.targetRoles || [])])];
  for (const roleId of requested) if (!byId.has(roleId)) throw new Error(`Unknown AE Staff role: ${roleId}`);

  const scored = roster.roles
    .filter((role) => role.archetype !== "navigator")
    .map((role) => ({ role, score: scoreRole(role, text, queryWords) }))
    .sort((left, right) => right.score - left.score || left.role.id.localeCompare(right.role.id));

  const selected = [];
  const add = (role) => { if (role && !selected.some((item) => item.id === role.id) && selected.length < maxAgents) selected.push(role); };
  requested.forEach((roleId) => add(byId.get(roleId)));
  if (!selected.length) {
    for (const candidate of scored) {
      if (candidate.score <= 0 && selected.length) break;
      add(candidate.role);
      if (selected.length >= Math.min(maxAgents, 3)) break;
    }
  }
  if (!selected.length) add(byId.get("product-systems-builder") || scored[0]?.role);

  const firstMaker = selected.find((role) => ["builder", "visual", "researcher", "human-operator"].includes(role.archetype));
  const reviewRoleId = firstMaker ? REVIEW_FOR[firstMaker.archetype] : null;
  if (reviewRoleId && selected.length < maxAgents && !/\b(no review|skip review)\b/i.test(text)) add(byId.get(reviewRoleId));
  if (/\b(misfit|contrarian|assumption|dissent|break the frame)\b/i.test(text) && selected.length < maxAgents) add(byId.get("assumption-breaker"));

  const workingLead = selected.find((role) => role.canLead) || selected[0];
  const profiles = [...new Set(selected.map((role) => role.archetype))];
  const makers = selected.filter((role) => !["reviewer", "misfit"].includes(role.archetype));
  const assurance = selected.filter((role) => ["reviewer", "misfit"].includes(role.archetype));
  const executionWaves = [makers, assurance]
    .filter((wave) => wave.length)
    .map((wave, index) => ({ index, roles: wave.map((role) => role.id), profiles: [...new Set(wave.map((role) => role.archetype))] }));
  return {
    schema: "orange.ae-staff-crew.v1",
    product: "AE Staff",
    navigator: navigator.id,
    workingLead: workingLead.id,
    roles: selected.map((role) => role.id),
    executionProfiles: profiles,
    executionWaves,
    roleContracts: selected.map((role) => ({
      id: role.id,
      title: role.title,
      archetype: role.archetype,
      concreteOutputs: role.concreteOutputs,
      completionContract: role.completionContract,
      forbiddenActions: role.forbiddenActions,
      canLead: role.id === workingLead.id,
    })),
    candidates: scored.slice(0, 8).map(({ role, score }) => ({ roleId: role.id, score })),
    invariants: {
      flatCompany: true,
      standingCoordinator: navigator.id,
      permanentMiddleManagers: 0,
      workingLeadProducesArtifact: true,
      executionProfileCount: 7,
    },
  };
}
