/**
 * Agent tools: read/write/edit files, list directories, search the
 * workspace, and run shell commands.
 *
 * Paths given by the model are resolved against the first open folder
 * (the "workspace"). Absolute paths and full urls are used as-is. Reads
 * and writes are kept in sync with open editor tabs.
 */
import fsOperation from "fileSystem";
import { getDocText } from "cm/editorUtils";
import fileList from "lib/fileList";
import { addedFolder } from "lib/openFolder";
import Url from "utils/Url";

const MAX_READ_CHARS = 60000;
const MAX_TOOL_RESULT_CHARS = 30000;
const MAX_SEARCH_FILES = 500;
const MAX_SEARCH_MATCHES = 120;
const MAX_SEARCH_FILE_SIZE = 512 * 1024;
const COMMAND_TIMEOUT_MS = 120000;

const BINARY_EXT =
	/\.(png|jpe?g|gif|webp|bmp|ico|mp3|mp4|mkv|webm|wav|ogg|zip|gz|xz|bz2|7z|rar|jar|apk|so|dex|pdf|ttf|otf|woff2?|eot|class|bin|exe|dll|db|sqlite)$/i;

/** OpenAI-format tool definitions sent to the model. */
export const TOOL_DEFINITIONS = [
	{
		type: "function",
		function: {
			name: "read_file",
			description:
				"Read a file from the workspace. Returns the content with 1-based line numbers. Large files are truncated; use offset/limit to page through them.",
			parameters: {
				type: "object",
				properties: {
					path: {
						type: "string",
						description:
							"File path, relative to the workspace root (e.g. src/main.js).",
					},
					offset: {
						type: "integer",
						description: "1-based line number to start reading from.",
					},
					limit: {
						type: "integer",
						description: "Maximum number of lines to read.",
					},
				},
				required: ["path"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "write_file",
			description:
				"Create or overwrite a file with the given content. Missing parent directories are created. Prefer edit_file for small changes to existing files.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "File path to write." },
					content: { type: "string", description: "Full file content." },
				},
				required: ["path", "content"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "edit_file",
			description:
				"Replace an exact string in a file. old_string must match the file content exactly (including whitespace) and must be unique unless replace_all is true. Include a few surrounding lines to make it unique.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "File path to edit." },
					old_string: {
						type: "string",
						description: "Exact text to replace.",
					},
					new_string: {
						type: "string",
						description: "Replacement text.",
					},
					replace_all: {
						type: "boolean",
						description: "Replace every occurrence (default false).",
					},
				},
				required: ["path", "old_string", "new_string"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "list_dir",
			description:
				"List files and directories at a path. Use path '.' (or omit) for the workspace root.",
			parameters: {
				type: "object",
				properties: {
					path: { type: "string", description: "Directory path." },
				},
			},
		},
	},
	{
		type: "function",
		function: {
			name: "search_files",
			description:
				"Search file contents in the open workspace folders with a regular expression (like grep). Returns matching lines as path:line: text.",
			parameters: {
				type: "object",
				properties: {
					pattern: {
						type: "string",
						description: "JavaScript regular expression to search for.",
					},
					file_pattern: {
						type: "string",
						description:
							"Optional substring or extension filter for file names, e.g. '.js' or 'components'.",
					},
					case_sensitive: {
						type: "boolean",
						description: "Case sensitive search (default false).",
					},
				},
				required: ["pattern"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "find_files",
			description:
				"Find files in the open workspace folders by name. Returns matching relative paths.",
			parameters: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description: "Substring of the file name or path to look for.",
					},
				},
				required: ["query"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "run_command",
			description:
				"Run a shell command on the device (Android shell environment, busybox-like tools available). The command runs in the workspace directory when possible. Output is truncated. The user must approve each command.",
			parameters: {
				type: "object",
				properties: {
					command: { type: "string", description: "Shell command to run." },
				},
				required: ["command"],
			},
		},
	},
];

/**
 * A short human-readable summary of a tool call, for the chat UI.
 * @param {string} name
 * @param {object} args
 */
export function describeToolCall(name, args = {}) {
	switch (name) {
		case "read_file":
			return `Read ${args.path || "file"}`;
		case "write_file":
			return `Write ${args.path || "file"}`;
		case "edit_file":
			return `Edit ${args.path || "file"}`;
		case "list_dir":
			return `List ${args.path || "workspace"}`;
		case "search_files":
			return `Search "${truncate(args.pattern || "", 40)}"`;
		case "find_files":
			return `Find files "${truncate(args.query || "", 40)}"`;
		case "run_command":
			return `Run: ${truncate(args.command || "", 60)}`;
		default:
			return name;
	}
}

/**
 * @returns {Array<{url: string, name: string}>}
 */
export function getWorkspaceFolders() {
	return addedFolder.map((folder) => ({
		url: folder.url,
		name: folder.title,
	}));
}

/**
 * Execute one tool call.
 * @param {string} name
 * @param {object} args
 * @param {object} [hooks]
 * @param {(command: string) => Promise<boolean>} [hooks.confirmCommand]
 * @returns {Promise<{result: string, isError: boolean}>}
 */
export async function executeTool(name, args, hooks = {}) {
	try {
		let result;
		switch (name) {
			case "read_file":
				result = await readFileTool(args);
				break;
			case "write_file":
				result = await writeFileTool(args);
				break;
			case "edit_file":
				result = await editFileTool(args);
				break;
			case "list_dir":
				result = await listDirTool(args);
				break;
			case "search_files":
				result = await searchFilesTool(args);
				break;
			case "find_files":
				result = await findFilesTool(args);
				break;
			case "run_command":
				result = await runCommandTool(args, hooks);
				break;
			default:
				return { result: `Unknown tool: ${name}`, isError: true };
		}
		return { result: truncate(result, MAX_TOOL_RESULT_CHARS), isError: false };
	} catch (error) {
		return {
			result: `Error: ${error?.message || String(error)}`,
			isError: true,
		};
	}
}

//#region path helpers

function workspaceRoot() {
	return addedFolder[0]?.url || "";
}

/**
 * Resolve a model-supplied path to a url usable with fsOperation.
 * @param {string} inputPath
 */
export function resolvePath(inputPath) {
	let p = String(inputPath || "").trim();
	if (!p || p === ".") {
		const root = workspaceRoot();
		if (!root) throw new Error("No folder is open in the workspace.");
		return root;
	}
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return p;
	if (p.startsWith("/")) return `file://${p}`;
	if (p.startsWith("./")) p = p.slice(2);

	const root = workspaceRoot();
	if (!root) {
		throw new Error(
			`No folder is open in the workspace; cannot resolve relative path "${inputPath}". Open a folder or use an absolute path.`,
		);
	}
	return Url.join(root, p);
}

/**
 * Display path relative to the workspace root when possible.
 * @param {string} url
 */
function displayPath(url) {
	const root = workspaceRoot();
	if (root && url.startsWith(root)) {
		return url.slice(root.length).replace(/^\/+/, "") || ".";
	}
	return url;
}

/**
 * @param {string} url
 * @returns {import("lib/editorFile").default | undefined}
 */
function getOpenEditorFile(url) {
	const file = window.editorManager?.getFile?.(url, "uri");
	return file?.type === "editor" ? file : undefined;
}

/**
 * Read current content of a file, preferring an open (possibly unsaved)
 * editor buffer over the on-disk content.
 * @param {string} url
 * @returns {Promise<string>}
 */
async function readCurrentContent(url) {
	const open = getOpenEditorFile(url);
	if (open?.loaded && open.session?.doc) {
		return getDocText(open.session.doc);
	}
	return await fsOperation(url).readFile("utf-8");
}

/**
 * Write content to disk, and mirror it into an open editor tab so the
 * user sees the change immediately.
 * @param {string} url
 * @param {string} content
 */
async function writeCurrentContent(url, content) {
	const fs = fsOperation(url);
	if (await fs.exists()) {
		await fs.writeFile(content, "utf-8");
	} else {
		await createFileRecursive(url, content);
	}

	const open = getOpenEditorFile(url);
	if (open?.loaded && open.session) {
		open.markChanged = false;
		try {
			open.session.setValue(content);
			const stat = await fsOperation(url)
				.stat()
				.catch(() => null);
			open.markLoaded?.({ mtime: stat?.modifiedDate });
		} finally {
			open.markChanged = true;
		}
		await open.writeToCache?.().catch(() => {});
	}
}

async function createFileRecursive(url, content) {
	const parent = Url.dirname(url);
	const name = Url.basename(url);
	if (!parent || !name || parent === url) {
		throw new Error(`Cannot create file at "${url}"`);
	}
	if (!(await fsOperation(parent).exists())) {
		await createDirRecursive(parent);
	}
	await fsOperation(parent).createFile(name, content);
}

async function createDirRecursive(url) {
	if (await fsOperation(url).exists()) return;
	const parent = Url.dirname(url);
	const name = Url.basename(url);
	if (!parent || !name || parent === url) {
		throw new Error(`Cannot create directory "${url}"`);
	}
	await createDirRecursive(parent);
	await fsOperation(parent).createDirectory(name);
}

//#endregion

//#region tool implementations

async function readFileTool({ path, offset, limit }) {
	const url = resolvePath(path);
	const content = await readCurrentContent(url);
	const lines = content.split("\n");
	const start = Math.max(1, Number.parseInt(offset, 10) || 1);
	const count = Math.max(1, Number.parseInt(limit, 10) || lines.length);
	const slice = lines.slice(start - 1, start - 1 + count);

	let out = "";
	let chars = 0;
	let shown = 0;
	for (let i = 0; i < slice.length; i++) {
		const line = `${start + i}|${slice[i]}\n`;
		if (chars + line.length > MAX_READ_CHARS) break;
		out += line;
		chars += line.length;
		shown++;
	}

	const endLine = start + shown - 1;
	let header = `File: ${displayPath(url)} (${lines.length} lines)`;
	if (start > 1 || endLine < lines.length) {
		header += ` — showing lines ${start}-${endLine}`;
	}
	if (shown < slice.length) {
		out += `… truncated, continue with offset=${endLine + 1}\n`;
	}
	return `${header}\n${out}`;
}

async function writeFileTool({ path, content }) {
	const url = resolvePath(path);
	await writeCurrentContent(url, String(content ?? ""));
	const lines = String(content ?? "").split("\n").length;
	return `Wrote ${displayPath(url)} (${lines} lines).`;
}

async function editFileTool({ path, old_string, new_string, replace_all }) {
	const url = resolvePath(path);
	const oldStr = String(old_string ?? "");
	const newStr = String(new_string ?? "");
	if (!oldStr) throw new Error("old_string must not be empty.");
	if (oldStr === newStr) {
		throw new Error("old_string and new_string are identical.");
	}

	const content = await readCurrentContent(url);
	const occurrences = content.split(oldStr).length - 1;
	if (occurrences === 0) {
		throw new Error(
			`old_string not found in ${displayPath(url)}. Read the file again — content may have changed.`,
		);
	}
	if (occurrences > 1 && !replace_all) {
		throw new Error(
			`old_string matches ${occurrences} times in ${displayPath(url)}. Add more surrounding context to make it unique, or set replace_all.`,
		);
	}

	const updated = replace_all
		? content.split(oldStr).join(newStr)
		: content.replace(oldStr, newStr);
	await writeCurrentContent(url, updated);
	return `Edited ${displayPath(url)} (${occurrences} replacement${occurrences === 1 ? "" : "s"}).`;
}

async function listDirTool({ path } = {}) {
	const url = resolvePath(path || ".");
	const entries = await fsOperation(url).lsDir();
	if (!entries?.length) return `${displayPath(url)}: empty directory`;

	const dirs = [];
	const files = [];
	for (const entry of entries) {
		if (entry.isDirectory) dirs.push(`${entry.name}/`);
		else files.push(entry.name);
	}
	dirs.sort();
	files.sort();
	return `${displayPath(url)}:\n${[...dirs, ...files].join("\n")}`;
}

function listWorkspaceFiles() {
	// fileList keeps a scanned tree of every open workspace folder.
	const all = fileList((item) => ({ url: item.url, name: item.name }));
	return Array.isArray(all) ? all : [];
}

async function searchFilesTool({ pattern, file_pattern, case_sensitive }) {
	if (!addedFolder.length) {
		throw new Error("No folder is open in the workspace.");
	}
	let regex;
	try {
		regex = new RegExp(pattern, case_sensitive ? "" : "i");
	} catch (error) {
		throw new Error(`Invalid regular expression: ${error.message}`);
	}

	const filter = String(file_pattern || "").toLowerCase();
	const files = listWorkspaceFiles()
		.filter((f) => !BINARY_EXT.test(f.name))
		.filter((f) => !filter || f.url.toLowerCase().includes(filter))
		.slice(0, MAX_SEARCH_FILES);

	const results = [];
	let matchCount = 0;
	for (const file of files) {
		if (matchCount >= MAX_SEARCH_MATCHES) break;
		let content;
		try {
			const open = getOpenEditorFile(file.url);
			if (open?.loaded && open.session?.doc) {
				content = getDocText(open.session.doc);
			} else {
				const stat = await fsOperation(file.url)
					.stat()
					.catch(() => null);
				if (stat?.size > MAX_SEARCH_FILE_SIZE) continue;
				content = await fsOperation(file.url).readFile("utf-8");
			}
		} catch {
			continue;
		}
		if (typeof content !== "string" || content.includes("\u0000")) continue;

		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (regex.test(lines[i])) {
				results.push(
					`${displayPath(file.url)}:${i + 1}: ${truncate(lines[i].trim(), 200)}`,
				);
				matchCount++;
				if (matchCount >= MAX_SEARCH_MATCHES) break;
			}
		}
	}

	if (!results.length) return `No matches for /${pattern}/.`;
	const capped =
		matchCount >= MAX_SEARCH_MATCHES
			? `\n… stopped after ${MAX_SEARCH_MATCHES} matches`
			: "";
	return results.join("\n") + capped;
}

async function findFilesTool({ query }) {
	if (!addedFolder.length) {
		throw new Error("No folder is open in the workspace.");
	}
	const q = String(query || "").toLowerCase();
	const matches = listWorkspaceFiles()
		.map((f) => displayPath(f.url))
		.filter((p) => p.toLowerCase().includes(q))
		.slice(0, 200);
	if (!matches.length) return `No files matching "${query}".`;
	return matches.join("\n");
}

async function runCommandTool({ command }, hooks) {
	const cmd = String(command || "").trim();
	if (!cmd) throw new Error("command must not be empty.");
	if (typeof window.Executor?.execute !== "function") {
		throw new Error("Shell execution is not available on this device.");
	}

	if (hooks.confirmCommand) {
		const approved = await hooks.confirmCommand(cmd);
		if (!approved) {
			return "The user declined to run this command.";
		}
	}

	const root = workspaceRoot();
	let full = cmd;
	if (root?.startsWith("file://")) {
		const dir = root.replace(/^file:\/\//, "").replace(/'/g, "'\\''");
		full = `cd '${dir}' 2>/dev/null; ${cmd}`;
	}

	const output = await Promise.race([
		window.Executor.execute(full).catch((error) => {
			// Executor rejects with stderr/exit info; surface it as output.
			return `[command failed] ${typeof error === "string" ? error : error?.message || error}`;
		}),
		new Promise((resolve) =>
			setTimeout(
				() => resolve("[command timed out after 120s]"),
				COMMAND_TIMEOUT_MS,
			),
		),
	]);

	const text = String(output ?? "").trim();
	return text || "(no output)";
}

//#endregion

function truncate(text, max) {
	const str = String(text ?? "");
	if (str.length <= max) return str;
	return `${str.slice(0, max)}\n… [truncated ${str.length - max} chars]`;
}
