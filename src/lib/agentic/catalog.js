/**
 * OpenCode-compatible model/provider catalog (from models.dev).
 *
 * Shape matches OpenCode's models.dev API:
 *   Record<providerId, { id, name, env, api?, npm?, doc?, models: Record<modelId, Model> }>
 */
import catalogData from "./data/catalog.json";
import metaData from "./data/meta.json";

/** @type {Record<string, import("./types").Provider>} */
const catalog = catalogData;

/** @type {import("./types").CatalogMeta} */
export const meta = metaData;

/**
 * @returns {import("./types").Provider[]}
 */
export function listProviders() {
	return Object.values(catalog).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * @param {string} providerId
 * @returns {import("./types").Provider | undefined}
 */
export function getProvider(providerId) {
	return catalog[providerId];
}

/**
 * @param {string} providerId
 * @returns {import("./types").Model[]}
 */
export function listModels(providerId) {
	const provider = catalog[providerId];
	if (!provider) return [];
	return Object.values(provider.models).sort((a, b) =>
		a.name.localeCompare(b.name),
	);
}

/**
 * @param {string} providerId
 * @param {string} modelId
 * @returns {import("./types").Model | undefined}
 */
export function getModel(providerId, modelId) {
	return catalog[providerId]?.models?.[modelId];
}

/**
 * Resolve `providerId/modelId` or search by model id across providers.
 * @param {string} ref - "openai/o3" or "o3"
 * @returns {{ provider: import("./types").Provider, model: import("./types").Model } | undefined}
 */
export function resolveModel(ref) {
	if (!ref) return undefined;

	const slash = ref.indexOf("/");
	if (slash > 0) {
		const providerId = ref.slice(0, slash);
		const modelId = ref.slice(slash + 1);
		const provider = catalog[providerId];
		const model = provider?.models?.[modelId];
		if (provider && model) return { provider, model };
		return undefined;
	}

	for (const provider of Object.values(catalog)) {
		const model = provider.models[ref];
		if (model) return { provider, model };
	}
	return undefined;
}

/**
 * Providers that ship a direct AI SDK package OpenCode already bundles.
 * @returns {import("./types").Provider[]}
 */
export function listBundledProviders() {
	return listProviders().filter((p) => !!p.npm);
}

export { catalog };
export default catalog;
