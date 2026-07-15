import helpers from "utils/helpers";

const STORAGE_KEY = "acode.agentic.chats";

/** @typedef {"off"|"low"|"medium"|"high"} ThinkingLevel */

/**
 * @typedef {object} ChatMessage
 * @property {string} id
 * @property {"user"|"assistant"} role
 * @property {string} content
 * @property {number} createdAt
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
 */

const DEFAULT_SETTINGS = Object.freeze({
	providerId: "anthropic",
	modelId: "claude-sonnet-4-5",
	thinking: "off",
});

/**
 * @returns {ChatSession}
 */
function createSession(title = "New chat") {
	const now = Date.now();
	return {
		id: helpers.uuid(),
		title,
		updatedAt: now,
		messages: [],
	};
}

/**
 * @returns {ChatStoreState}
 */
function defaultState() {
	const session = createSession();
	return {
		activeId: session.id,
		settings: { ...DEFAULT_SETTINGS },
		sessions: [session],
	};
}

/**
 * @param {unknown} raw
 * @returns {ChatStoreState}
 */
function normalize(raw) {
	if (!raw || typeof raw !== "object") return defaultState();

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
									content: String(m.content ?? ""),
									createdAt: Number(m.createdAt) || Date.now(),
								}))
						: [],
				}))
		: [];

	if (!sessions.length) return defaultState();

	const settings = {
		providerId:
			typeof raw.settings?.providerId === "string"
				? raw.settings.providerId
				: DEFAULT_SETTINGS.providerId,
		modelId:
			typeof raw.settings?.modelId === "string"
				? raw.settings.modelId
				: DEFAULT_SETTINGS.modelId,
		thinking: ["off", "low", "medium", "high"].includes(raw.settings?.thinking)
			? raw.settings.thinking
			: DEFAULT_SETTINGS.thinking,
	};

	const activeId =
		typeof raw.activeId === "string" &&
		sessions.some((s) => s.id === raw.activeId)
			? raw.activeId
			: sessions[0].id;

	return { activeId, settings, sessions };
}

/**
 * @returns {ChatStoreState}
 */
export function loadStore() {
	try {
		const parsed = helpers.parseJSON(localStorage.getItem(STORAGE_KEY));
		return normalize(parsed);
	} catch {
		return defaultState();
	}
}

/**
 * @param {ChatStoreState} state
 */
export function saveStore(state) {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/**
 * @param {ChatStoreState} state
 * @returns {ChatSession | undefined}
 */
export function getActiveSession(state) {
	return state.sessions.find((s) => s.id === state.activeId);
}

/**
 * @param {ChatStoreState} state
 * @returns {ChatStoreState}
 */
export function createNewSession(state) {
	const session = createSession();
	return {
		...state,
		activeId: session.id,
		sessions: [session, ...state.sessions],
	};
}

/**
 * @param {ChatStoreState} state
 * @param {string} sessionId
 * @returns {ChatStoreState}
 */
export function setActiveSession(state, sessionId) {
	if (!state.sessions.some((s) => s.id === sessionId)) return state;
	return { ...state, activeId: sessionId };
}

/**
 * @param {ChatStoreState} state
 * @param {string} sessionId
 * @returns {ChatStoreState}
 */
export function deleteSession(state, sessionId) {
	const sessions = state.sessions.filter((s) => s.id !== sessionId);
	if (!sessions.length) {
		const session = createSession();
		return {
			...state,
			activeId: session.id,
			sessions: [session],
		};
	}
	const activeId =
		state.activeId === sessionId ? sessions[0].id : state.activeId;
	return { ...state, activeId, sessions };
}

/**
 * @param {ChatStoreState} state
 * @param {Partial<ChatSettings>} patch
 * @returns {ChatStoreState}
 */
export function updateSettings(state, patch) {
	return {
		...state,
		settings: { ...state.settings, ...patch },
	};
}

/**
 * @param {ChatStoreState} state
 * @param {string} content
 * @returns {ChatStoreState}
 */
export function appendUserMessage(state, content) {
	const text = content.trim();
	if (!text) return state;

	const sessions = state.sessions.map((session) => {
		if (session.id !== state.activeId) return session;
		const messages = [
			...session.messages,
			{
				id: helpers.uuid(),
				role: "user",
				content: text,
				createdAt: Date.now(),
			},
		];
		const title =
			session.messages.length === 0
				? text.slice(0, 48) + (text.length > 48 ? "…" : "")
				: session.title;
		return {
			...session,
			title,
			updatedAt: Date.now(),
			messages,
		};
	});

	return { ...state, sessions };
}

/**
 * @param {ChatStoreState} state
 * @param {string} content
 * @returns {ChatStoreState}
 */
export function appendAssistantMessage(state, content) {
	const sessions = state.sessions.map((session) => {
		if (session.id !== state.activeId) return session;
		return {
			...session,
			updatedAt: Date.now(),
			messages: [
				...session.messages,
				{
					id: helpers.uuid(),
					role: "assistant",
					content,
					createdAt: Date.now(),
				},
			],
		};
	});
	return { ...state, sessions };
}

export { createSession, DEFAULT_SETTINGS };
