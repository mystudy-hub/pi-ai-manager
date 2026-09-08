import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface ViewTheme {
	fg(color: "accent" | "dim" | "success" | "warning" | "error", text: string): string;
	bold(text: string): string;
}

/** Measure terminal columns, including CJK, emoji and ANSI styling. */
export function cell(text: string, width: number): string {
	const size = Math.max(0, Math.floor(width));
	if (!size) return "";
	const clipped = truncateToWidth(text, size, "…");
	return clipped + " ".repeat(Math.max(0, size - visibleWidth(clipped)));
}

/** Keep a short, important suffix visible even when the name on the left is long. */
export function beside(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right);
	if (rightWidth >= width) return cell(right, width);
	return cell(left, width - rightWidth - 1) + " " + right;
}

export function wrapLines(lines: readonly string[], width: number): string[] {
	return lines.flatMap(line => wrapTextWithAnsi(line, Math.max(1, width)))
		.map(line => cell(line, width));
}

export interface ScreenSize {
	width: number;
	height: number;
	headerRows: number;
	footRows: number;
	bodyRows: number;
}

/** Reserve the footer before allocating any body rows; even a one-row screen fits. */
export function screenSize(width: number, height: number): ScreenSize {
	const w = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 80;
	const h = Number.isFinite(height) ? Math.max(1, Math.floor(height)) : 24;
	const headerRows = h >= 10 ? 2 : h >= 3 ? 1 : 0;
	const footRows = h >= 8 ? 2 : 1;
	return { width: w, height: h, headerRows, footRows, bodyRows: h - headerRows - footRows };
}

export function screen(size: ScreenSize, title: string, body: readonly string[], footer: readonly string[], theme: ViewTheme): string[] {
	const lines: string[] = [];
	if (size.headerRows) lines.push(theme.bold(cell(title, size.width)));
	if (size.headerRows === 2) lines.push(theme.fg("accent", "─".repeat(size.width)));
	for (let i = 0; i < size.bodyRows; i++) lines.push(cell(body[i] ?? "", size.width));
	// The last footer line always contains the way to apply/leave the current view.
	const shownFooter = footer.slice(-size.footRows);
	while (shownFooter.length < size.footRows) shownFooter.unshift("");
	lines.push(...shownFooter.map(line => theme.fg("dim", cell(line, size.width))));
	return lines;
}

/** A viewport that keeps the focused form field or menu item in view. */
export function focusOffset(index: number, offset: number, length: number, rows: number): number {
	const count = Math.max(1, rows);
	let next = Math.max(0, Math.min(offset, Math.max(0, length - count)));
	if (index < next) next = index;
	if (index >= next + count) next = index - count + 1;
	return Math.max(0, next);
}

/** Fit whole hints instead of clipping the last key half way through. */
export function fitHints(hints: readonly string[], width: number): string {
	let text = "";
	for (const hint of hints) {
		const next = text ? `${text}  ${hint}` : hint;
		if (visibleWidth(next) <= width) text = next;
	}
	return text;
}
