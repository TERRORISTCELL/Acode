/**
 * Full-screen agent chat surface (singleton).
 * Lazy-import from main header; closes with Page back / actionStack.
 */
import createAgentChatView from "./view";

/** @type {HTMLElement | null} */
let openPage = null;

/**
 * Opens the agent chat UI. Reuses the existing page if still mounted.
 */
export default function openAgentChat() {
	if (openPage?.isConnected) {
		return openPage;
	}

	openPage = createAgentChatView();
	openPage.on("hide", () => {
		openPage = null;
	});
	return openPage;
}
