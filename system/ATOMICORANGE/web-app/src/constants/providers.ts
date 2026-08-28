import {
  ORANGE_AUTO_MODEL,
  ORANGE_BRAIN_PROVIDER,
  ORANGE_FIVE_OPENAI_BASE_URL,
} from '../lib/orange-crossing'

/**
 * Bundled baseline of provider definitions.
 *
 * Most cloud providers (OpenAI, Anthropic, OpenRouter, Mistral, Groq, xAI,
 * Gemini, MiniMax, Hugging Face, NVIDIA, ...) are no longer hard-coded here.
 * They are loaded at runtime from the `atomic-chat-conf` registry — see
 * `web-app/src/services/provider-registry.ts` and the
 * `web-app/src/services/AGENTS.md` feature notes.
 *
 * This file keeps a minimal in-app baseline used as:
 *   1. A bootstrap value before the first registry refresh resolves.
 *   2. A permanent fallback when the network or registry is unavailable.
 *   3. The shape used to build a custom provider via `Settings > Providers`
 *      ({@link openAIProviderSettings}).
 *
 * Add a provider here ONLY if it cannot live in the remote registry
 * (e.g. it requires per-user resource configuration like Azure OpenAI).
 * Do NOT re-introduce providers that already exist in
 * `atomic-chat-conf/providers/registry.json`.
 */

export const openAIProviderSettings = [
  {
    key: 'api-key',
    title: 'API Key',
    description:
      'Optional credential forwarded only by the governed OrangeBrain gateway when an approved provider requires one.',
    controller_type: 'input',
    controller_props: {
      placeholder: 'Insert API Key',
      value: '',
      type: 'password',
      input_actions: ['unobscure', 'copy'],
    },
  },
  {
    key: 'base-url',
    title: 'Base URL',
    description:
      'OpenAI-compatible OrangeBrain endpoint. Remote providers remain behind the governed gateway.',
    controller_type: 'input',
    controller_props: {
      placeholder: ORANGE_FIVE_OPENAI_BASE_URL,
      value: ORANGE_FIVE_OPENAI_BASE_URL,
    },
  },
]

/**
 * In-app baseline of providers that cannot (or should not) live in the remote
 * registry. The registry-store seeds itself from this list on first load.
 */
export const BASELINE_PROVIDERS: ProviderObject[] = [
  {
    active: true,
    api_key: '',
    base_url: ORANGE_FIVE_OPENAI_BASE_URL,
    provider: ORANGE_BRAIN_PROVIDER,
    persist: true,
    supports_model_listing: true,
    settings: [
      {
        key: 'base-url',
        title: 'OrangeBrain gateway',
        description:
          'Canonical OrangeFive gateway. Every chat turn is governed and receipted before model output is accepted.',
        controller_type: 'input',
        controller_props: {
          value: ORANGE_FIVE_OPENAI_BASE_URL,
          placeholder: ORANGE_FIVE_OPENAI_BASE_URL,
        },
      },
    ],
    models: [
      {
        id: ORANGE_AUTO_MODEL,
        name: 'Orange Auto',
        displayName: 'Orange Auto',
        description: 'Least-action OrangeFive conductor',
        capabilities: ['tools'],
      },
      {
        id: 'orange-navigator',
        name: 'Orange Navigator',
        displayName: 'Orange Navigator',
        description: 'Resident Codexa navigation lane',
        capabilities: ['tools'],
      },
      {
        id: 'orange-code',
        name: 'Orange Code',
        displayName: 'Orange Code',
        description: 'Repository specialist lease',
        capabilities: ['tools'],
      },
      {
        id: 'orangellm-heavy',
        name: 'Orange Heavy',
        displayName: 'Orange Heavy',
        description: 'Bounded architecture and reasoning lease',
        capabilities: ['tools'],
      },
    ],
  },
  {
    active: true,
    api_key: '',
    base_url: 'https://YOUR-RESOURCE-NAME.openai.azure.com/openai/v1',
    explore_models_url: 'https://oai.azure.com/deployments',
    provider: 'azure',
    settings: [
      {
        key: 'api-key',
        title: 'API Key',
        description:
          'The Azure OpenAI API uses API keys for authentication. Visit your [Azure OpenAI Studio](https://oai.azure.com/) to retrieve the API key from your resource.',
        controller_type: 'input',
        controller_props: {
          placeholder: 'Insert API Key',
          value: '',
          type: 'password',
          input_actions: ['unobscure', 'copy'],
        },
      },
      {
        key: 'base-url',
        title: 'Base URL',
        description:
          'Your Azure OpenAI resource endpoint. See the [Azure OpenAI documentation](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/latest) for more information.',
        controller_type: 'input',
        controller_props: {
          placeholder: 'https://YOUR-RESOURCE-NAME.openai.azure.com/openai/v1',
          value: 'https://YOUR-RESOURCE-NAME.openai.azure.com/openai/v1',
        },
      },
    ],
    models: [],
  },
]
