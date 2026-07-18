/**
 * The agent loop: build context, stream a model response, execute the
 * tools it requests, feed results back, repeat until the model stops.
 *
 * The loop mutates the parts of a single assistant message (stored in the
 * chat session) and reports progress through `onUpdate`, so the UI can
 * re-render incrementally.
 */
import { getDocText } from "cm/editorUtils";
import streamChat from "./client";
import {
	describeToolCall,
	executeTool,
	getWorkspaceFolders,
	TOOL_DEFINITIONS,
} from "./tools";

const MAX_STEPS = 25;

/**
 * @typedef {import("./store").ChatMessage} ChatMessage
 * @typedef {import("./store").MessagePart} MessagePart
 */

/**
 * Build the system prompt with workspace context.
 */
function buildSystemPrompt() {
	const folders = getWorkspaceFolders();
	const lines = [
		"You are an expert coding agent inside Acode, a code editor running on an Android device.",
		"You help the user read, understand, and modify their code using the available tools.",
		"",
		"Guidelines:",
		"- Gather context before acting: read files and search before editing them.",
		"- Prefer edit_file with small, exact replacements over rewriting whole files.",
		"- After making changes, briefly summarize what you changed and why.",
		"- Keep responses concise; the user is reading on a phone screen.",
		"- Use markdown for formatting. Use code fences for code.",
		"- If a task is impossible or a tool fails repeatedly, explain the problem instead of guessing.",
		"- The shell is an Android environment (not a full Linux distro): busybox-style tools are available, but compilers or package managers may not be.",
	];

	if (folders.length) {
		lines.push("", "Open workspace folders:");
		for (const folder of folders) {
			lines.push(`- ${folder.name}: ${folder.url}`);
		}
		lines.push(
			"Relative tool paths resolve against the first workspace folder.",
		);
	} else {
		lines.push(
			"",
			"No workspace folder is open. File tools only work with absolute paths; suggest the user open a folder for project-wide work.",
		);
	}

	const active = window.editorManager?.activeFile;
	if (active?.type === "editor" && active.filename) {
		let info = `The user currently has "${active.filename}" open in the editor`;
		if (active.uri) info += ` (${active.uri})`;
		lines.push("", `${info}.`);
		try {
			if (active.loaded && active.session?.doc) {
				const text = getDocText(active.session.doc);
				if (text && text.length <= 24000) {
					lines.push("Current content of the active file:", "```", text, "```");
				} else if (text) {
					lines.push(
						`The active file is large (${text.length} chars); use read_file to view it.`,
					);
				}
			}
		} catch {
			// context is best-effort
		}
	}

	return lines.join("\n");
}

/** Keep full tool results for the last N assistant messages only. */
const KEEP_TOOL_RESULTS_FOR = 2;
const ELIDED_RESULT_MAX_CHARS = 1200;

/**
 * Convert stored part-based chat messages into OpenAI-format API messages.
 * A single assistant message may contain several model "steps" (text,
 * tool calls, tool results, more text ...); consecutive tool parts mark
 * step boundaries.
 *
 * Tool results from older turns are elided to keep the context from
 * growing without bound; the model can always re-run a tool.
 * @param {ChatMessage[]} messages
 */
export function toApiMessages(messages) {
	const out = [];

	const assistantTotal = messages.filter(
		(m) => m.role === "assistant" && !m.condensed,
	).length;
	let assistantSeen = 0;

	for (const message of messages) {
		if (message.condensed) {
			// Send summaries as user-role context: providers like Anthropic
			// require the conversation to start with a user message.
			const text = partsText(message.parts);
			if (text) {
				out.push({
					role: "user",
					content: `[Summary of the conversation so far — earlier messages were condensed]\n\n${text}`,
				});
			}
			continue;
		}
		if (message.role === "user") {
			const text = partsText(message.parts);
			if (text) out.push({ role: "user", content: text });
			continue;
		}
		if (message.role !== "assistant") continue;

		assistantSeen++;
		const elideResults =
			assistantTotal - assistantSeen >= KEEP_TOOL_RESULTS_FOR;

		let text = "";
		let reasoning = [];
		let toolParts = [];

		const flush = () => {
			if (!text && !toolParts.length) {
				reasoning = [];
				return;
			}
			const assistant = { role: "assistant", content: text || null };
			if (reasoning.length) assistant.reasoning = reasoning;
			if (toolParts.length) {
				assistant.tool_calls = toolParts.map((part) => ({
					id: part.callId,
					type: "function",
					function: {
						name: part.name,
						arguments: JSON.stringify(part.args || {}),
					},
				}));
			}
			out.push(assistant);
			for (const part of toolParts) {
				let content = part.result ?? "(no result)";
				if (elideResults && content.length > ELIDED_RESULT_MAX_CHARS) {
					content = `${content.slice(0, ELIDED_RESULT_MAX_CHARS)}\n… [older tool output elided to save context — re-run the tool if you need it]`;
				}
				out.push({
					role: "tool",
					tool_call_id: part.callId,
					content,
				});
			}
			text = "";
			reasoning = [];
			toolParts = [];
		};

		for (const part of message.parts || []) {
			if (part.type === "text") {
				if (toolParts.length) flush();
				text += (text ? "\n\n" : "") + part.text;
			} else if (part.type === "reasoning") {
				if (toolParts.length) flush();
				reasoning.push({ text: part.text, signature: part.signature });
			} else if (part.type === "tool") {
				toolParts.push(part);
			}
		}
		flush();
	}

	return out;
}

