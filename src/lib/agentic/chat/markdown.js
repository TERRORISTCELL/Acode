import DOMPurify from "dompurify";
import markdownIt from "markdown-it";

const md = markdownIt({
	html: false,
	linkify: true,
	breaks: false,
});

/**
 * Render untrusted model output as sanitized HTML.
 * @param {string} text
 * @returns {string}
 */
export default function renderMarkdown(text) {
	const html = md.render(String(text ?? ""));
	return DOMPurify.sanitize(html, {
		FORBID_TAGS: ["style", "form", "input", "button"],
		ADD_ATTR: ["target"],
	});
}
