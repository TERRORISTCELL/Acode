import "./view.scss";
import Page from "components/page";
import alert from "dialogs/alert";
import confirm from "dialogs/confirm";
import prompt from "dialogs/prompt";
import select from "dialogs/select";
import actionStack from "lib/actionStack";
import runAgent, { estimateContextUsage } from "lib/agentic/agent";
import {
	getModel,
	getProvider,
	listModels,
	listProviders,
} from "lib/agentic/catalog";
import { isProviderSupported } from "lib/agentic/client";
import { getApiKey, hasApiKey, setApiKey } from "lib/agentic/keys";
import renderMarkdown from "./markdown";
import {
	createMessage,
	createSession,
	getActiveSession,
	getWorkspaceInfo,
	loadStore,
	saveStore,
	titleFromText,
} from "./store";

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
];

/**
 * Full-screen agent chat surface.
 * @returns {HTMLElement}
 */
export default function createAgentChatView() {
	/** @type {import("./store").ChatStoreState} */
	let state = loadStore();
	ensureValidModel(state);
	saveStore(state);

	/** @type {AbortController | null} */
	let runController = null;
	let saveTimer = null;
	let renderQueued = false;
	/** @type {Map<string, HTMLElement>} */
	const messageEls = new Map();

	//#region DOM

	const $menuBtn = (
		<span
			className="icon menu"
			attr-action="toggle-chats"
			role="button"
			tabIndex={0}
			aria-label="Chats"
		/>
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
	const $context = (
		<div className="agentic-chat__context" title="Estimated context usage">
			<div className="agentic-chat__context-bar">
				<span className="agentic-chat__context-fill" />
			</div>
			<span className="agentic-chat__context-label" />
		</div>
	);
	const $meta = <div className="agentic-chat__meta" />;
	const $modelBtn = (
		<button type="button" className="agentic-chat__meta-btn">
			<span className="agentic-chat__meta-value" />
			<span className="icon arrow_drop_down" aria-hidden="true" />
		</button>
	);
	const $thinkingBtn = (
		<button
			type="button"
			className="agentic-chat__meta-btn agentic-chat__meta-btn--thinking"
		>
			<span className="agentic-chat__meta-label">Thinking</span>
			<span className="agentic-chat__meta-value" />
		</button>
	);
	const $keyBtn = (
		<button
			type="button"
			className="agentic-chat__meta-btn agentic-chat__meta-btn--key"
			aria-label="API key"
		>
			<span className="icon vpn_key" aria-hidden="true" />
		</button>
	);
	const $inputRow = <div className="agentic-chat__input-row" />;
	const $input = (
		<textarea
			className="agentic-chat__input"
			rows={1}
			placeholder="Ask about your code…"
			enterKeyHint="send"
			aria-label="Message"
		/>
	);
	const $sendBtn = (
		<button type="button" className="agentic-chat__send" aria-label="Send">
			<span className="icon send" aria-hidden="true" />
		</button>
	);

	const $drawerTitle = <h2>Chats</h2>;
	const $workspaceLabel = <div className="agentic-chat__workspace" />;
	$drawerHead.append($drawerTitle, $newChatBtn);
	$drawer.append($drawerHead, $workspaceLabel, $sessionList);
	$meta.append($modelBtn, $thinkingBtn, $keyBtn);
	$inputRow.append($input, $sendBtn);
	$composer.append($context, $meta, $inputRow);
	$main.append($messages, $composer);
	$root.append($backdrop, $drawer, $main);
	$page.append($root);

	const $modelValue = $modelBtn.get(".agentic-chat__meta-value");
	const $thinkingValue = $thinkingBtn.get(".agentic-chat__meta-value");
	const $contextFill = $context.get(".agentic-chat__context-fill");
	const $contextLabel = $context.get(".agentic-chat__context-label");

	//#endregion

	//#region state helpers

	const isBusy = () => !!runController;

	function persistSoon() {
		if (saveTimer) return;
		saveTimer = setTimeout(() => {
			saveTimer = null;
			saveStore(state);
		}, 600);
	}

	function persistNow() {
		if (saveTimer) {
			clearTimeout(saveTimer);
			saveTimer = null;
		}
		saveStore(state);
	}

	function stopRun() {
		if (runController) {
			runController.abort();
			runController = null;
		}
		updateSendButton();
	}

	function reloadForWorkspace() {
		const next = getWorkspaceInfo();
		if (next.key === state.workspaceKey) {
			state.workspaceLabel = next.label;
			renderWorkspaceLabel();
			return;
		}
		stopRun();
		persistNow();
		state = loadStore();
		ensureValidModel(state);
		saveStore(state);
		renderAll();
		if (isDrawerOpen()) renderSessions();
	}

	function renderWorkspaceLabel() {
		const label = state.workspaceLabel || "No folder";
		$workspaceLabel.textContent =
			state.workspaceKey === "none"
				? "Not tied to a folder"
				: `Folder: ${label}`;
		$workspaceLabel.title =
			state.workspaceKey === "none"
				? "Open a folder to keep chats with that project"
				: label;
	}

	function onFolderChange() {
		reloadForWorkspace();
	}

	//#endregion

	//#region drawer

	function isDrawerOpen() {
		return $root.classList.contains("drawer-open");
	}

	function openDrawer() {
		if (isDrawerOpen()) return;
		renderSessions();
		$root.classList.add("drawer-open");
		actionStack.push({ id: "agentic-chat-drawer", action: closeDrawer });
	}

	function closeDrawer() {
		if (!isDrawerOpen()) return;
		$root.classList.remove("drawer-open");
		actionStack.remove("agentic-chat-drawer");
	}

	function renderSessions() {
		$sessionList.innerHTML = "";
		const sorted = [...state.sessions].sort(
			(a, b) => b.updatedAt - a.updatedAt,
		);

		for (const session of sorted) {
			const active = session.id === state.activeId;
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
					className="agentic-chat__session-delete icon delete"
					aria-label="Delete chat"
				/>
			);
			$open.onclick = () => {
				if (session.id !== state.activeId) {
					stopRun();
					state.activeId = session.id;
					persistNow();
					renderAll();
				}
				closeDrawer();
			};
			$del.onclick = async (e) => {
				e.stopPropagation();
				const ok = await confirm(
					"Delete chat?",
					session.title || "New chat",
				).catch(() => false);
				if (!ok) return;
				if (session.id === state.activeId) stopRun();
				state.sessions = state.sessions.filter((s) => s.id !== session.id);
				if (!state.sessions.length) {
					state.sessions.push(createSession());
				}
				if (state.activeId === session.id) {
					state.activeId = state.sessions[0].id;
				}
				persistNow();
				renderAll();
				renderSessions();
			};
			$sessionList.append(
				<li className={`agentic-chat__session${active ? " active" : ""}`}>
					{$open}
					{$del}
				</li>,
			);
		}
	}

	//#endregion

	//#region message rendering

	function renderAll() {
		messageEls.clear();
		const session = getActiveSession(state);
		$page.settitle(session?.title || "Chat");
		$messages.innerHTML = "";
		renderWorkspaceLabel();

		if (!session?.messages?.length) {
			const folderHint =
				state.workspaceKey === "none"
					? " Open a folder to keep these chats with that project."
					: ` Chats here stay with “${state.workspaceLabel}”.`;
			$messages.append(
				<div className="agentic-chat__empty">
					<span className="icon chat_bubble agentic-chat__empty-icon" />
					<strong>Agent chat</strong>
					<p>
						The agent can read, search, and edit files in your workspace, and
						run commands with your approval. Pick a model, add its API key, and
						ask away.
						{folderHint}
					</p>
				</div>,
			);
		} else {
			for (const message of session.messages) {
				const $el = buildMessageEl(message);
				messageEls.set(message.id, $el);
				$messages.append($el);
			}
		}
		renderControls();
		scrollToBottom(true);
	}

	/**
	 * @param {import("./store").ChatMessage} message
	 */
	function buildMessageEl(message) {
		if (message.role === "user") {
			return (
				<div className="agentic-chat__bubble user">
					{partsPlainText(message.parts)}
				</div>
			);
		}
		const $el = <div className="agentic-chat__assistant" />;
		fillAssistantEl($el, message);
		return $el;
	}

	/**
	 * @param {HTMLElement} $el
	 * @param {import("./store").ChatMessage} message
	 */
	function fillAssistantEl($el, message) {
		$el.innerHTML = "";

		for (const part of message.parts) {
			if (part.type === "reasoning" && part.text?.trim()) {
				const $details = (
					<details className="agentic-chat__reasoning">
						<summary>
							<span className="icon lightbulb" aria-hidden="true" />
							Thinking
						</summary>
					</details>
				);
				$details.append(
					<div className="agentic-chat__reasoning-body">{part.text}</div>,
				);
				$el.append($details);
			} else if (part.type === "text" && part.text) {
				const $text = <div className="agentic-chat__md" />;
				$text.innerHTML = renderMarkdown(part.text);
				$el.append($text);
			} else if (part.type === "tool") {
				$el.append(buildToolEl(part));
			}
		}

		if (message.error) {
			$el.append(
				<div className="agentic-chat__error">
					<span className="icon warningreport_problem" aria-hidden="true" />
					<span>{message.error}</span>
				</div>,
			);
		}

		const isStreaming =
			isBusy() &&
			message ===
				getActiveSession(state)?.messages[
					getActiveSession(state).messages.length - 1
				];
		if (isStreaming) {
			$el.append(
				<div className="agentic-chat__working">
					<span className="agentic-chat__dot" />
					<span className="agentic-chat__dot" />
					<span className="agentic-chat__dot" />
				</div>,
			);
		}
	}

	/**
	 * @param {import("./store").MessagePart} part
	 */
	function buildToolEl(part) {
		const running = part.status === "running";
		const statusClass = part.isError
			? " is-error"
			: running
				? " is-running"
				: "";
		const $details = (
			<details className={`agentic-chat__tool${statusClass}`}>
				<summary>
					<span className={`icon ${toolIcon(part.name)}`} aria-hidden="true" />
					<span className="agentic-chat__tool-summary">
						{part.summary || part.name}
					</span>
					<span className="agentic-chat__tool-status">
						{running ? "…" : part.isError ? "failed" : ""}
					</span>
				</summary>
			</details>
		);
		if (part.result) {
			$details.append(
				<pre className="agentic-chat__tool-result">{part.result}</pre>,
			);
		}
		return $details;
	}

	/**
	 * Re-render just one message element (used during streaming).
	 * @param {import("./store").ChatMessage} message
	 */
	function updateMessageEl(message) {
		// The user may have switched sessions while a run was finishing.
		if (!getActiveSession(state)?.messages.includes(message)) return;
		let $el = messageEls.get(message.id);
		if (!$el) {
			// First part of a fresh assistant message: remove the empty state
			// if present and append.
			if (!messageEls.size) $messages.innerHTML = "";
			$el = buildMessageEl(message);
			messageEls.set(message.id, $el);
			$messages.append($el);
			return;
		}
		if (message.role === "assistant") {
			fillAssistantEl($el, message);
		}
	}

	function queueStreamRender(message) {
		if (renderQueued) return;
		renderQueued = true;
		requestAnimationFrame(() => {
			renderQueued = false;
			updateMessageEl(message);
			scrollToBottom();
		});
	}

	function scrollToBottom(force = false) {
		const nearBottom =
			$messages.scrollHeight - $messages.scrollTop - $messages.clientHeight <
			140;
		if (force || nearBottom) {
			requestAnimationFrame(() => {
				$messages.scrollTop = $messages.scrollHeight;
			});
		}
	}

	//#endregion

	//#region controls

	function renderControls() {
		const provider = getProvider(state.settings.providerId);
		const model = getModel(state.settings.providerId, state.settings.modelId);
		$modelValue.textContent = model?.name || "Select model";
		$modelBtn.title = model
			? `${provider?.name || state.settings.providerId} · ${model.name}`
			: "Select model";

		const canThink = !!model?.reasoning;
		if (!canThink && state.settings.thinking !== "off") {
			state.settings.thinking = "off";
			persistSoon();
		}
		$thinkingValue.textContent =
			THINKING_OPTIONS.find((o) => o.value === state.settings.thinking)?.text ||
			"Off";
		$thinkingBtn.disabled = !canThink;
		$thinkingBtn.title = canThink
			? "Reasoning effort"
			: "This model does not support thinking";

		$keyBtn.classList.toggle("has-key", hasApiKey(state.settings.providerId));
		renderContextMeter(model);
		updateSendButton();
	}

	function renderContextMeter(model) {
		const session = getActiveSession(state);
		const usage = estimateContextUsage({
			messages: session?.messages || [],
			model,
		});
		$contextFill.style.width = `${usage.percent}%`;
		$contextFill.classList.toggle("is-warn", usage.percent >= 70);
		$contextFill.classList.toggle("is-danger", usage.percent >= 90);
		$contextLabel.textContent = `${formatTokens(usage.used)} / ${formatTokens(usage.limit)} · ${usage.percent}%`;
		$context.title = `Estimated context for the next request (system + chat + tools)\n${usage.used.toLocaleString()} / ${usage.limit.toLocaleString()} tokens`;
	}

	function updateSendButton() {
		const $icon = $sendBtn.get(".icon");
		if (isBusy()) {
			$icon.className = "icon clearclose";
			$sendBtn.setAttribute("aria-label", "Stop");
			$sendBtn.classList.add("is-stop");
			$sendBtn.disabled = false;
		} else {
			$icon.className = "icon send";
			$sendBtn.setAttribute("aria-label", "Send");
			$sendBtn.classList.remove("is-stop");
			$sendBtn.disabled = !$input.value.trim();
		}
	}

	async function pickModel() {
		const providers = sortProviders(
			listProviders().filter((p) => isProviderSupported(p)),
		);
		const providerId = await select(
			"Provider",
			providers.map((p) => ({
				value: p.id,
				text: hasApiKey(p.id) ? `${p.name}  ·  key set` : p.name,
			})),
			{
				default: state.settings.providerId,
				hideOnSelect: true,
				search: true,
				searchPlaceholder: "Search providers…",
			},
		).catch(() => null);
		if (!providerId) return;

		const models = listModels(providerId).filter(
			(m) => m.status !== "deprecated",
		);
		if (!models.length) {
			alert("No models", "This provider has no usable models.");
			return;
		}

		const modelId = await select(
			"Model",
			models.map((m) => {
				const tags = [];
				if (m.reasoning) tags.push("reasoning");
				if (m.tool_call === false) tags.push("no tools");
				return {
					value: m.id,
					text: tags.length ? `${m.name}  ·  ${tags.join(", ")}` : m.name,
				};
			}),
			{
				default:
					providerId === state.settings.providerId
						? state.settings.modelId
						: models[0].id,
				hideOnSelect: true,
				search: true,
				searchPlaceholder: "Search models…",
			},
		).catch(() => null);
		if (!modelId) return;

		const model = getModel(providerId, modelId);
		state.settings.providerId = providerId;
		state.settings.modelId = modelId;
		if (!model?.reasoning) state.settings.thinking = "off";
		persistNow();
		renderControls();

		if (!hasApiKey(providerId)) {
			await editApiKey();
		}
	}

	async function pickThinking() {
		const model = getModel(state.settings.providerId, state.settings.modelId);
		if (!model?.reasoning) return;
		const value = await select("Thinking", THINKING_OPTIONS, {
			default: state.settings.thinking,
			hideOnSelect: true,
		}).catch(() => null);
		if (!value) return;
		state.settings.thinking = value;
		persistNow();
		renderControls();
	}

	async function editApiKey() {
		const provider = getProvider(state.settings.providerId);
		if (!provider) return false;
		const current = getApiKey(provider.id);
		const value = await prompt(`${provider.name} API key`, current, "text", {
			placeholder: provider.env?.[0] || "API key",
			capitalize: false,
		});
		if (value === null || value === undefined) return hasApiKey(provider.id);
		setApiKey(provider.id, String(value).trim());
		renderControls();
		return hasApiKey(provider.id);
	}

	//#endregion

	//#region send / agent run

	async function send() {
		if (isBusy()) return;
		const text = $input.value.trim();
		if (!text) return;

		const provider = getProvider(state.settings.providerId);
		const model = getModel(state.settings.providerId, state.settings.modelId);
		if (!provider || !model) {
			await pickModel();
			return;
		}
		if (!hasApiKey(provider.id)) {
			const ok = await editApiKey();
			if (!ok) return;
		}

		const session = getActiveSession(state);
		if (!session) return;

		$input.value = "";
		autoGrow();

		const userMessage = createMessage("user", [{ type: "text", text }]);
		if (!session.messages.length) {
			session.title = titleFromText(text);
		}
		session.messages.push(userMessage);
		session.updatedAt = Date.now();

		const assistantMessage = createMessage("assistant", []);
		const history = [...session.messages];
		session.messages.push(assistantMessage);
		persistNow();
		renderAll();

		runController = new AbortController();
		const { signal } = runController;
		updateSendButton();

		try {
			await runAgent({
				provider,
				model,
				apiKey: getApiKey(provider.id),
				thinking: state.settings.thinking,
				history,
				assistantMessage,
				signal,
				onUpdate() {
					session.updatedAt = Date.now();
					queueStreamRender(assistantMessage);
					renderContextMeter(
						getModel(state.settings.providerId, state.settings.modelId),
					);
					persistSoon();
				},
				confirmCommand(command) {
					return confirm(
						"Run command?",
						command.length > 300 ? `${command.slice(0, 300)}…` : command,
					).catch(() => false);
				},
			});
		} catch (error) {
			if (error?.name !== "AbortError") {
				console.error("Agent run failed:", error);
				assistantMessage.error = error?.message || String(error);
			}
		} finally {
			if (signal.aborted && !partsPlainText(assistantMessage.parts)) {
				assistantMessage.error = "Stopped.";
			}
			if (runController?.signal === signal) runController = null;
			// Mark any tool still "running" as done so it doesn't spin forever.
			for (const part of assistantMessage.parts) {
				if (part.type === "tool" && part.status === "running") {
					part.status = "done";
					part.result = part.result || "(interrupted)";
				}
			}
			session.updatedAt = Date.now();
			persistNow();
			updateMessageEl(assistantMessage);
			updateSendButton();
			scrollToBottom();
		}
	}

	//#endregion

	//#region events

	function autoGrow() {
		$input.style.height = "auto";
		$input.style.height = `${Math.min($input.scrollHeight, 132)}px`;
		updateSendButton();
	}

	$menuBtn.onclick = () => (isDrawerOpen() ? closeDrawer() : openDrawer());
	$menuBtn.onkeydown = (e) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			$menuBtn.onclick();
		}
	};
	$backdrop.onclick = closeDrawer;
	$newChatBtn.onclick = () => {
		stopRun();
		const session = createSession();
		state.sessions.unshift(session);
		state.activeId = session.id;
		persistNow();
		renderAll();
		closeDrawer();
	};
	$modelBtn.onclick = () => pickModel().catch(console.error);
	$thinkingBtn.onclick = () => pickThinking().catch(console.error);
	$keyBtn.onclick = () => editApiKey().catch(console.error);
	$sendBtn.onclick = () => {
		if (isBusy()) {
			stopRun();
			return;
		}
		send().catch(console.error);
	};
	$input.addEventListener("input", autoGrow);
	$input.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			send().catch(console.error);
		}
	});

	actionStack.push({
		id: "agentic-chat",
		action: () => $page.hide(),
	});

	$page.onhide = () => {
		stopRun();
		persistNow();
		window.editorManager?.off?.("add-folder", onFolderChange);
		window.editorManager?.off?.("remove-folder", onFolderChange);
		actionStack.remove("agentic-chat-drawer");
		actionStack.remove("agentic-chat");
	};

	window.editorManager?.on?.("add-folder", onFolderChange);
	window.editorManager?.on?.("remove-folder", onFolderChange);

	//#endregion

	renderAll();
	app.append($page);
	return $page;
}

