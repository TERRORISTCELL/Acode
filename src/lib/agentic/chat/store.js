import { addedFolder } from "lib/openFolder";
import helpers from "utils/helpers";

const LEGACY_STORAGE_KEY = "acode.agentic.chats";
const SETTINGS_KEY = "acode.agentic.settings";
const WORKSPACE_PREFIX = "acode.agentic.chats.ws.";
const MAX_SESSIONS = 50;

/** @typedef {"off"|"low"|"medium"|"high"} ThinkingLevel */

/**
 * @typedef {object} MessagePart
 * @property {"text"|"reasoning"|"tool"} type
 * @property {string} [text]
 * @property {string} [signature]
 * @property {string} [callId]
 * @property {string} [name]
 * @property {object} [args]
 * @property {string} [summary]
 * @property {"running"|"done"} [status]
 * @property {string|null} [result]
 * @property {boolean} [isError]
 */

/**
 * @typedef {object} ChatMessage
 * @property {string} id
 * @property {"user"|"assistant"} role
 * @property {MessagePart[]} parts
 * @property {number} createdAt
 * @property {string} [error]
 */

/**
 * @typedef {object} ChatSession
 * @property {string} id
 * @property {string} title
 * @property {number} updatedAt
 * @property {ChatMessage[]} messages
 */

/**
 * @typedef {object} ChatSettings
 * @property {string} providerId
 * @property {string} modelId
 * @property {ThinkingLevel} thinking
 */

/**
 * @typedef {object} ChatStoreState
 * @property {string} activeId
 * @property {ChatSettings} settings
 * @property {ChatSession[]} sessions
 * @property {string} workspaceKey
 * @property {string} workspaceLabel
 */

const DEFAULT_SETTINGS = Object.freeze({
	providerId: "anthropic",
	modelId: "claude-sonnet-4-5",
	thinking: "off",
});

/**
 * Stable key for the current workspace (primary open folder).
 * Chats with no folder open live under "none".
 * @returns {{ key: string, label: string, url: string }}
 */
export function getWorkspaceInfo() {
	const folder = addedFolder[0];
	if (!folder?.url) {
		return { key: "none", label: "No folder", url: "" };
	}
	const url = String(folder.url).replace(/\/+$/, "");
	return {
		key: hashKey(url),
		label: folder.title || "Workspace",
		url,
	};
}

/**
 * @param {string} input
 */
