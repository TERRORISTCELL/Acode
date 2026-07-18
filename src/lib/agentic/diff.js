/**
 * Minimal line-based diff (Myers) used to show what the agent changed.
 * Produces unified-style hunks with a little context, suitable for
 * rendering in the chat's tool cards.
 */

const MAX_DIFF_LINES = 6000;
const HUNK_CONTEXT = 2;

/**
 * @typedef {object} DiffLine
 * @property {" "|"+"|"-"} type
 * @property {string} text
 *
 * @typedef {object} DiffHunk
 * @property {number} oldStart - 1-based
 * @property {number} newStart - 1-based
 * @property {DiffLine[]} lines
 *
 * @typedef {object} FileDiff
 * @property {number} added
 * @property {number} removed
 * @property {DiffHunk[]} hunks
 * @property {boolean} [tooLarge] - diff skipped, only counts are meaningful
 */

/**
 * Diff two file contents.
 * @param {string} before
 * @param {string} after
 * @returns {FileDiff}
 */
export default function diffLines(before, after) {
	const a = String(before ?? "").split("\n");
	const b = String(after ?? "").split("\n");

	// Trim common prefix/suffix so Myers only sees the changed middle.
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) {
		start++;
	}
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}

	const midA = a.slice(start, endA);
	const midB = b.slice(start, endB);

	if (midA.length + midB.length > MAX_DIFF_LINES) {
		return {
			added: midB.length,
			removed: midA.length,
			hunks: [],
			tooLarge: true,
		};
	}

	const ops = myers(midA, midB);

	/** @type {Array<DiffLine & {oldLine: number, newLine: number}>} */
	const all = [];
	let oldLine = 1;
	let newLine = 1;

	const pushEqual = (count, fromA) => {
		for (let i = 0; i < count; i++) {
			all.push({ type: " ", text: a[fromA + i], oldLine, newLine });
			oldLine++;
			newLine++;
		}
	};

	pushEqual(start, 0);
	for (const op of ops) {
		if (op.type === " ") {
			all.push({
				type: " ",
				text: midA[op.aIndex],
				oldLine,
				newLine,
			});
			oldLine++;
			newLine++;
		} else if (op.type === "-") {
			all.push({ type: "-", text: midA[op.aIndex], oldLine, newLine });
			oldLine++;
		} else {
			all.push({ type: "+", text: midB[op.bIndex], oldLine, newLine });
			newLine++;
		}
	}
	pushEqual(a.length - endA, endA);

	return buildHunks(all);
}

/**
 * Myers greedy diff over the changed middle section.
 * Returns a flat list of ops referencing indices into a/b.
 * @param {string[]} a
 * @param {string[]} b
 */
function myers(a, b) {
	const n = a.length;
	const m = b.length;
	if (!n && !m) return [];
	if (!n) return b.map((_, i) => ({ type: "+", bIndex: i }));
	if (!m) return a.map((_, i) => ({ type: "-", aIndex: i }));

	const max = n + m;
	const offset = max;
	const v = new Int32Array(2 * max + 1);
	/** @type {Int32Array[]} */
	const trace = [];

	outer: for (let d = 0; d <= max; d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x;
			if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
				x = v[offset + k + 1];
			} else {
				x = v[offset + k - 1] + 1;
			}
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) break outer;
		}
	}

	// Backtrack.
	const ops = [];
	let x = n;
	let y = m;
	for (let d = trace.length - 1; d > 0; d--) {
		const prev = trace[d];
		const k = x - y;
		let prevK;
		if (k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1])) {
			prevK = k + 1;
		} else {
			prevK = k - 1;
		}
		const prevX = prev[offset + prevK];
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			x--;
			y--;
			ops.push({ type: " ", aIndex: x, bIndex: y });
		}
		if (x === prevX) {
			y--;
			ops.push({ type: "+", bIndex: y });
		} else {
			x--;
			ops.push({ type: "-", aIndex: x });
		}
	}
	while (x > 0 && y > 0) {
		x--;
		y--;
		ops.push({ type: " ", aIndex: x, bIndex: y });
	}
	while (y > 0) {
		y--;
		ops.push({ type: "+", bIndex: y });
	}
	while (x > 0) {
		x--;
		ops.push({ type: "-", aIndex: x });
	}
	return ops.reverse();
}

/**
 * Group changed lines into hunks with HUNK_CONTEXT lines of context.
 * @param {Array<DiffLine & {oldLine: number, newLine: number}>} all
 * @returns {FileDiff}
 */
function buildHunks(all) {
	let added = 0;
	let removed = 0;
	const changedIdx = [];
	for (let i = 0; i < all.length; i++) {
		if (all[i].type === "+") {
			added++;
			changedIdx.push(i);
		} else if (all[i].type === "-") {
			removed++;
			changedIdx.push(i);
		}
	}
	if (!changedIdx.length) return { added: 0, removed: 0, hunks: [] };

	/** @type {DiffHunk[]} */
	const hunks = [];
	let hunkStart = Math.max(0, changedIdx[0] - HUNK_CONTEXT);
	let hunkEnd = Math.min(all.length - 1, changedIdx[0] + HUNK_CONTEXT);

	for (let i = 1; i < changedIdx.length; i++) {
		const idx = changedIdx[i];
		if (idx - HUNK_CONTEXT <= hunkEnd + 1) {
			hunkEnd = Math.min(all.length - 1, idx + HUNK_CONTEXT);
		} else {
			hunks.push(sliceHunk(all, hunkStart, hunkEnd));
			hunkStart = Math.max(0, idx - HUNK_CONTEXT);
			hunkEnd = Math.min(all.length - 1, idx + HUNK_CONTEXT);
		}
	}
	hunks.push(sliceHunk(all, hunkStart, hunkEnd));

	return { added, removed, hunks };
}

function sliceHunk(all, start, end) {
	const first = all[start];
	return {
		oldStart: first.oldLine,
		newStart: first.newLine,
		lines: all.slice(start, end + 1).map(({ type, text }) => ({ type, text })),
	};
}
