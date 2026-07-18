/**
 * Streaming LLM client.
 *
 * Two wire protocols cover almost every provider in the catalog:
 * - OpenAI-compatible chat completions (openai, openrouter, groq, xai,
 *   mistral, deepseek, google via its compat endpoint, and any provider
 *   with an `api` base url).
 * - Anthropic messages API (native, so tool use + extended thinking work).
 *
 * Messages use the OpenAI chat format, with one extension: assistant
 * messages may carry `reasoning: [{ text, signature }]` which the Anthropic
 * path replays as thinking blocks (required when thinking + tools are
 * combined) and the OpenAI path ignores.
 */

/** Base URLs for providers whose catalog entry has no `api` field. */
const SDK_BASE_URLS = {
	"@ai-sdk/openai": "https://api.openai.com/v1",
	"@ai-sdk/google": "https://generativelanguage.googleapis.com/v1beta/openai",
	"@ai-sdk/groq": "https://api.groq.com/openai/v1",
	"@ai-sdk/xai": "https://api.x.ai/v1",
	"@ai-sdk/mistral": "https://api.mistral.ai/v1",
	"@ai-sdk/cerebras": "https://api.cerebras.ai/v1",
	"@ai-sdk/deepinfra": "https://api.deepinfra.com/v1/openai",
	"@ai-sdk/togetherai": "https://api.together.xyz/v1",
	"@ai-sdk/perplexity": "https://api.perplexity.ai",
	"@ai-sdk/cohere": "https://api.cohere.ai/compatibility/v1",
};

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const THINKING_BUDGETS = { low: 3000, medium: 10000, high: 24000 };
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1500;

/**
 * @typedef {object} StreamEvent
 * @property {"text"|"reasoning"|"tool_call"|"status"} type
 * @property {string} [delta]
 * @property {string} [name]
 *
 * @typedef {object} ToolCall
 * @property {string} id
 * @property {string} name
 * @property {string} arguments - raw JSON string
 *
 * @typedef {object} StreamResult
 * @property {string} text
 * @property {Array<{text: string, signature?: string}>} reasoning
 * @property {ToolCall[]} toolCalls
 * @property {string} [stopReason]
 * @property {{input: number, output: number} | null} [usage] - real token
 *   counts reported by the provider, when available.
 */

/**
 * Whether a provider can be used with the built-in clients.
 * @param {import("./types").Provider} provider
 */
export function isProviderSupported(provider) {
	if (!provider) return false;
	if (provider.npm === "@ai-sdk/anthropic") return true;
	return !!(provider.api || SDK_BASE_URLS[provider.npm]);
}

/**
 * Stream a single model response.
 * @param {object} opts
 * @param {import("./types").Provider} opts.provider
 * @param {import("./types").Model} opts.model
 * @param {string} opts.apiKey
 * @param {"off"|"low"|"medium"|"high"} opts.thinking
 * @param {Array<object>} opts.messages - OpenAI-format chat messages
 * @param {Array<object>} opts.tools - OpenAI-format tool definitions
 * @param {AbortSignal} opts.signal
 * @param {(event: StreamEvent) => void} opts.onEvent
 * @returns {Promise<StreamResult>}
 */
export default async function streamChat(opts) {
	const run =
		opts.provider?.npm === "@ai-sdk/anthropic" ? streamAnthropic : streamOpenAI;

	let lastError;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		let emitted = false;
		const wrapped = {
			...opts,
			onEvent(event) {
				emitted = true;
				opts.onEvent(event);
			},
		};
		try {
			return await run(wrapped);
		} catch (error) {
			lastError = error;
			// Never retry after the user aborted, after content was already
			// streamed (we'd duplicate it), or on non-transient errors.
			if (opts.signal?.aborted || error?.name === "AbortError") throw error;
			if (emitted || attempt >= MAX_ATTEMPTS || !isRetryable(error)) {
				throw error;
			}
			opts.onEvent({
				type: "status",
				delta: `Connection problem, retrying (${attempt}/${MAX_ATTEMPTS - 1})…`,
			});
			await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), opts.signal);
		}
	}
	throw lastError;
}

/**
 * Transient failures worth retrying: rate limits, server errors, and
 * network drops (fetch rejects with TypeError).
 * @param {unknown} error
 */
function isRetryable(error) {
	const status = error?.status;
	if (status === 429 || (status >= 500 && status < 600)) return true;
	if (error instanceof TypeError) return true;
	return /network|failed to fetch|load failed|ERR_/i.test(
		String(error?.message || ""),
	);
}