function partsText(parts) {
	return (parts || [])
		.filter((p) => p.type === "text")
		.map((p) => p.text)
		.join("\n\n");
}

/**
 * Rough character→token estimate (≈4 chars/token).
 * @param {number} chars
 */
function charsToTokens(chars) {
	return Math.ceil(Math.max(0, chars) / 4);
}

/**
 * Estimate how much of the model's context window the next request would use.
 * Includes system prompt, chat history, tool schemas, and the active file.
 *
 * @param {object} opts
 * @param {ChatMessage[]} opts.messages
 * @param {import("./types").Model} [opts.model]
 * @param {{input: number, output: number} | null} [opts.lastUsage] - real
 *   token usage reported by the provider on the last request, if any.
 * @returns {{ used: number, limit: number, percent: number, exact: boolean }}
 */
export function estimateContextUsage({ messages, model, lastUsage }) {
	const system = buildSystemPrompt();
	let chars = system.length + 3500; // tool schema overhead

	for (const message of messages || []) {
		for (const part of message.parts || []) {
			if (part.type === "text" || part.type === "reasoning") {
				chars += String(part.text || "").length;
			} else if (part.type === "tool") {
				chars += JSON.stringify(part.args || {}).length;
				chars += String(part.result || "").length;
				chars += 80;
			}
		}
	}

	let used = charsToTokens(chars);
	let exact = false;
	if (lastUsage) {
		const real = (lastUsage.input || 0) + (lastUsage.output || 0);
		if (real > 0) {
			used = real;
			exact = true;
		}
	}
	const limit = Math.max(1, Number(model?.limit?.context) || 128000);
	const percent = Math.min(100, Math.round((used / limit) * 100));
	return { used, limit, percent, exact };
}

const CONDENSE_SYSTEM =
	"You summarize coding-assistant conversations so they can continue in a smaller context window. " +
	"Write a dense, factual summary that preserves everything needed to keep working:\n" +
	"- the user's overall goal and constraints\n" +
	"- what was done so far (files read/created/edited, commands run, and their outcomes)\n" +
	"- important code details: exact file paths, function/class names, key snippets\n" +
	"- decisions made and why, plus anything explicitly rejected\n" +
	"- unresolved problems, errors, and agreed next steps\n" +
	"Write it as compact markdown. No preamble, no meta commentary about summarizing.";

const CONDENSE_REQUEST =
	"Summarize the conversation above following your instructions. This summary will replace the full history.";

/**
 * Summarize a conversation into a single markdown digest.
 * @param {object} opts
 * @param {import("./types").Provider} opts.provider
 * @param {import("./types").Model} opts.model
 * @param {string} opts.apiKey
 * @param {ChatMessage[]} opts.messages - messages to condense
 * @param {AbortSignal} opts.signal
 * @param {(text: string) => void} [opts.onDelta] - streaming callback with full text so far
 * @returns {Promise<string>} the summary text
 */
export async function condenseChat(opts) {
	const { provider, model, apiKey, messages, signal, onDelta } = opts;

	const apiMessages = [
		{ role: "system", content: CONDENSE_SYSTEM },
		...toApiMessages(messages),
		{ role: "user", content: CONDENSE_REQUEST },
	];

	let text = "";
	await streamChat({
		provider,
		model,
		apiKey,
		thinking: "off",
		messages: apiMessages,
		tools: [],
		signal,
		onEvent(event) {
			if (event.type === "text") {
				text += event.delta;
				onDelta?.(text);
			}
		},
	});

	const summary = text.trim();
	if (!summary) {
		throw new Error("The model returned an empty summary.");
	}
	return summary;
}

