import { pickLane } from '../router-least-action.mjs';

const AUTO_MODELS = new Set(['orange-auto', 'orange-navigator-hot', 'auto']);

export function isAutoModel(model) {
  return model == null || model === '' || AUTO_MODELS.has(String(model).toLowerCase());
}

export function compileChatOrder(body = {}) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((item) => item?.role === 'user');
  const intent = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '');
  const hasImagePart = messages.some((message) => Array.isArray(message?.content) && message.content.some((part) =>
    ['image_url', 'input_image', 'image'].includes(String(part?.type || '').toLowerCase())
      || typeof part?.image_url === 'string'
      || typeof part?.image_url?.url === 'string'));
  const hasImagePath = /(?:[a-z]:\\|\/)[^\s"']+\.(?:png|jpe?g|webp|gif|bmp|tiff?)\b/i.test(intent);
  const destructive = /\b(delete|remove|wipe|reset|install|uninstall|kill|restart)\b/i.test(intent)
    || /\b(?:deploy|publish|release)\b.{0,40}\b(?:production|public|live|artifact|package|version)\b/i.test(intent)
    || /\b(?:deploy|publish|release)\s+(?:it|this|now|again)\b/i.test(intent);
  const code = /\b(code|coding|repo|repository|typescript|javascript|python|rust|go|build|test|debug|refactor|implement|patch|file)\b/i.test(intent);
  const architectureGrade = /\b(?:architect(?:ure|ural)?|system design|root cause|trade[ -]?offs?|cross[- ]disciplin|synthesi[sz]e|deep review|judge)\b/i.test(intent);
  const visual = hasImagePart || hasImagePath;
  return {
    schema: 'orange.order.v1',
    orderId: body.ae_order_id ?? `auto-${crypto.randomUUID()}`,
    action: visual ? 'query.visual' : (code ? 'query.code' : 'query.chat'),
    intent,
    scope: intent.length > 2_000 ? ['broad'] : ['bounded'],
    // Bun performs classification and routing on the N150. Every generated
    // answer earns at least the Codexa Navigator; the N150 hosts no chat model.
    allowedActions: ['report', 'route', 'reason', ...(architectureGrade ? ['judge'] : [])],
    forbiddenActions: destructive ? ['execute_without_approval'] : [],
    targetProject: 'orange5',
    inputModalities: visual ? ['text', 'image'] : ['text'],
    riskLevel: destructive ? 'high' : (code ? 'medium' : 'low'),
    requiresReceipt: Boolean(body.ae_response_contract),
  };
}

export function resolveAutoRoute(body = {}, systemState = {}) {
  const order = compileChatOrder(body);
  const picked = pickLane(order, systemState);
  const decision = picked.lane === 'ae-eyes'
    ? { ...picked, capability: 'operational-vision' }
    : picked;
  const tier = decision.lane === 'ae-eyes'
    ? 'visual'
    : decision.lane === 'reflex'
    ? 'light'
    : decision.lane === 'local-code'
      ? 'code'
      : decision.lane === 'local-fast'
        ? 'navigator'
        : 'heavy';
  return { order, decision, tier };
}
