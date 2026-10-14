/**
 * The authentication each installed pi-ai provider performs when a profile
 * names no credential reference. A provider's API-key resolver reads
 * environment variables through `AuthContext.env`, but pi-ai exports no list
 * of the names it reads, so this module lists them. The `Record` key type
 * makes a pi-ai upgrade that adds or removes a provider fail compilation here,
 * and `tests/native-auth.spec.ts` runs every installed resolver to fail on a
 * changed name or lookup order.
 *
 * @module dsh-llm-pi-ai/native-auth
 */

import type { Provider } from '@earendil-works/pi-ai'
import type { BuiltinProvider } from '@earendil-works/pi-ai/providers/all'
import type { LlmNativeAuth } from '@deepseek-ai/dsh-llm'

/** Environment variables each installed provider's API-key resolver reads, in lookup order. */
const NATIVE_AUTH_ENV: Record<BuiltinProvider, readonly string[]> = {
  'amazon-bedrock': [
    'AWS_BEARER_TOKEN_BEDROCK',
    'AWS_PROFILE',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
  ],
  'ant-ling': ['ANT_LING_API_KEY'],
  anthropic: [
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_FEDERATION_RULE_ID',
    'ANTHROPIC_ORGANIZATION_ID',
    'ANTHROPIC_IDENTITY_TOKEN_FILE',
    'ANTHROPIC_SERVICE_ACCOUNT_ID',
    'ANTHROPIC_WORKSPACE_ID',
  ],
  azure: ['AZURE_OPENAI_API_KEY'],
  baseten: ['BASETEN_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  'cloudflare-ai-gateway': ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_GATEWAY_ID'],
  'cloudflare-workers-ai': ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID'],
  deepseek: ['DEEPSEEK_API_KEY'],
  fireworks: ['FIREWORKS_API_KEY'],
  'github-copilot': ['COPILOT_GITHUB_TOKEN'],
  google: ['GEMINI_API_KEY'],
  'google-vertex': [
    'GOOGLE_CLOUD_API_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_PROJECT',
    'GCLOUD_PROJECT',
    'GOOGLE_CLOUD_LOCATION',
  ],
  groq: ['GROQ_API_KEY'],
  huggingface: ['HF_TOKEN'],
  'kimi-coding': ['KIMI_API_KEY'],
  meta: ['META_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  'minimax-cn': ['MINIMAX_CN_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  moonshotai: ['MOONSHOT_API_KEY'],
  'moonshotai-cn': ['MOONSHOT_API_KEY'],
  nvidia: ['NVIDIA_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  // Only its OAuth sign-in authenticates this provider.
  'openai-codex': [],
  opencode: ['OPENCODE_API_KEY'],
  'opencode-go': ['OPENCODE_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  'qwen-token-plan': ['QWEN_TOKEN_PLAN_API_KEY'],
  'qwen-token-plan-cn': ['QWEN_TOKEN_PLAN_CN_API_KEY'],
  'qwen-token-plan-individual': ['QWEN_TOKEN_PLAN_API_KEY'],
  radius: ['RADIUS_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  typesafe: ['TYPESAFE_API_KEY'],
  'vercel-ai-gateway': ['AI_GATEWAY_API_KEY'],
  xai: ['XAI_API_KEY'],
  xiaomi: ['XIAOMI_API_KEY'],
  'xiaomi-token-plan-ams': ['XIAOMI_TOKEN_PLAN_AMS_API_KEY'],
  'xiaomi-token-plan-cn': ['XIAOMI_TOKEN_PLAN_CN_API_KEY'],
  'xiaomi-token-plan-sgp': ['XIAOMI_TOKEN_PLAN_SGP_API_KEY'],
  zai: ['ZAI_API_KEY'],
  'zai-coding-cn': ['ZAI_CODING_CN_API_KEY'],
}

/**
 * The native authentication of one installed catalog provider.
 * @param provider - a provider the installed pi-ai catalog ships.
 * @returns the environment variables its API-key resolver reads, and whether it ships an OAuth sign-in.
 */
export function nativeAuthOf(provider: Provider): LlmNativeAuth {
  return { env: NATIVE_AUTH_ENV[provider.id as BuiltinProvider], oauth: provider.auth.oauth !== undefined }
}
