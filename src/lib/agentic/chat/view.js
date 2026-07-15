import "./view.scss";
import Page from "components/page";
import select from "dialogs/select";
import actionStack from "lib/actionStack";
import {
	getModel,
	getProvider,
	listModels,
	listProviders,
} from "lib/agentic/catalog";
import {
	appendAssistantMessage,
	appendUserMessage,
	createNewSession,
	deleteSession,
	getActiveSession,
	loadStore,
	saveStore,
	setActiveSession,
	updateSettings,
} from "./store";

const STUB_REPLY =
	"API is not connected yet. Your message was saved locally — model calls come next.";

const THINKING_OPTIONS = [
	{ value: "off", text: "Thinking: Off" },
	{ value: "low", text: "Thinking: Low" },
	{ value: "medium", text: "Thinking: Medium" },
	{ value: "high", text: "Thinking: High" },
];

/** Preferred providers shown first in the picker. */
const PREFERRED_PROVIDERS = [
	"anthropic",
	"openai",
	"google",
	"openrouter",
	"groq",
	"xai",
	"mistral",
	"deepseek",
	"opencode",
];

/**
 * @returns {HTMLElement}
 */
export default function createAgentChatView() {
	let state = loadStore();
	state = ensureValidModel(state);
	saveStore(state);

	const $page = Page("Chat");
	$page.classList.add("agentic-chat-page");

	const $root = <div className="agentic-chat" />;
	const $backdrop = (
		<button
			type="button"
			className="agentic-chat__backdrop"
			aria-label="Close chats"
		/>
	);
	const $drawer = <aside className="agentic-chat__drawer" />;
	const $drawerHead = <div className="agentic-chat__drawer-head" />;
	const $drawerTitle = <h2>Chats</h2>;
	const $newChatBtn = (
		<button type="button" className="agentic-chat__new">
			<span className="icon add" />
			New
		</button>
	);
	const $sessionList = <ul className="agentic-chat__session-list" />;

	const $main = <div className="agentic-chat__main" />;
	const $toolbar = <div className="agentic-chat__toolbar" />;
	const $menuBtn = (
		<span
			className="icon menu"
			role="button"
			tabIndex={0}
			aria-label="Open chats"
		/>
	);
	const $toolbarTitle = <div className="agentic-chat__toolbar-title" />;
	const $messages = <div className="agentic-chat__messages" />;
	const $composer = <div className="agentic-chat__composer" />;
	const $controls = <div className="agentic-chat__controls" />;
	const $modelChip = (
		<button type="button" className="agentic-chat__chip" />
	);
	const $thinkingChip = (
		<button type="button" className="agentic-chat__chip" />
	);
	const $inputRow = <div className="agentic-chat__input-row" />;
	const $input = (
		<textarea
			className="agentic-chat__input"
			rows={1}
			placeholder="Message…"
			enterKeyHint="send"
		/>
	);
	const $sendBtn = (
		<button type="button" className="agentic-chat__send" aria-label="Send">
			<span className="icon send" />
		</button>
	);

	$drawerHead.append($drawerTitle, $newChatBtn);
	$drawer.append($drawerHead, $sessionList);
	$toolbar.append($menuBtn, $toolbarTitle);
	$controls.append($modelChip, $thinkingChip);
	$inputRow.append($input, $sendBtn);
	$composer.append($controls, $inputRow);
	$main.append($toolbar, $messages, $composer);
	$root.append($backdrop, $drawer, $main);
	$page.append($root);

	function persist(next) {
		state = next;
		saveStore(state);
		render();
	}

	function openDrawer() {
		$root.classList.add("drawer-open");
	}

	function closeDrawer() {
		$root.classList.remove("drawer-open");
	}

	function toggleDrawer() {
		$root.classList.toggle("drawer-open");
	}

	function renderSessions() {
		$sessionList.innerHTML = "";
		const sorted = [...state.sessions].sort(
			(a, b) => b.updatedAt - a.updatedAt,
		);
		for (const session of sorted) {
			const active = session.id === state.activeId;
			const $item = (
				<li
					className={`agentic-chat__session${active ? " active" : ""}`}
				/>
			);
			const $open = (
				<button type="button" className="agentic-chat__session-open">
					<span className="agentic-chat__session-title">
						{session.title || "New chat"}
					</span>
				</button>
			);
			const $del = (
				<button
					type="button"
					className="agentic-chat__session-delete icon clearclose"
					aria-label="Delete chat"
				/>
			);
			$open.onclick = () => {
				persist(setActiveSession(state, session.id));
				closeDrawer();
			};
			$del.onclick = (e) => {
				e.stopPropagation();
				persist(deleteSession(state, session.id));
			};
			$item.append($open, $del);
			$sessionList.append($item);
		}
	}

	function renderMessages() {
		const session = getActiveSession(state);
		$messages.innerHTML = "";
		$toolbarTitle.textContent = session?.title || "New chat";

		if (!session?.messages?.length) {
			$messages.append(
				<div className="agentic-chat__empty">
					Start a conversation. Pick a model below, then send a message.
				</div>,
			);
			return;
		}

		for (const message of session.messages) {
			$messages.append(
				<div className={`agentic-chat__bubble ${message.role}`}>
					{message.content}
				</div>,
			);
		}
		requestAnimationFrame(() => {
			$messages.scrollTop = $messages.scrollHeight;
		});
	}

	function renderControls() {
		const provider = getProvider(state.settings.providerId);
		const model = getModel(
			state.settings.providerId,
			state.settings.modelId,
		);
		const modelLabel = model
			? `${provider?.name || state.settings.providerId} / ${model.name}`
			: "Select model";
		$modelChip.textContent = modelLabel;
		$modelChip.title = modelLabel;

		const thinkingLabel =
			THINKING_OPTIONS.find((o) => o.value === state.settings.thinking)
				?.text || "Thinking: Off";
		$thinkingChip.textContent = thinkingLabel;
		const canThink = !!model?.reasoning;
		$thinkingChip.disabled = !canThink;
		if (!canThink && state.settings.thinking !== "off") {
			state = updateSettings(state, { thinking: "off" });
			saveStore(state);
			$thinkingChip.textContent = "Thinking: Off";
		}
	}

	function render() {
		renderSessions();
		renderMessages();
		renderControls();
	}

	async function pickModel() {
		const providers = sortProviders(listProviders());
		const providerId = await select(
			"Provider",
			providers.map((p) => ({
				value: p.id,
				text: `${p.name} (${Object.keys(p.models).length})`,
			})),
			{ default: state.settings.providerId, hideOnSelect: true },
		).catch(() => null);
		if (!providerId) return;

		const models = listModels(providerId).filter(
			(m) => m.status !== "deprecated",
		);
		if (!models.length) return;

		const modelId = await select(
			"Model",
			models.map((m) => ({
				value: m.id,
				text: m.reasoning ? `${m.name} · reasoning` : m.name,
			})),
			{
				default:
					providerId === state.settings.providerId
						? state.settings.modelId
						: models[0].id,
				hideOnSelect: true,
			},
		).catch(() => null);
		if (!modelId) return;

		const model = getModel(providerId, modelId);
		persist(
			updateSettings(state, {
				providerId,
				modelId,
				thinking: model?.reasoning ? state.settings.thinking : "off",
			}),
		);
	}

	async function pickThinking() {
		const model = getModel(
			state.settings.providerId,
			state.settings.modelId,
		);
		if (!model?.reasoning) return;

		const value = await select("Thinking", THINKING_OPTIONS, {
			default: state.settings.thinking,
			hideOnSelect: true,
		}).catch(() => null);
		if (!value) return;
		persist(updateSettings(state, { thinking: value }));
	}

	function send() {
		const text = $input.value.trim();
		if (!text) return;
		$input.value = "";
		autoGrow();

		let next = appendUserMessage(state, text);
		const provider = getProvider(next.settings.providerId);
		const model = getModel(next.settings.providerId, next.settings.modelId);
		const thinking =
			model?.reasoning && next.settings.thinking !== "off"
				? ` Thinking: ${next.settings.thinking}.`
				: "";
		const stub = `${STUB_REPLY}\n\nSelected: ${provider?.name || next.settings.providerId} / ${model?.name || next.settings.modelId}.${thinking}`;
		next = appendAssistantMessage(next, stub);
		persist(next);
	}

	function autoGrow() {
		$input.style.height = "auto";
		$input.style.height = `${Math.min($input.scrollHeight, 140)}px`;
	}

	$menuBtn.onclick = toggleDrawer;
	$menuBtn.onkeydown = (e) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			toggleDrawer();
		}
	};
	$backdrop.onclick = closeDrawer;
	$newChatBtn.onclick = () => {
		persist(createNewSession(state));
		closeDrawer();
		$input.focus();
	};
	$modelChip.onclick = () => {
		pickModel().catch((err) => console.error(err));
	};
	$thinkingChip.onclick = () => {
		pickThinking().catch((err) => console.error(err));
	};
	$sendBtn.onclick = send;
	$input.addEventListener("input", autoGrow);
	$input.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	});

	actionStack.push({
		id: "agentic-chat",
		action: () => {
			$page.hide();
		},
	});

	$page.onhide = () => {
		actionStack.remove("agentic-chat");
		closeDrawer();
	};

	render();
	app.append($page);
	return $page;
}