function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new DOMException("Aborted", "AbortError"));
			return;
		}
		const id = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(id);
			reject(new DOMException("Aborted", "AbortError"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

//#region OpenAI-compatible

async function streamOpenAI(opts) {
	const { provider, model, apiKey, thinking, messages, tools, signal } = opts;
	const base = (provider.api || SDK_BASE_URLS[provider.npm] || "").replace(
		/\/+$/,
		"",
	);
	if (!base) {
		throw new Error(
			`Provider "${provider.name}" has no known API endpoint. ` +
				"Pick another provider or one with an OpenAI-compatible API.",
		);
	}

	const body = {
		model: model.id,
		messages: messages.map(toOpenAIMessage),
		stream: true,
	};
	if (tools?.length) {
		body.tools = tools;
	}
	// Ask for usage in the final stream chunk where the option is known
	// to be accepted; other providers may reject unknown fields.
	if (
		["openai", "openrouter", "groq", "deepseek", "xai", "mistral"].includes(
			provider.id,
		)
	) {
		body.stream_options = { include_usage: true };
	}
	if (model.reasoning && thinking && thinking !== "off") {
		// Only send effort params to providers known to accept them;
		// others either always reason or reject unknown fields.
		if (provider.id === "openrouter") {
			body.reasoning = { effort: thinking };
		} else if (["openai", "google", "xai", "groq"].includes(provider.id)) {
			body.reasoning_effort = thinking;
		}
	}

	const headers = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${apiKey}`,
	};
	if (provider.id === "openrouter") {
		headers["HTTP-Referer"] = "https://acode.app";
		headers["X-Title"] = "Acode";
	}

	const response = await fetch(`${base}/chat/completions`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal,
	});
	await ensureOk(response, provider);

	const result = {
		text: "",
		reasoning: [],
		toolCalls: [],
		stopReason: undefined,
		usage: null,
	};
	/** @type {Map<number, ToolCall>} */
	const pendingCalls = new Map();
	let reasoningText = "";

	await readSse(response, signal, (data) => {
		if (data === "[DONE]") return;
		const chunk = safeParse(data);
		if (chunk?.usage) {
			result.usage = {
				input: Number(chunk.usage.prompt_tokens) || 0,
				output: Number(chunk.usage.completion_tokens) || 0,
			};
		}
		const choice = chunk?.choices?.[0];
		if (!choice) return;

		const delta = choice.delta || {};
		const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
		if (typeof reasoningDelta === "string" && reasoningDelta) {
			reasoningText += reasoningDelta;
			opts.onEvent({ type: "reasoning", delta: reasoningDelta });
		}
		if (typeof delta.content === "string" && delta.content) {
			result.text += delta.content;
			opts.onEvent({ type: "text", delta: delta.content });
		}
		if (Array.isArray(delta.tool_calls)) {
			for (const tc of delta.tool_calls) {
				const index = tc.index ?? 0;
				let call = pendingCalls.get(index);
				if (!call) {
					call = { id: tc.id || `call_${index}`, name: "", arguments: "" };
					pendingCalls.set(index, call);
				}
				if (tc.id) call.id = tc.id;
				if (tc.function?.name) {
					call.name += tc.function.name;
					opts.onEvent({ type: "tool_call", name: call.name });
				}
				if (tc.function?.arguments) call.arguments += tc.function.arguments;
			}
		}
		if (choice.finish_reason) {
			result.stopReason = choice.finish_reason;
		}
	});

	if (reasoningText) result.reasoning.push({ text: reasoningText });
	result.toolCalls = [...pendingCalls.values()].filter((c) => c.name);
	return result;
}

function toOpenAIMessage(message) {
	// Strip the custom `reasoning` extension field.
	const { reasoning, ...rest } = message;
	return rest;
}

//#endregion

//#region Anthropic

async function streamAnthropic(opts) {
	const { model, apiKey, thinking, messages, tools, signal } = opts;

	const system = messages
		.filter((m) => m.role === "system")
		.map((m) => m.content)
		.join("\n\n");

	const body = {
		model: model.id,
		max_tokens: Math.min(model.limit?.output || 8192, 16000),
		stream: true,
		messages: toAnthropicMessages(messages),
	};
	if (system) body.system = system;
	if (tools?.length) {
		body.tools = tools.map((t) => ({
			name: t.function.name,
			description: t.function.description,
			input_schema: t.function.parameters,
		}));
	}
	if (model.reasoning && thinking && thinking !== "off") {
		const budget = THINKING_BUDGETS[thinking] || THINKING_BUDGETS.medium;
		body.thinking = { type: "enabled", budget_tokens: budget };
		body.max_tokens = Math.max(body.max_tokens, budget + 4000);
	}

	const response = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
			"anthropic-dangerous-direct-browser-access": "true",
		},
		body: JSON.stringify(body),
		signal,
	});
	await ensureOk(response, opts.provider);

	const result = {
		text: "",
		reasoning: [],
		toolCalls: [],
		stopReason: undefined,
		usage: null,
	};
	/** @type {Record<number, {type: string, call?: ToolCall, thinking?: {text: string, signature?: string}}>} */
	const blocks = {};

	await readSse(response, signal, (data) => {
		const event = safeParse(data);
		if (!event) return;

		switch (event.type) {
			case "message_start": {
				const usage = event.message?.usage;
				if (usage) {
					result.usage = {
						input:
							(Number(usage.input_tokens) || 0) +
							(Number(usage.cache_read_input_tokens) || 0) +
							(Number(usage.cache_creation_input_tokens) || 0),
						output: Number(usage.output_tokens) || 0,
					};
				}
				break;
			}
			case "content_block_start": {
				const block = event.content_block;
				if (block.type === "tool_use") {
					const call = { id: block.id, name: block.name, arguments: "" };
					blocks[event.index] = { type: "tool_use", call };
					opts.onEvent({ type: "tool_call", name: block.name });
				} else if (block.type === "thinking") {
					blocks[event.index] = {
						type: "thinking",
						thinking: { text: "", signature: undefined },
					};
				} else {
					blocks[event.index] = { type: block.type };
				}
				break;
			}
			case "content_block_delta": {
				const block = blocks[event.index];
				const delta = event.delta;
				if (delta.type === "text_delta") {
					result.text += delta.text;
					opts.onEvent({ type: "text", delta: delta.text });
				} else if (delta.type === "thinking_delta" && block?.thinking) {
					block.thinking.text += delta.thinking;
					opts.onEvent({ type: "reasoning", delta: delta.thinking });
				} else if (delta.type === "signature_delta" && block?.thinking) {
					block.thinking.signature =
						(block.thinking.signature || "") + delta.signature;
				} else if (delta.type === "input_json_delta" && block?.call) {
					block.call.arguments += delta.partial_json;
				}
				break;
			}
			case "message_delta":
				if (event.delta?.stop_reason) {
					result.stopReason = event.delta.stop_reason;
				}
				if (event.usage?.output_tokens != null && result.usage) {
					result.usage.output = Number(event.usage.output_tokens) || 0;
				}
				break;
			case "error":
				throw new Error(event.error?.message || "Provider stream error");
			default:
				break;
		}
	});

	for (const block of Object.values(blocks)) {
		if (block.type === "tool_use" && block.call) {
			result.toolCalls.push(block.call);
		} else if (block.type === "thinking" && block.thinking?.text) {
			result.reasoning.push(block.thinking);
		}
	}
	return result;
}

/**
 * Convert OpenAI-format history to Anthropic messages.
 * @param {Array<object>} messages
 */
function toAnthropicMessages(messages) {
	const out = [];

	const push = (role, content) => {
		const last = out[out.length - 1];
		if (last && last.role === role) {
			last.content.push(...content);
		} else {
			out.push({ role, content: [...content] });
		}
	};

	for (const message of messages) {
		if (message.role === "system") continue;

		if (message.role === "user") {
			push("user", [{ type: "text", text: String(message.content ?? "") }]);
		} else if (message.role === "assistant") {
			const content = [];
			for (const r of message.reasoning || []) {
				// Signed thinking blocks must be replayed verbatim when tools
				// are in play; unsigned reasoning (from other providers) is skipped.
				if (r.signature) {
					content.push({
						type: "thinking",
						thinking: r.text,
						signature: r.signature,
					});
				}
			}
			if (message.content) {
				content.push({ type: "text", text: String(message.content) });
			}
			for (const call of message.tool_calls || []) {
				content.push({
					type: "tool_use",
					id: call.id,
					name: call.function.name,
					input: safeParse(call.function.arguments) || {},
				});
			}
			if (content.length) push("assistant", content);
		} else if (message.role === "tool") {
			push("user", [
				{
					type: "tool_result",
					tool_use_id: message.tool_call_id,
					content: String(message.content ?? ""),
				},
			]);
		}
	}
	return out;
}

//#endregion

//#region shared helpers

async function ensureOk(response, provider) {
	if (response.ok) return;
	let detail = "";
	try {
		const text = await response.text();
		const parsed = safeParse(text);
		detail =
			parsed?.error?.message ||
			parsed?.message ||
			text.slice(0, 300) ||
			response.statusText;
	} catch {
		detail = response.statusText;
	}
	const name = provider?.name || "Provider";
	let message;
	if (response.status === 401 || response.status === 403) {
		message = `${name}: invalid or missing API key (${detail})`;
	} else if (response.status === 429) {
		message = `${name}: rate limited (${detail})`;
	} else {
		message = `${name} error ${response.status}: ${detail}`;
	}
	const error = new Error(message);
	error.status = response.status;
	throw error;
}

/**
 * Read a server-sent-events body, invoking onData for each `data:` payload.
 * @param {Response} response
 * @param {AbortSignal} signal
 * @param {(data: string) => void} onData
 */
async function readSse(response, signal, onData) {
	if (!response.body) {
		// Very old WebView without streaming fetch: fall back to full text.
		const text = await response.text();
		for (const line of text.split("\n")) {
			const data = sseData(line);
			if (data) onData(data);
		}
		return;
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
				buffer = buffer.slice(newlineIndex + 1);
				const data = sseData(line);
				if (data) onData(data);
				newlineIndex = buffer.indexOf("\n");
			}
		}
		const data = sseData(buffer.trim());
		if (data) onData(data);
	} finally {
		reader.cancel().catch(() => {});
	}
}

function sseData(line) {
	if (!line.startsWith("data:")) return null;
	return line.slice(5).trim();
}

function safeParse(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

//#endregion
