/**
 * AI SDK packages OpenCode bundles for provider runtimes.
 * Source: opencode/packages/opencode/src/provider/provider.ts (BUNDLED_PROVIDERS)
 *
 * Model catalog lives in models.dev; this map only wires which npm package
 * creates the language-model SDK for a provider's `npm` field.
 */
export const SDK_PACKAGES = Object.freeze({
	"@ai-sdk/amazon-bedrock": "amazon-bedrock",
	"@ai-sdk/amazon-bedrock/mantle": "amazon-bedrock-mantle",
	"@ai-sdk/anthropic": "anthropic",
	"@ai-sdk/azure": "azure",
	"@ai-sdk/google": "google",
	"@ai-sdk/google-vertex": "google-vertex",
	"@ai-sdk/google-vertex/anthropic": "google-vertex-anthropic",
	"@ai-sdk/openai": "openai",
	"@ai-sdk/openai-compatible": "openai-compatible",
	"@openrouter/ai-sdk-provider": "openrouter",
	"@ai-sdk/xai": "xai",
	"@ai-sdk/mistral": "mistral",
	"@ai-sdk/groq": "groq",
	"@ai-sdk/deepinfra": "deepinfra",
	"@ai-sdk/cerebras": "cerebras",
	"@ai-sdk/cohere": "cohere",
	"@ai-sdk/gateway": "gateway",
	"@ai-sdk/togetherai": "togetherai",
	"@ai-sdk/perplexity": "perplexity",
	"@ai-sdk/vercel": "vercel",
	"@ai-sdk/alibaba": "alibaba",
	"gitlab-ai-provider": "gitlab",
	"@ai-sdk/github-copilot": "github-copilot",
	"venice-ai-sdk-provider": "venice",
});

/**
 * @param {string | undefined} npm
 * @returns {boolean}
 */
export function isBundledSdkPackage(npm) {
	return !!npm && Object.prototype.hasOwnProperty.call(SDK_PACKAGES, npm);
}