/**
 * @param {import("./store").ChatStoreState} state
 */
function ensureValidModel(state) {
	let { providerId, modelId } = state.settings;
	let provider = getProvider(providerId);
	let model = getModel(providerId, modelId);

	if (!provider || !model) {
		for (const id of PREFERRED_PROVIDERS) {
			const p = getProvider(id);
			if (!p) continue;
			const models = listModels(id).filter((m) => m.status !== "deprecated");
			if (!models.length) continue;
			providerId = id;
			modelId = models[0].id;
			provider = p;
			model = models[0];
			break;
		}
	}

	if (!provider || !model) {
		const first = listProviders()[0];
		if (first) {
			providerId = first.id;
			modelId = Object.keys(first.models)[0];
		}
	}

	const resolved = getModel(providerId, modelId);
	return updateSettings(state, {
		providerId,
		modelId,
		thinking: resolved?.reasoning ? state.settings.thinking : "off",
	});
}

/**
 * @param {import("lib/agentic/types").Provider[]} providers
 */
function sortProviders(providers) {
	const rank = new Map(PREFERRED_PROVIDERS.map((id, i) => [id, i]));
	return [...providers].sort((a, b) => {
		const ra = rank.has(a.id) ? rank.get(a.id) : 999;
		const rb = rank.has(b.id) ? rank.get(b.id) : 999;
		if (ra !== rb) return ra - rb;
		return a.name.localeCompare(b.name);
	});
}
