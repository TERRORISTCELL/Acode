import Checkbox from "components/checkbox";
import tile from "components/tile";
import DOMPurify from "dompurify";
import actionStack from "lib/actionStack";
import restoreTheme from "lib/restoreTheme";

/**
 * @typedef {object} SelectOptions
 * @property {boolean} [hideOnSelect]
 * @property {boolean} [textTransform]
 * @property {boolean} [search] Show a search box to filter items
 * @property {string} [searchPlaceholder]
 * @property {string} [default]
 * @property {function():void} [onCancel]
 * @property {function():void} [onHide]
 */

/**
 * @typedef {object} SelectItem
 * @property {string} [value]
 * @property {string} [text]
 * @property {string} [icon]
 * @property {boolean} [disabled]
 * @property {string} [letters]
 * @property {boolean} [checkbox]
 * @property {HTMLElement} [tailElement]
 * @property {function(Event):void} [ontailclick]
 */

/**
 * Create a select dialog
 * @param {string} title Title of the select
 * @param {string | string[] | SelectItem} items Object or [value, text, icon, disable?, letters?, checkbox?] or String
 * @param {SelectOptions | boolean} options options or rejectOnCancel
 * @returns {Promise<string>}
 */
function select(title, items, options = {}) {
	let rejectOnCancel = false;
	if (typeof options === "boolean") {
		rejectOnCancel = options;
		options = {};
	}

	return new Promise((res, rej) => {
		const {
			textTransform = false,
			hideOnSelect = true,
			search = false,
			searchPlaceholder = "Search…",
		} = options;
		let $defaultVal;

		const $mask = <span className="mask" onclick={cancel}></span>;
		const $list = tag("ul", {
			className: `scroll${!textTransform ? " no-text-transform" : ""}`,
		});
		const $titleSpan = title ? (
			<strong className="title">{title}</strong>
		) : null;
		const $searchInput = search
			? tag("input", {
					type: "search",
					className: "select-search",
					placeholder: searchPlaceholder,
					enterKeyHint: "search",
					autocapitalize: "off",
					autocomplete: "off",
					autocorrect: "off",
					spellcheck: false,
				})
			: null;
		const $empty = search
			? tag("div", {
					className: "select-empty hide",
					textContent: "No matches",
				})
			: null;
		const $select = tag("div", {
			className: `prompt select${search ? " searchable" : ""}`,
		});
		if ($titleSpan) $select.append($titleSpan);
		if ($searchInput) $select.append($searchInput);
		$select.append($list);
		if ($empty) $select.append($empty);

		const tailClickHandlers = new Map();
		/** @type {Array<{el: HTMLElement, haystack: string}>} */
		const searchable = [];

		items.map((item) => {
			let lead,
				tail = null,
				itemOptions = {
					value: null,
					text: null,
					icon: null,
					disabled: false,
					letters: "",
					checkbox: null,
					tailElement: null,
					ontailclick: null,
				};

			if (typeof item === "object") {
				if (Array.isArray(item)) {
					Object.keys(itemOptions).forEach(
						(key, i) => (itemOptions[key] = item[i]),
					);

					item.map((o, i) => {
						if (typeof o === "boolean" && i > 1) itemOptions.disabled = !o;
					});
				} else {
					itemOptions = Object.assign({}, itemOptions, item);
				}
			} else {
				itemOptions.value = item;
				itemOptions.text = item;
			}

			if (itemOptions.icon) {
				if (itemOptions.icon === "letters" && !!itemOptions.letters) {
					lead = (
						<i className="icon letters" data-letters={itemOptions.letters}></i>
					);
				} else {
					lead = <i className={`icon ${itemOptions.icon}`}></i>;
				}
			}

			if (itemOptions.tailElement) {
				tail = itemOptions.tailElement;
			} else if (itemOptions.checkbox != null) {
				tail = Checkbox({
					checked: itemOptions.checkbox,
				});
			}

			const $item = tile({
				lead,
				tail,
				text: (
					<span
						className="text"
						innerHTML={DOMPurify.sanitize(itemOptions.text)}
					></span>
				),
			});

			$item.tabIndex = "0";
			if (itemOptions.disabled) $item.classList.add("disabled");
			if (options.default === itemOptions.value) {
				$item.classList.add("selected");
				$defaultVal = $item;
			}

			$item.onclick = function (e) {
				let target = e.target;
				while (target && target !== $item) {
					if (target.hasAttribute("data-action")) {
						e.stopPropagation();
						e.preventDefault();
						return false;
					}
					target = target.parentElement;
				}

				if (itemOptions.value === undefined) return;
				if (hideOnSelect) hide();
				res(itemOptions.value);
			};

			if (itemOptions.tailElement && itemOptions.ontailclick && tail) {
				tail.style.pointerEvents = "all";

				const tailClickHandler = function (e) {
					e.stopPropagation();
					e.preventDefault();
					itemOptions.ontailclick.call($item, e);
				};

				tail.addEventListener("click", tailClickHandler);
				tailClickHandlers.set(tail, tailClickHandler);
			}

			const haystack = [
				itemOptions.text,
				itemOptions.value,
				itemOptions.letters,
			]
				.filter(Boolean)
				.join(" ")
				.replace(/<[^>]+>/g, "")
				.toLowerCase();
			searchable.push({ el: $item, haystack });

			$list.append($item);
		});

		if ($searchInput) {
			$searchInput.oninput = () => {
				const q = $searchInput.value.trim().toLowerCase();
				let visible = 0;
				for (const entry of searchable) {
					const show = !q || entry.haystack.includes(q);
					entry.el.classList.toggle("hide", !show);
					if (show) visible++;
				}
				$empty?.classList.toggle("hide", visible > 0);
			};
			$searchInput.onkeydown = (e) => {
				e.stopPropagation();
				if (e.key === "Escape") {
					e.preventDefault();
					cancel();
				}
			};
		}

		actionStack.push({
			id: "select",
			action: cancel,
		});

		app.append($select, $mask);
		if ($defaultVal) $defaultVal.scrollIntoView();

		if ($searchInput) {
			requestAnimationFrame(() => $searchInput.focus());
		} else {
			const $firstChild = $defaultVal || $list.firstChild;
			if ($firstChild?.focus) $firstChild.focus();
		}
		restoreTheme(true);

		function cancel() {
			hide();
			if (typeof options.onCancel === "function") options.onCancel();
			if (rejectOnCancel) rej();
		}

		function hideSelect() {
			$select.classList.add("hide");
			restoreTheme();
			setTimeout(() => {
				$select.remove();
				$mask.remove();
			}, 300);
		}

		function hide() {
			if (typeof options.onHide === "function") options.onHide();
			actionStack.remove("select");
			hideSelect();
			let listItems = [...$list.children];
			listItems.map((item) => (item.onclick = null));
			tailClickHandlers.forEach((handler, element) => {
				element.removeEventListener("click", handler);
			});
			tailClickHandlers.clear();
		}
	});
}

export default select;
