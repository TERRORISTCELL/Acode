import "./view.scss";
import Page from "components/page";
import confirm from "dialogs/confirm";
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
	{ value: "off", text: "Off" },
	{ value: "low", text: "Low" },
	{ value: "medium", text: "Medium" },
	{ value: "high", text: "High" },
];

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
 * Full-screen agent chat surface.
 * @returns {HTMLElement}
 */
export default function createAgentChatView() {
	let state = ensureValidModel(loadStore());
	saveStore(state);

	const $menuBtn = (
		<span className="icon menu" role="button" tabIndex={0} aria-label="Chats" />
	);
	const $page = Page("Chat", { tail: $menuBtn });
	$page.classList.add("agentic-chat-page");

	const $root = <div className="agentic-chat" />;
	const $backdrop = (
		<button
			type="button"
			className="agentic-chat__backdrop"
			aria-label="Close chats"
		/>
	);
	const $drawer = <aside className="agentic-chat__drawer" aria-label="Chats" />;
	const $drawerHead = <div className="agentic-chat__drawer-head" />;
	const $drawerTitle = <h2>Chats</h2>;
	const $newChatBtn = (
		<button type="button" className="agentic-chat__new">
			<span className="icon add" aria-hidden="true" />
			New chat
		</button>
	);
	const $sessionList = <ul className="agentic-chat__session-list" />;

	const $main = <div className="agentic-chat__main" />;
	const $messages = (
		<div className="agentic-chat__messages" role="log" aria-live="polite" />
	);
	const $composer = <div className="agentic-chat__composer" />;
	const $meta = <div className="agentic-chat__meta" />;
	const $modelBtn = (
		<button type="button" className="agentic-chat__meta-btn">
			<span className="agentic-chat__meta-label">Model</span>
			<span className="agentic-chat__meta-value" />
			<span className="icon arrow_drop_down" aria-hidden="true" />
		</button>
	);
	const $thinkingBtn = (
		<button type="button" className="agentic-chat__meta-btn">
			<span className="agentic-chat__meta-label">Thinking</span>
			<span className="agentic-chat__meta-value" />
			<span className="icon arrow_drop_down" aria-hidden="true" />
		</button>
	);
	const $inputRow = <div className="agentic-chat__input-row" />;
	const $input = (
		<textarea
			className="agentic-chat__input"
			rows={1}
			placeholder="Message…"
			enterKeyHint="send"
			aria-label="Message"
		/>
	);
	const $sendBtn = (
		<button type="button" className="agentic-chat__send" aria-label="Send">
			<span className="icon send" aria-hidden="true" />
		</button>
	);

	$drawerHead.append($drawerTitle, $newChatBtn);
	$drawer.append($drawerHead, $sessionList);
	$meta.append($modelBtn, $thinkingBtn);
	$inputRow.append($input, $sendBtn);
	$composer.append($meta, $inputRow);
	$main.append($messages, $composer);
	$root.append($backdrop, $drawer, $main);
	$page.append($root);

	const $modelValue = $modelBtn.get(".agentic-chat__meta-value");
	const $thinkingValue = $thinkingBtn.get(".agentic-chat__meta-value");

	function persist(next) {
		state = next;
		saveStore(state);
		render();
	}

	function isDrawerOpen() {
		return $root.classList.contains("drawer-open");
	}

	function openDrawer() {
		if (isDrawerOpen()) return;
		$root.classList.add("drawer-open");
		actionStack.push({
			id: "agentic-chat-drawer",
			action: closeDrawer,
		});
	}

	function closeDrawer() {
		if (!isDrawerOpen()) return;
		$root.classList.remove("drawer-open");
		actionStack.remove("agentic-chat-drawer");
	}

	function toggleDrawer() {
		if (isDrawerOpen()) closeDrawer();
		else openDrawer();
	}

	function renderSessions() {
		$sessionList.innerHTML = "";
		const sorted = [...state.sessions].sort(
			(a, b) => b.updatedAt - a.updatedAt,
		);

		if (!sorted.length) {
			$sessionList.append(
				<li className="agentic-chat__session-empty">No chats yet</li>,
			);
			return;
		}

		for (const session of sorted) {
			const active = session.id === state.activeId;
			const $item = (
				<li className={`agentic-chat__session${active ? " active" : ""}`} />
			);
			const $open = (
				<button type="button" className="agentic-chat__session-open">
					<span className="agentic-chat__session-title">
						{session.title || "New chat"}
					</span>
					<span className="agentic-chat__session-sub">
						{formatRelative(session.updatedAt)}
						{session.messages?.length
							? ` · ${session.messages.length} msg`
							: ""}
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
			$del.onclick = async (e) => {
				e.stopPropagation();
				const ok = await confirm(
					"Delete chat?",
					session.title || "New chat",
				).catch(() => false);
				if (!ok) return;
				persist(deleteSession(state, session.id));
			};
			$item.append($open, $del);
			$sessionList.append($item);
		}
	}

	function renderMessages() {
		const session = getActiveSession(state);
		const title = session?.title || "New chat";
		$page.settitle(title);
		$messages.innerHTML = "";

		if (!session?.messages?.length) {
			$messages.append(
				<div className="agentic-chat__empty">
					<span className="icon chat_bubble agentic-chat__empty-icon" />
					<strong>Start a chat</strong>
					<p>Choose a model below, then ask about the project.</p>
				</div>,
			);
			return;
		}

		for (const message of session.messages) {
			$messages.append(
				<div
					className={`agentic-chat__bubble ${message.role}`}
					data-role={message.role}
				>
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
		const model = getModel(state.settings.providerId, state.settings.modelId);
		$modelValue.textContent = model?.name || "Select model";
		$modelBtn.title = model
			? `${provider?.name || state.settings.providerId} · ${model.name}`
			: "Select model";

		const canThink = !!model?.reasoning;
		const thinking =
			THINKING_OPTIONS.find((o) => o.value === state.settings.thinking)?.text ||
			"Off";
		$thinkingValue.textContent = thinking;
		$thinkingBtn.disabled = !canThink;
		$thinkingBtn.title = canThink
			? "Reasoning effort"
			: "This model does not support thinking";

		if (!canThink && state.settings.thinking !== "off") {
			state = updateSettings(state, { thinking: "off" });
			saveStore(state);
			$thinkingValue.textContent = "Off";
		}
	}

	function render() {
		renderSessions();
		renderMessages();
		renderControls();
		$sendBtn.disabled = !$input.value.trim();
	}

	async function pickModel() {
		const providers = sortProviders(listProviders());
		const providerId = await select(
			"Provider",
			providers.map((p) => ({
				value: p.id,
				text: p.name,
				icon: undefined,
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
				text: m.reasoning ? `${m.name}  ·  reasoning` : m.name,
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
		const model = getModel(state.settings.providerId, state.settings.modelId);
		if (!model?.reasoning) return;

		const value = await select(
			"Thinking",
			THINKING_OPTIONS.map((o) => ({ value: o.value, text: o.text })),
			{ default: state.settings.thinking, hideOnSelect: true },
		).catch(() => null);
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
		const thinkingNote =
			model?.reasoning && next.settings.thinking !== "off"
				? ` Thinking: ${next.settings.thinking}.`
				: "";
		const stub = `${STUB_REPLY}\n\nSelected: ${provider?.name || next.settings.providerId} / ${model?.name || next.settings.modelId}.${thinkingNote}`;
		next = appendAssistantMessage(next, stub);
		persist(next);
		$input.focus();
	}

	function autoGrow() {
		$input.style.height = "auto";
		$input.style.height = `${Math.min($input.scrollHeight, 132)}px`;
		$sendBtn.disabled = !$input.value.trim();
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
		$requestFocusInput();
	};
	$modelBtn.onclick = () => {
		pickModel().catch((err) => console.error(err));
	};
	$thinkingBtn.onclick = () => {
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

	function $requestFocusInput() {
		requestAnimationFrame(() => $input.focus());
	}

	actionStack.push({
		id: "agentic-chat",
		action: () => {
			$page.hide();
		},
	});

	$page.onhide = () => {
		actionStack.remove("agentic-chat-drawer");
		actionStack.remove("agentic-chat");
		closeDrawer();
	};

	render();
	app.append($page);
	$requestFocusInput();
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
 * @param {Array<{id: string, name: string}>} providers
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

/**
 * @param {number} ts
 */
function formatRelative(ts) {
	const delta = Date.now() - ts;
	const min = Math.floor(delta / 60000);
	if (min < 1) return "Just now";
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.floor(hr / 24);
	if (day < 7) return `${day}d ago`;
	return new Date(ts).toLocaleDateString();
}