/**
 * Run the agent for the active session until the model finishes.
 *
 * @param {object} opts
 * @param {import("./types").Provider} opts.provider
 * @param {import("./types").Model} opts.model
 * @param {string} opts.apiKey
 * @param {"off"|"low"|"medium"|"high"} opts.thinking
 * @param {ChatMessage[]} opts.history - all session messages, the last one
 *   being the user request; the assistant reply is appended by the caller.
 * @param {ChatMessage} opts.assistantMessage - live message whose `parts`
 *   this loop fills in.
 * @param {AbortSignal} opts.signal
 * @param {() => void} opts.onUpdate - called whenever parts change.
 * @param {(command: string) => Promise<boolean>} opts.confirmCommand
 * @param {(usage: {input: number, output: number}) => void} [opts.onUsage] -
 *   reports real token usage after each model step.
 * @param {(text: string) => void} [opts.onStatus] - transient status
 *   notices (e.g. retrying after a network error).
 */
export default async function runAgent(opts) {
	const {
		provider,
		model,
		apiKey,
		thinking,
		history,
		assistantMessage,
		signal,
		onUpdate,
		confirmCommand,
		onUsage,
		onStatus,
	} = opts;

	const systemMessage = { role: "system", content: buildSystemPrompt() };
	const useTools = model.tool_call !== false;

	for (let step = 0; step < MAX_STEPS; step++) {
		if (signal.aborted) return;

		const apiMessages = [
			systemMessage,
			...toApiMessages(history),
			...toApiMessages([assistantMessage]),
		];

		/** @type {MessagePart | null} */
		let textPart = null;
		/** @type {MessagePart | null} */
		let reasoningPart = null;

		const result = await streamChat({
			provider,
			model,
			apiKey,
			thinking,
			messages: apiMessages,
			tools: useTools ? TOOL_DEFINITIONS : [],
			signal,
			onEvent(event) {
				if (event.type === "text") {
					if (!textPart) {
						textPart = { type: "text", text: "" };
						assistantMessage.parts.push(textPart);
					}
					textPart.text += event.delta;
					onUpdate();
				} else if (event.type === "reasoning") {
					if (!reasoningPart) {
						reasoningPart = { type: "reasoning", text: "" };
						assistantMessage.parts.push(reasoningPart);
					}
					reasoningPart.text += event.delta;
					onUpdate();
				} else if (event.type === "tool_call") {
					// New content after a tool call goes in fresh parts.
					textPart = null;
					reasoningPart = null;
				} else if (event.type === "status") {
					onStatus?.(event.delta);
				}
			},
		});

		// Attach thinking signatures (needed to replay Anthropic thinking).
		if (reasoningPart && result.reasoning.length) {
			const signed = result.reasoning.find((r) => r.signature);
			if (signed) reasoningPart.signature = signed.signature;
		}

		if (result.usage) onUsage?.(result.usage);

		if (!result.toolCalls.length) return;
		if (signal.aborted) return;

		for (const call of result.toolCalls) {
			if (signal.aborted) return;

			let args = {};
			let argsError = null;
			try {
				args = call.arguments ? JSON.parse(call.arguments) : {};
			} catch (error) {
				argsError = `Invalid tool arguments (not valid JSON): ${error.message}`;
			}

			/** @type {MessagePart} */
			const toolPart = {
				type: "tool",
				callId: call.id,
				name: call.name,
				args,
				summary: describeToolCall(call.name, args),
				status: "running",
				result: null,
				isError: false,
			};
			assistantMessage.parts.push(toolPart);
			onUpdate();

			let outcome;
			if (argsError) {
				outcome = { result: argsError, isError: true };
			} else {
				outcome = await executeTool(call.name, args, {
					confirmCommand,
					signal,
				});
			}

			toolPart.result = outcome.result;
			toolPart.isError = outcome.isError;
			toolPart.status = "done";
			if (outcome.meta) {
				toolPart.file = outcome.meta.file;
				toolPart.url = outcome.meta.url;
				toolPart.diff = outcome.meta.diff;
				toolPart.checkpoint = outcome.meta.checkpoint;
			}
			onUpdate();
		}
	}

	// Ran out of steps: flag it so the UI can offer to continue.
	assistantMessage.stopReason = "max-steps";
	onUpdate();
}
