import { safeDisplay } from "./security.ts";
import { decodeKittyPrintable, isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ViewTheme } from "./tui-layout.ts";

export type TextInputAction = "typed" | "moved" | "submit" | "cancel" | "unhandled";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const MAX_INPUT = 4096;
const MAX_PASTE = 16_384;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (text: string): string[] => Array.from(segmenter.segment(text), part => part.segment);

function bounded(text: string, limit: number): string {
	let output = "";
	for (const part of graphemes(text)) {
		if (output.length + part.length > limit) break;
		output += part;
	}
	return output;
}

/** In-component input: prompts must not evict Pi's active custom component. */
export class TextInput {
	private text = "";
	private cursor = 0;
	private pasteBuffer = "";
	private isInPaste = false;
	private pasteOverflow = false;

	constructor(private readonly masked = false) {}

	get value(): string { return this.text; }
	set value(text: string) {
		this.text = bounded(safeDisplay(text), MAX_INPUT);
		this.cursor = graphemes(this.text).length;
	}

	clear(): void {
		this.text = "";
		this.cursor = 0;
		this.pasteBuffer = "";
		this.isInPaste = false;
		this.pasteOverflow = false;
	}

	private insert(text: string): void {
		const parts = graphemes(this.text);
		const before = parts.slice(0, this.cursor).join("");
		const added = bounded(safeDisplay(text), MAX_INPUT - this.text.length);
		this.text = before + added + parts.slice(this.cursor).join("");
		this.cursor = graphemes(before + added).length;
	}

	handleInput(data: string): TextInputAction {
		if (!this.isInPaste && data.includes(PASTE_START)) {
			const start = data.indexOf(PASTE_START);
			if (start) this.handleInput(data.slice(0, start));
			this.isInPaste = true;
			this.pasteOverflow = false;
			this.pasteBuffer = "";
			data = data.slice(start + PASTE_START.length);
		}
		if (this.isInPaste) {
			this.pasteBuffer += data;
			const end = this.pasteBuffer.indexOf(PASTE_END);
			if (end !== -1) {
				if (!this.pasteOverflow && end <= MAX_PASTE) this.insert(this.pasteBuffer.slice(0, end).replace(/[\r\n\t]/g, " "));
				const remaining = this.pasteBuffer.slice(end + PASTE_END.length);
				this.pasteBuffer = "";
				this.isInPaste = false;
				this.pasteOverflow = false;
				if (remaining) this.handleInput(remaining);
			} else if (this.pasteBuffer.length > MAX_PASTE) {
				// Discard the entire oversized paste, including future chunks, until its terminator.
				this.pasteOverflow = true;
				this.pasteBuffer = this.pasteBuffer.slice(-(PASTE_END.length - 1));
			}
			return "typed";
		}

		if (isKeyRelease(data)) return "unhandled";
		if (matchesKey(data, Key.enter)) return "submit";
		if (matchesKey(data, Key.escape)) return "cancel";
		if (matchesKey(data, Key.ctrl("u"))) { this.clear(); return "typed"; }
		const parts = graphemes(this.text);
		if (matchesKey(data, Key.left)) { this.cursor = Math.max(0, this.cursor - 1); return "moved"; }
		if (matchesKey(data, Key.right)) { this.cursor = Math.min(parts.length, this.cursor + 1); return "moved"; }
		if (matchesKey(data, Key.home) || matchesKey(data, Key.ctrl("a"))) { this.cursor = 0; return "moved"; }
		if (matchesKey(data, Key.end) || matchesKey(data, Key.ctrl("e"))) { this.cursor = parts.length; return "moved"; }
		if (matchesKey(data, Key.backspace)) {
			if (this.cursor > 0) parts.splice(--this.cursor, 1);
			this.text = parts.join("");
			return "typed";
		}
		if (matchesKey(data, Key.delete)) {
			parts.splice(this.cursor, 1);
			this.text = parts.join("");
			return "typed";
		}
		const printable = decodeKittyPrintable(data) ?? data;
		if (printable && safeDisplay(printable) === printable) { this.insert(printable); return "typed"; }
		return "unhandled";
	}

	/** Scroll by terminal columns while always keeping the cursor in view. */
	render(theme: ViewTheme, width: number): string {
		const size = Math.max(0, Math.floor(width));
		if (!size) return "";
		const parts = graphemes(this.text).map(part => this.masked ? "*" : part);
		let start = this.cursor;
		let used = 1; // cursor
		while (start > 0) {
			const next = visibleWidth(parts[start - 1]);
			if (used + next + (start > 1 ? 1 : 0) > size) break;
			used += next;
			start--;
		}
		const marker = start > 0 && size > 1 ? theme.fg("dim", "‹") : "";
		const before = parts.slice(start, this.cursor).join("");
		const afterWidth = Math.max(0, size - visibleWidth(marker) - visibleWidth(before) - 1);
		const after = afterWidth ? truncateToWidth(parts.slice(this.cursor).join(""), afterWidth, "…") : "";
		return marker + before + theme.fg("accent", "▏") + after;
	}
}
