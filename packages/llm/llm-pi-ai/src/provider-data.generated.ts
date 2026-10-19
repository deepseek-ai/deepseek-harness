/** Generated from the installed pi-ai catalog. Run pnpm gen-provider-data; do not edit. */

import type { BuiltinProvider } from '@earendil-works/pi-ai/providers/all'
import type { LlmConfigurableProvider } from '@deepseek-ai/dsh-llm'

type ProviderData = Pick<LlmConfigurableProvider, 'defaultBaseURL' | 'baseURLEnv'> & { env: readonly string[] }

/** Catalog endpoints and environment names; no credentials are evaluated at runtime. */
export const PROVIDER_DATA: Record<BuiltinProvider, ProviderData> & Partial<Record<string, ProviderData>> = {
  'amazon-bedrock': { env: ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_WEB_IDENTITY_TOKEN_FILE'], baseURLEnv: ['AWS_REGION', 'AWS_DEFAULT_REGION'] },
  'ant-ling': { env: ['ANT_LING_API_KEY'], defaultBaseURL: 'https://api.ant-ling.com/v1' },
  'anthropic': { env: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID', 'ANTHROPIC_IDENTITY_TOKEN_FILE', 'ANTHROPIC_SERVICE_ACCOUNT_ID', 'ANTHROPIC_WORKSPACE_ID'], defaultBaseURL: 'https://api.anthropic.com' },
  'azure': { env: ['AZURE_OPENAI_API_KEY'], baseURLEnv: ['AZURE_OPENAI_BASE_URL', 'AZURE_OPENAI_RESOURCE_NAME'] },
  'baseten': { env: ['BASETEN_API_KEY'], defaultBaseURL: 'https://inference.baseten.co/v1' },
  'cerebras': { env: ['CEREBRAS_API_KEY'], defaultBaseURL: 'https://api.cerebras.ai/v1' },
  'cloudflare-ai-gateway': { env: ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_GATEWAY_ID'], baseURLEnv: ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_GATEWAY_ID'] },
  'cloudflare-workers-ai': { env: ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID'], baseURLEnv: ['CLOUDFLARE_ACCOUNT_ID'] },
  'deepseek': { env: ['DEEPSEEK_API_KEY'], defaultBaseURL: 'https://api.deepseek.com' },
  'fireworks': { env: ['FIREWORKS_API_KEY'], defaultBaseURL: 'https://api.fireworks.ai/inference' },
  'github-copilot': { env: ['COPILOT_GITHUB_TOKEN'], defaultBaseURL: 'https://api.individual.githubcopilot.com' },
  'google': { env: ['GEMINI_API_KEY'], defaultBaseURL: 'https://generativelanguage.googleapis.com/v1beta' },
  'google-vertex': { env: ['GOOGLE_CLOUD_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION'], baseURLEnv: ['GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION'] },
  'groq': { env: ['GROQ_API_KEY'], defaultBaseURL: 'https://api.groq.com/openai/v1' },
  'huggingface': { env: ['HF_TOKEN'], defaultBaseURL: 'https://router.huggingface.co/v1' },
  'kimi-coding': { env: ['KIMI_API_KEY'], defaultBaseURL: 'https://api.kimi.com/coding/v1' },
  'meta': { env: ['META_API_KEY'], defaultBaseURL: 'https://api.meta.ai/v1' },
  'minimax': { env: ['MINIMAX_API_KEY'], defaultBaseURL: 'https://api.minimax.io/anthropic' },
  'minimax-cn': { env: ['MINIMAX_CN_API_KEY'], defaultBaseURL: 'https://api.minimaxi.com/anthropic' },
  'mistral': { env: ['MISTRAL_API_KEY'], defaultBaseURL: 'https://api.mistral.ai' },
  'moonshotai': { env: ['MOONSHOT_API_KEY'], defaultBaseURL: 'https://api.moonshot.ai/v1' },
  'moonshotai-cn': { env: ['MOONSHOT_API_KEY'], defaultBaseURL: 'https://api.moonshot.cn/v1' },
  'nvidia': { env: ['NVIDIA_API_KEY'], defaultBaseURL: 'https://integrate.api.nvidia.com/v1' },
  'openai': { env: ['OPENAI_API_KEY'], defaultBaseURL: 'https://api.openai.com/v1' },
  'openai-codex': { env: [], defaultBaseURL: 'https://chatgpt.com/backend-api' },
  'opencode': { env: ['OPENCODE_API_KEY'] },
  'opencode-go': { env: ['OPENCODE_API_KEY'] },
  'openrouter': { env: ['OPENROUTER_API_KEY'], defaultBaseURL: 'https://openrouter.ai/api/v1' },
  'qwen-token-plan': { env: ['QWEN_TOKEN_PLAN_API_KEY'], defaultBaseURL: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1' },
  'qwen-token-plan-cn': { env: ['QWEN_TOKEN_PLAN_CN_API_KEY'], defaultBaseURL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' },
  'qwen-token-plan-individual': { env: ['QWEN_TOKEN_PLAN_API_KEY'], defaultBaseURL: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1' },
  'radius': { env: ['RADIUS_API_KEY'], defaultBaseURL: 'https://radius.pi.dev/v1' },
  'together': { env: ['TOGETHER_API_KEY'], defaultBaseURL: 'https://api.together.ai/v1' },
  'typesafe': { env: ['TYPESAFE_API_KEY'] },
  'vercel-ai-gateway': { env: ['AI_GATEWAY_API_KEY'], defaultBaseURL: 'https://ai-gateway.vercel.sh' },
  'xai': { env: ['XAI_API_KEY'], defaultBaseURL: 'https://api.x.ai/v1' },
  'xiaomi': { env: ['XIAOMI_API_KEY'], defaultBaseURL: 'https://api.xiaomimimo.com/v1' },
  'xiaomi-token-plan-ams': { env: ['XIAOMI_TOKEN_PLAN_AMS_API_KEY'], defaultBaseURL: 'https://token-plan-ams.xiaomimimo.com/v1' },
  'xiaomi-token-plan-cn': { env: ['XIAOMI_TOKEN_PLAN_CN_API_KEY'], defaultBaseURL: 'https://token-plan-cn.xiaomimimo.com/v1' },
  'xiaomi-token-plan-sgp': { env: ['XIAOMI_TOKEN_PLAN_SGP_API_KEY'], defaultBaseURL: 'https://token-plan-sgp.xiaomimimo.com/v1' },
  'zai': { env: ['ZAI_API_KEY'], defaultBaseURL: 'https://api.z.ai/api/coding/paas/v4' },
  'zai-coding-cn': { env: ['ZAI_CODING_CN_API_KEY'], defaultBaseURL: 'https://open.bigmodel.cn/api/coding/paas/v4' },
}
