// ---------------------------------------------------------------------------
// In-component text input
// ---------------------------------------------------------------------------

import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

export type TextInputAction = "typed" | "submit" | "cancel" | "unhandled";

/**
 * A single-line text field rendered inside the TUI component itself.
 *
 * ctx.ui.input()/select()/confirm() cannot be used while a custom component is
 * active — they evict the component from the editor container and never
 * restore it. Every prompt in the manager therefore types into one of these.
 */
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

export class TextInput {
	private text = "";
	private readonly masked: boolean;
	private pasteBuffer = "";
	private isInPaste = false;

	constructor(masked = false) {
		this.masked = masked;
	}

	get value(): string {
		return this.text;
	}

	set value(text: string) {
		this.text = text;
	}

	clear(): void {
		this.text = "";
	}

	handleInput(data: string): TextInputAction {
		// Handle bracketed paste mode (terminal wraps clipboard content)
		if (data.includes(BRACKETED_PASTE_START)) {
			this.isInPaste = true;
			this.pasteBuffer = "";
			data = data.replace(BRACKETED_PASTE_START, "");
		}
		if (this.isInPaste) {
			this.pasteBuffer += data;
			const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
			if (endIndex !== -1) {
				const pasted = this.pasteBuffer.slice(0, endIndex);
				const clean = pasted.replace(/[\r\n\t]/g, " ");
				this.text += clean;
				this.isInPaste = false;
				const remaining = this.pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length);
				this.pasteBuffer = "";
				if (remaining) this.handleInput(remaining);
			}
			return "typed";
		}

		if (matchesKey(data, Key.enter)) return "submit";
		if (matchesKey(data, Key.escape)) return "cancel";
		if (matchesKey(data, Key.backspace)) {
			this.text = this.text.slice(0, -1);
			return "typed";
		}
		// Accept printable characters (single or multi-char, excluding control codes)
		if ([...data].every(ch => {
			const code = ch.charCodeAt(0);
			return code >= 32 && code < 127;
		})) {
			this.text += data;
			return "typed";
		}
		return "unhandled";
	}

	/** The field with a trailing block cursor. */
	render(theme: any, width: number): string {
		const shown = this.masked ? "*".repeat(this.text.length) : this.text;
		const fit = Math.max(0, width - 1);
		return truncateToWidth(shown, fit) + theme.fg("accent", "▏");
	}
}
