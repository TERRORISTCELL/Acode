/**
 * Agentic foundations for Acode — provider/model catalog from OpenCode's source
 * (https://models.dev/api.json).
 */

export { default as runAgent } from "./agent";
export {
	catalog,
	getModel,
	getProvider,
	listBundledProviders,
	listModels,
	listProviders,
	meta,
	resolveModel,
} from "./catalog";
export { default as openAgentChat } from "./chat";
export { default as streamChat, isProviderSupported } from "./client";
export { getApiKey, hasApiKey, setApiKey } from "./keys";
export { isBundledSdkPackage, SDK_PACKAGES } from "./sdkPackages";
export { executeTool, TOOL_DEFINITIONS } from "./tools";