function hashKey(input) {
	let hash = 2166136261;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

function workspaceStorageKey(workspaceKey) {
	return `${WORKSPACE_PREFIX}${workspaceKey}`;
}

/**
 * @returns {ChatSession}
 */
export function createSession(title = "New chat") {
	return {
		id: helpers.uuid(),
		title,
		updatedAt: Date.now(),
		messages: [],
	};
}

/**
 * @param {"user"|"assistant"} role
 * @param {MessagePart[]} parts
 * @returns {ChatMessage}
 */
export function createMessage(role, parts = []) {
	return {
		id: helpers.uuid(),
		role,
		parts,
		createdAt: Date.now(),
	};
}

/**
 * @returns {ChatStoreState}
 */
function defaultState(workspace = getWorkspaceInfo()) {
	const session = createSession();
	return {
		activeId: session.id,
		settings: loadSettings(),
		sessions: [session],
		workspaceKey: workspace.key,
		workspaceLabel: workspace.label,
	};
}

function normalizeParts(message) {
	if (Array.isArray(message.parts)) {
		return message.parts
			.filter((p) => p && typeof p.type === "string")
			.map((p) => {
				if (p.type === "tool") {
					return {
						type: "tool",
						callId: String(p.callId || helpers.uuid()),
						name: String(p.name || ""),
						args: p.args && typeof p.args === "object" ? p.args : {},
						summary: String(p.summary || p.name || ""),
						status: "done",
						result: typeof p.result === "string" ? p.result : null,
						isError: !!p.isError,
					};
				}
				const part = {
					type: p.type === "reasoning" ? "reasoning" : "text",
					text: String(p.text ?? ""),
				};
				if (typeof p.signature === "string") part.signature = p.signature;
				return part;
			});
	}
	const content = String(message.content ?? "");
	return content ? [{ type: "text", text: content }] : [];
}

/**
 * @param {unknown} raw
 * @param {{ key: string, label: string }} workspace
 * @param {ChatSettings} settings
 * @returns {ChatStoreState}
 */
function normalize(raw, workspace, settings) {
	if (!raw || typeof raw !== "object") return defaultState(workspace);

	const sessions = Array.isArray(raw.sessions)
		? raw.sessions
				.filter((s) => s && typeof s.id === "string")
				.map((s) => ({
					id: s.id,
					title: typeof s.title === "string" ? s.title : "New chat",
					updatedAt: Number(s.updatedAt) || Date.now(),
					messages: Array.isArray(s.messages)
						? s.messages
								.filter(
									(m) => m && (m.role === "user" || m.role === "assistant"),
								)
								.map((m) => ({
									id: m.id || helpers.uuid(),
									role: m.role,
									parts: normalizeParts(m),
									createdAt: Number(m.createdAt) || Date.now(),
									...(typeof m.error === "string" && m.error
										? { error: m.error }
										: {}),
								}))
						: [],
				}))
		: [];

	if (!sessions.length) return defaultState(workspace);

	const activeId =
		typeof raw.activeId === "string" &&
		sessions.some((s) => s.id === raw.activeId)
			? raw.activeId
			: sessions[0].id;

	return {
		activeId,
		settings,
		sessions,
		workspaceKey: workspace.key,
		workspaceLabel: workspace.label,
	};
}

/**
 * @returns {ChatSettings}
 */
function loadSettings() {
	try {
		const parsed = helpers.parseJSON(localStorage.getItem(SETTINGS_KEY));
		if (parsed && typeof parsed === "object") {
			return {
				providerId:
					typeof parsed.providerId === "string"
						? parsed.providerId
						: DEFAULT_SETTINGS.providerId,
				modelId:
					typeof parsed.modelId === "string"
						? parsed.modelId
						: DEFAULT_SETTINGS.modelId,
				thinking: ["off", "low", "medium", "high"].includes(parsed.thinking)
					? parsed.thinking
					: DEFAULT_SETTINGS.thinking,
			};
		}
	} catch {
		// fall through
	}

	// One-time: pull settings out of the legacy global chat blob.
	try {
		const legacy = helpers.parseJSON(localStorage.getItem(LEGACY_STORAGE_KEY));
		if (legacy?.settings && typeof legacy.settings === "object") {
			const settings = {
				providerId:
					typeof legacy.settings.providerId === "string"
						? legacy.settings.providerId
						: DEFAULT_SETTINGS.providerId,
				modelId:
					typeof legacy.settings.modelId === "string"
						? legacy.settings.modelId
						: DEFAULT_SETTINGS.modelId,
				thinking: ["off", "low", "medium", "high"].includes(
					legacy.settings.thinking,
				)
					? legacy.settings.thinking
					: DEFAULT_SETTINGS.thinking,
			};
			saveSettings(settings);
			return settings;
		}
	} catch {
		// ignore
	}

	return { ...DEFAULT_SETTINGS };
}

/**
 * @param {ChatSettings} settings
 */
function saveSettings(settings) {
	try {
		localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
	} catch (error) {
		console.error("Failed to persist agent settings:", error);
	}
}

/**
 * Move the old global chat list into the current workspace once.
 * @param {string} workspaceKey
 */
function migrateLegacyIfNeeded(workspaceKey) {
	const targetKey = workspaceStorageKey(workspaceKey);
	if (localStorage.getItem(targetKey)) return;

	const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
	if (!legacy) return;

	try {
		localStorage.setItem(targetKey, legacy);
		localStorage.removeItem(LEGACY_STORAGE_KEY);
	} catch (error) {
		console.error("Failed to migrate legacy chats:", error);
	}
}

/**
 * @returns {ChatStoreState}
 */
export function loadStore() {
	const workspace = getWorkspaceInfo();
	migrateLegacyIfNeeded(workspace.key);
	const settings = loadSettings();

	try {
		const raw = helpers.parseJSON(
			localStorage.getItem(workspaceStorageKey(workspace.key)),
		);
		return normalize(raw, workspace, settings);
	} catch {
		return defaultState(workspace);
	}
}

/**
 * @param {ChatStoreState} state
 */
export function saveStore(state) {
	try {
		saveSettings(state.settings);
		const trimmed = {
			activeId: state.activeId,
			sessions: [...state.sessions]
				.sort((a, b) => b.updatedAt - a.updatedAt)
				.slice(0, MAX_SESSIONS),
		};
		localStorage.setItem(
			workspaceStorageKey(state.workspaceKey || getWorkspaceInfo().key),
			JSON.stringify(trimmed),
		);
	} catch (error) {
		console.error("Failed to persist chats:", error);
	}
}

/**
 * @param {ChatStoreState} state
 * @returns {ChatSession | undefined}
 */
export function getActiveSession(state) {
	return state.sessions.find((s) => s.id === state.activeId);
}

/**
 * @param {string} text
 */
export function titleFromText(text) {
	const clean = text.trim().replace(/\s+/g, " ");
	return clean.slice(0, 48) + (clean.length > 48 ? "…" : "");
}

export { DEFAULT_SETTINGS };
