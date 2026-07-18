import "./view.scss";
import Page from "components/page";
import toast from "components/toast";
import alert from "dialogs/alert";
import confirm from "dialogs/confirm";
import prompt from "dialogs/prompt";
import select from "dialogs/select";
import actionStack from "lib/actionStack";
import runAgent, {
	condenseChat,
	estimateContextUsage,
} from "lib/agentic/agent";
import {
	getModel,
	getProvider,
	listModels,
	listProviders,
} from "lib/agentic/catalog";
import { isProviderSupported } from "lib/agentic/client";
import { getApiKey, hasApiKey, setApiKey } from "lib/agentic/keys";
import { revertToCheckpoint } from "lib/agentic/tools";
import openFile from "lib/openFile";
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
		<button
			type="button"
			className="agentic-chat__context"
			title="Estimated context usage. Tap to condense the chat."
		>
			<div className="agentic-chat__context-bar">
				<span className="agentic-chat__context-fill" />
			</div>
			<span className="agentic-chat__context-label" />
			<span className="icon unfold_less" aria-hidden="true" />
		</button>
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
			enterKeyHint="enter"
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
		syncAssistantEl($el, message);
		return $el;
	}

	/**
	 * Incrementally sync an assistant message into its element. Existing
	 * part nodes are updated in place so streaming doesn't wipe out
	 * expanded tool cards, reasoning panels, or scroll positions.
	 * @param {HTMLElement} $el
	 * @param {import("./store").ChatMessage} message
	 */
	function syncAssistantEl($el, message) {
		let sync = $el._sync;
		if (!sync) {
			sync = {
				records: [],
				$tail: <div className="agentic-chat__msg-tail" />,
				condensed: null,
			};
			$el.append(sync.$tail);
			$el._sync = sync;
		}

		if (message.condensed) {
			syncCondensed(sync, message);
		} else {
			syncParts($el, sync, message);
		}
		syncTail(sync, message);
	}

	/**
	 * @param {HTMLElement} $el
	 * @param {object} sync
	 * @param {import("./store").ChatMessage} message
	 */
	function syncParts($el, sync, message) {
		const parts = message.parts;
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			let record = sync.records[i];
			// Parts are mutated in place by the agent loop, so identity is
			// stable; a mismatch means the layout changed — rebuild from here.
			if (!record || record.part !== part) {
				for (const stale of sync.records.splice(i)) stale.el.remove();
				record = buildPartRecord(part);
				sync.records[i] = record;
				$el.insertBefore(record.el, sync.$tail);
			}
			updatePartRecord(record);
		}
		for (const stale of sync.records.splice(parts.length)) stale.el.remove();
	}

	/**
	 * @param {import("./store").MessagePart} part
	 */
	function buildPartRecord(part) {
		if (part.type === "text") {
			return { part, el: <div className="agentic-chat__md" />, lastText: null };
		}
		if (part.type === "reasoning") {
			const $body = <div className="agentic-chat__reasoning-body" />;
			const el = (
				<details className="agentic-chat__reasoning">
					<summary>
						<span className="icon lightbulb" aria-hidden="true" />
						Thinking
					</summary>
					{$body}
				</details>
			);
			return { part, el, $body, lastText: null };
		}
		return buildToolRecord(part);
	}

	/**
	 * @param {import("./store").MessagePart} part
	 */
	function buildToolRecord(part) {
		const $status = <span className="agentic-chat__tool-status" />;
		const $diffstat = <span className="agentic-chat__diffstat" />;
		const $body = <div className="agentic-chat__tool-body" />;
		const el = (
			<details className="agentic-chat__tool">
				<summary>
					<span className={`icon ${toolIcon(part.name)}`} aria-hidden="true" />
					<span className="agentic-chat__tool-summary">
						{part.summary || part.name}
					</span>
					{$diffstat}
					{$status}
				</summary>
				{$body}
			</details>
		);
		return {
			part,
			el,
			$status,
			$diffstat,
			$body,
			lastStatus: null,
			lastResult: null,
			bodyBuilt: false,
		};
	}

	/**
	 * @param {object} record
	 */
	function updatePartRecord(record) {
		const { part } = record;
		if (part.type === "text") {
			if (part.text !== record.lastText) {
				record.lastText = part.text;
				record.el.innerHTML = renderMarkdown(part.text || "");
			}
			return;
		}
		if (part.type === "reasoning") {
			if (part.text !== record.lastText) {
				record.lastText = part.text;
				record.$body.textContent = part.text || "";
			}
			return;
		}
		updateToolRecord(record);
	}

	/**
	 * @param {object} record
	 */
	function updateToolRecord(record) {
		const { part, el, $status, $diffstat, $body } = record;
		const running = part.status === "running";
		const statusKey = `${part.status}:${part.isError}:${!!part.reverted}`;

		if (statusKey !== record.lastStatus) {
			record.lastStatus = statusKey;
			el.classList.toggle("is-running", running);
			el.classList.toggle("is-error", !!part.isError);
			$status.textContent = part.reverted
				? "reverted"
				: running
					? "…"
					: part.isError
						? "failed"
						: "";
		}

		if (part.diff && !$diffstat.childElementCount) {
			$diffstat.append(
				<i className="add">+{part.diff.added}</i>,
				<i className="del">−{part.diff.removed}</i>,
			);
		}

		if (!running && !record.bodyBuilt) {
			record.bodyBuilt = true;
			buildToolBody(record);
		} else if (
			!running &&
			part.result !== record.lastResult &&
			record.$result
		) {
			record.$result.textContent = part.result || "";
			record.lastResult = part.result;
		}
	}

	/**
	 * Fill the expandable body of a finished tool card.
	 * @param {object} record
	 */
	function buildToolBody(record) {
		const { part, $body } = record;
		$body.innerHTML = "";

		const isEditTool = part.name === "write_file" || part.name === "edit_file";
		if (isEditTool && part.url) {
			const $open = (
				<button type="button" className="agentic-chat__tool-action">
					<span className="icon exit_to_app" aria-hidden="true" />
					Open file
				</button>
			);
			$open.onclick = () => {
				openFile(part.url, { render: true }).catch(console.error);
			};
			const $actions = (
				<div className="agentic-chat__tool-actions">{$open}</div>
			);
			if (part.checkpoint && !part.reverted) {
				const $revert = (
					<button type="button" className="agentic-chat__tool-action">
						<span className="icon undo" aria-hidden="true" />
						Revert
					</button>
				);
				$revert.onclick = async () => {
					const ok = await confirm(
						"Revert edit?",
						`Restore ${part.file || "the file"} to how it was before this edit.`,
					).catch(() => false);
					if (!ok) return;
					try {
						await revertToCheckpoint(part.url, part.checkpoint);
						part.reverted = true;
						record.lastStatus = null;
						updateToolRecord(record);
						$revert.remove();
						persistNow();
						toast("Edit reverted.");
					} catch (error) {
						toast(`Revert failed: ${error?.message || error}`);
					}
				};
				$actions.append($revert);
			}
			$body.append($actions);
		}

		if (part.diff?.hunks?.length) {
			$body.append(buildDiffEl(part.diff));
		} else if (part.diff?.tooLarge) {
			$body.append(
				<div className="agentic-chat__diff-note">
					{`Change too large to display (+${part.diff.added} −${part.diff.removed}).`}
				</div>,
			);
		}

		if (part.result && (!part.diff || part.isError)) {
			const $result = (
				<pre className="agentic-chat__tool-result">{part.result}</pre>
			);
			record.$result = $result;
			record.lastResult = part.result;
			$body.append($result);
		}
	}

	/**
	 * @param {import("lib/agentic/diff").FileDiff} diff
	 */
	function buildDiffEl(diff) {
		const $diff = <div className="agentic-chat__diff" />;
		for (const hunk of diff.hunks) {
			$diff.append(
				<div className="agentic-chat__diff-hunk">
					@@ line {hunk.newStart} @@
				</div>,
			);
			for (const line of hunk.lines) {
				const cls =
					line.type === "+" ? " add" : line.type === "-" ? " del" : "";
				$diff.append(
					<div className={`agentic-chat__diff-line${cls}`}>
						<span className="agentic-chat__diff-sign">{line.type}</span>
						{line.text}
					</div>,
				);
			}
		}
		return $diff;
	}

	/**
	 * Streaming summary card for condensed history.
	 * @param {object} sync
	 * @param {import("./store").ChatMessage} message
	 */
	function syncCondensed(sync, message) {
		const summary = partsPlainText(message.parts);
		if (!sync.condensed) {
			const $body = <div className="agentic-chat__md" />;
			const $details = (
				<details className="agentic-chat__condensed">
					<summary>
						<span className="icon unfold_less" aria-hidden="true" />
						<span className="agentic-chat__condensed-title">
							Conversation condensed
						</span>
						<span className="agentic-chat__condensed-hint">
							tap for summary
						</span>
					</summary>
					{$body}
				</details>
			);
			sync.condensed = { $body, lastText: null };
			sync.$tail.before($details);
		}
		if (summary !== sync.condensed.lastText) {
			sync.condensed.lastText = summary;
			sync.condensed.$body.innerHTML = renderMarkdown(
				summary || "_Summarizing…_",
			);
		}
	}

	/**
	 * Error banner, working dots, continue prompt, and message actions.
	 * All trailing UI lives in the message's tail element.
	 * @param {object} sync
	 * @param {import("./store").ChatMessage} message
	 */
	function syncTail(sync, message) {
		const session = getActiveSession(state);
		const isLast = session?.messages[session.messages.length - 1] === message;
		const streaming = isBusy() && isLast;
		const tailKey = [
			streaming,
			message.error || "",
			message.stopReason || "",
			isLast,
		].join("|");
		if (tailKey === sync.lastTailKey) return;
		sync.lastTailKey = tailKey;
		sync.$tail.innerHTML = "";

		if (message.error) {
			const $error = (
				<div className="agentic-chat__error">
					<span className="icon warningreport_problem" aria-hidden="true" />
					<span>{message.error}</span>
				</div>
			);
			if (isLast && !streaming) {
				const $retry = (
					<button type="button" className="agentic-chat__error-retry">
						Retry
					</button>
				);
				$retry.onclick = () => regenerate(message).catch(console.error);
				$error.append($retry);
			}
			sync.$tail.append($error);
		}

		if (streaming) {
			sync.$tail.append(
				<div className="agentic-chat__working">
					<span className="agentic-chat__dot" />
					<span className="agentic-chat__dot" />
					<span className="agentic-chat__dot" />
				</div>,
			);
			return;
		}

		if (message.stopReason === "max-steps" && isLast) {
			const $continue = (
				<button type="button" className="agentic-chat__continue">
					<span className="icon play_arrow" aria-hidden="true" />
					Continue
				</button>
			);
			$continue.onclick = () => {
				sendText("Continue from where you stopped.").catch(console.error);
			};
			sync.$tail.append(
				<div className="agentic-chat__stop-note">
					<span>Paused — step limit reached.</span>
					{$continue}
				</div>,
			);
		}

		if (message.condensed) return;

		const text = partsPlainText(message.parts);
		const $actions = <div className="agentic-chat__msg-actions" />;
		if (text) {
			const $copy = (
				<button
					type="button"
					className="agentic-chat__msg-action icon copy"
					aria-label="Copy"
				/>
			);
			$copy.onclick = () => {
				cordova?.plugins?.clipboard?.copy(text);
				toast("Copied");
			};
			$actions.append($copy);
		}
		if (isLast && !message.error) {
			const $regen = (
				<button
					type="button"
					className="agentic-chat__msg-action icon replay"
					aria-label="Regenerate"
				/>
			);
			$regen.onclick = () => regenerate(message).catch(console.error);
			$actions.append($regen);
		}
		if ($actions.childElementCount) sync.$tail.append($actions);
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
			syncAssistantEl($el, message);
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
			lastUsage: session?.lastUsage,
		});
		const approx = usage.exact ? "" : "~";
		$contextFill.style.width = `${usage.percent}%`;
		$contextFill.classList.toggle("is-warn", usage.percent >= 70);
		$contextFill.classList.toggle("is-danger", usage.percent >= 90);
		$contextLabel.textContent = `${approx}${formatTokens(usage.used)} / ${formatTokens(usage.limit)} · ${usage.percent}%`;
		$context.title = `${usage.exact ? "Context used by the last request (reported by the provider)" : "Estimated context for the next request"}\n${usage.used.toLocaleString()} / ${usage.limit.toLocaleString()} tokens. Tap to condense the chat.`;
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

	/**
	 * Ensure a usable provider/model/key. Returns them or null.
	 */
	async function ensureModelReady() {
		const provider = getProvider(state.settings.providerId);
		const model = getModel(state.settings.providerId, state.settings.modelId);
		if (!provider || !model) {
			await pickModel();
			return null;
		}
		if (!hasApiKey(provider.id)) {
			const ok = await editApiKey();
			if (!ok) return null;
		}
		return { provider, model };
	}

	/**
	 * Handle "/command" input. Returns true when handled.
	 * @param {string} text
	 */
	function handleSlashCommand(text) {
		if (!text.startsWith("/")) return false;
		const command = text.slice(1).split(/\s+/)[0].toLowerCase();

		$input.value = "";
		autoGrow();

		switch (command) {
			case "condense":
			case "compact":
				condense().catch(console.error);
				break;
			case "new":
				$newChatBtn.onclick();
				break;
			default:
				toast(`Unknown command "/${command}". Try /condense or /new.`);
				break;
		}
		return true;
	}

	async function condense() {
		if (isBusy()) return;
		const session = getActiveSession(state);
		const messages = session?.messages || [];
		const hasContent = messages.some((m) => m.parts?.length);
		if (!hasContent) {
			toast("Nothing to condense yet.");
			return;
		}

		const ready = await ensureModelReady();
		if (!ready) return;
		const { provider, model } = ready;

		const ok = await confirm(
			"Condense chat?",
			"The conversation will be replaced with a compact summary. The agent keeps working with the summary as context; old messages are removed. This cannot be undone.",
		).catch(() => false);
		if (!ok) return;

		const original = [...session.messages];
		const summaryMessage = createMessage("assistant", [
			{ type: "text", text: "" },
		]);
		summaryMessage.condensed = true;
		session.messages.push(summaryMessage);
		renderAll();

		runController = new AbortController();
		const { signal } = runController;
		updateSendButton();

		try {
			const summary = await condenseChat({
				provider,
				model,
				apiKey: getApiKey(provider.id),
				messages: original,
				signal,
				onDelta(text) {
					summaryMessage.parts[0].text = text;
					queueStreamRender(summaryMessage);
				},
			});
			summaryMessage.parts[0].text = summary;
			session.messages = [summaryMessage];
			session.lastUsage = null;
			session.updatedAt = Date.now();
			toast("Chat condensed.");
		} catch (error) {
			// Restore the original conversation on failure or stop.
			session.messages = original;
			if (error?.name !== "AbortError") {
				console.error("Condense failed:", error);
				toast(`Condense failed: ${error?.message || error}`);
			}
		} finally {
			if (runController?.signal === signal) runController = null;
			persistNow();
			renderAll();
		}
	}

	/** Exact commands the user approved for the rest of this session. */
	const approvedCommands = new Set();

	/**
	 * Approve a shell command: safe read-only commands run without asking,
	 * session-approved commands are remembered, everything else shows the
	 * full command (scrollable, never truncated) for review.
	 * @param {string} command
	 * @returns {Promise<boolean>}
	 */
	async function confirmCommand(command) {
		if (approvedCommands.has(command)) return true;
		if (isSafeReadOnlyCommand(command)) return true;

		const html = `<pre class="agentic-chat__cmd">${escapeHtml(command)}</pre>`;
		const response = await confirm("Run command?", html, true, {
			checkboxText: "Don't ask again for this command (this session)",
			returnState: true,
		}).catch(() => ({ confirmed: false, checked: false }));

		if (response.confirmed && response.checked) {
			approvedCommands.add(command);
		}
		return !!response.confirmed;
	}

	/**
	 * Run one agent turn on the session (the last message must be from
	 * the user). Appends and streams the assistant reply.
	 * @param {import("./store").ChatSession} session
	 */
	async function runTurn(session) {
		const ready = await ensureModelReady();
		if (!ready) {
			// A user message may already be queued; make sure it's visible.
			persistNow();
			renderAll();
			return;
		}
		const { provider, model } = ready;

		const assistantMessage = createMessage("assistant", []);
		const history = [...session.messages];
		session.messages.push(assistantMessage);
		session.updatedAt = Date.now();
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
					persistSoon();
				},
				onUsage(usage) {
					session.lastUsage = usage;
					renderContextMeter(
						getModel(state.settings.providerId, state.settings.modelId),
					);
				},
				onStatus(text) {
					toast(text);
				},
				confirmCommand,
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
			renderControls();
			scrollToBottom();
		}
	}

	/**
	 * Send a message programmatically (continue button, retries).
	 * @param {string} text
	 */
	async function sendText(text) {
		if (isBusy()) return;
		const session = getActiveSession(state);
		if (!session) return;
		const userMessage = createMessage("user", [{ type: "text", text }]);
		if (!session.messages.length) {
			session.title = titleFromText(text);
		}
		session.messages.push(userMessage);
		session.updatedAt = Date.now();
		await runTurn(session);
	}

	async function send() {
		if (isBusy()) return;
		const text = $input.value.trim();
		if (!text) return;
		if (handleSlashCommand(text)) return;

		// Resolve model/key dialogs before consuming the typed message so
		// cancelling doesn't eat it.
		const ready = await ensureModelReady();
		if (!ready) return;

		$input.value = "";
		autoGrow();
		await sendText(text);
	}

	/**
	 * Throw away an assistant message (and everything after it) and run
	 * the turn again.
	 * @param {import("./store").ChatMessage} message
	 */
	async function regenerate(message) {
		if (isBusy()) return;
		const session = getActiveSession(state);
		if (!session) return;
		const index = session.messages.indexOf(message);
		if (index < 0 || session.messages[index].role !== "assistant") return;
		session.messages.splice(index);
		if (!session.messages.length) return;
		persistNow();
		await runTurn(session);
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
	$context.onclick = () => condense().catch(console.error);
	$sendBtn.onclick = () => {
		if (isBusy()) {
			stopRun();
			return;
		}
		send().catch(console.error);
	};
	$input.addEventListener("input", autoGrow);
	// On phones Enter inserts a newline (multiline messages would otherwise
	// be impossible); Ctrl/Cmd+Enter sends for physical keyboards.
	$input.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
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

function escapeHtml(text) {
	return String(text)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/** Commands that only inspect state and are auto-approved. */
const SAFE_COMMANDS = new Set([
	"ls",
	"cat",
	"head",
	"tail",
	"grep",
	"egrep",
	"fgrep",
	"find",
	"pwd",
	"echo",
	"wc",
	"du",
	"df",
	"stat",
	"file",
	"which",
	"whoami",
	"uname",
	"date",
	"env",
	"printenv",
	"basename",
	"dirname",
	"realpath",
	"readlink",
	"md5sum",
	"sha1sum",
	"sha256sum",
	"sort",
	"uniq",
	"cut",
	"tr",
	"diff",
	"cmp",
	"ps",
	"id",
]);

const SAFE_GIT_SUBCOMMANDS = new Set([
	"status",
	"log",
	"diff",
	"show",
	"branch",
	"remote",
	"blame",
	"shortlog",
	"describe",
	"rev-parse",
	"ls-files",
]);

/**
 * Whether a command is read-only enough to run without confirmation.
 * Deliberately conservative: any redirection, substitution, or unknown
 * program falls through to the approval dialog.
 * @param {string} command
 */
function isSafeReadOnlyCommand(command) {
	// Redirections and substitutions can turn "safe" programs into writes.
	if (/[><`]|\$\(/.test(command)) return false;

	const segments = command.split(/&&|\|\||[|;&]/);
	for (const segment of segments) {
		const trimmed = segment.trim();
		if (!trimmed) continue;
		const [program, sub] = trimmed.split(/\s+/);
		if (program === "git") {
			if (!SAFE_GIT_SUBCOMMANDS.has(sub)) return false;
		} else if (!SAFE_COMMANDS.has(program)) {
			return false;
		}
	}
	return true;
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
