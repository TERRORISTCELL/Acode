/**
 * Per-provider API key storage.
 * Keys are stored locally on the device (localStorage) and never leave it
 * except in requests to the provider's own API.
 */

const STORAGE_KEY = "acode.agentic.apiKeys";

/**
 * @returns {Record<string, string>}
 */
function load() {
	try {
		const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
		return raw && typeof raw === "object" ? raw : {};
	} catch {
		return {};
	}
}

/**
 * @param {Record<string, string>} keys
 */
function save(keys) {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
}

/**
 * @param {string} providerId
 * @returns {string}
 */
export function getApiKey(providerId) {
	return load()[providerId] || "";
}

/**
 * @param {string} providerId
 * @returns {boolean}
 */
export function hasApiKey(providerId) {
	return !!getApiKey(providerId);
}

/**
 * @param {string} providerId
 * @param {string} key - empty string removes the key
 */
export function setApiKey(providerId, key) {
	const keys = load();
	if (key) {
		keys[providerId] = key;
	} else {
		delete keys[providerId];
	}
	save(keys);
}