/**
 * Keep settings pointing at an existing model.
 * @param {import("./store").ChatStoreState} state
 */
function ensureValidModel(state) {
	const { settings } = state;
	if (getModel(settings.providerId, settings.modelId)) return;

	for (const id of PREFERRED_PROVIDERS) {
		const provider = getProvider(id);
		if (!provider || !isProviderSupported(provider)) continue;
		const models = listModels(id).filter((m) => m.status !== "deprecated");
		if (!models.length) continue;
		settings.providerId = id;
		settings.modelId = models[0].id;
		return;
	}

	const first = listProviders().find((p) => isProviderSupported(p));
	if (first) {
		settings.providerId = first.id;
		settings.modelId = Object.keys(first.models)[0];
	}
}

function partsPlainText(parts) {
	return (parts || [])
		.filter((p) => p.type === "text")
		.map((p) => p.text)
		.join("\n\n");
}

function toolIcon(name) {
	switch (name) {
		case "read_file":
			return "document-text-outline";
		case "write_file":
		case "edit_file":
			return "edit";
		case "list_dir":
			return "folder-outline";
		case "search_files":
		case "find_files":
			return "search";
		case "run_command":
			return "terminal";
		default:
			return "document-code-outline";
	}
}

function formatTokens(n) {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 10_000) return `${Math.round(n / 1000)}k`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
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
