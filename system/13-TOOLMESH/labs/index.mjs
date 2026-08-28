// ToolMesh — 11 labs. Each holds tool-cards OrangeLLM consults.
// PR-15 ships the registry; real cards land per-domain as operator unlocks.

export const LABS = [
  { id: "image",         name: "Image Lab",         tool_cards: 0, status: "STUB" },
  { id: "video",         name: "Video Lab",         tool_cards: 0, status: "STUB" },
  { id: "audio",         name: "Audio Lab",         tool_cards: 0, status: "STUB" },
  { id: "design",        name: "Design Lab",        tool_cards: 0, status: "STUB" },
  { id: "coding",        name: "Coding Lab",        tool_cards: 0, status: "STUB" },
  { id: "automation",    name: "Automation Lab",    tool_cards: 0, status: "STUB" },
  { id: "analytics",     name: "Analytics Lab",     tool_cards: 0, status: "STUB" },
  { id: "public-agent",  name: "Public Agent Lab",  tool_cards: 0, status: "STUB" },
  { id: "observability", name: "Observability Lab", tool_cards: 0, status: "STUB" },
  { id: "security",      name: "Security Lab",      tool_cards: 0, status: "STUB" },
  { id: "releaseops",    name: "ReleaseOps Lab",    tool_cards: 0, status: "STUB" },
];

export function getLab(id) {
  return LABS.find(l => l.id === id);
}

export function listLabs() {
  return LABS.map(({ id, name, tool_cards, status }) => ({ id, name, tool_cards, status }));
}
