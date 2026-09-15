/**
 * Data Maskit - Privacy Shield Engine: Session Vault & Placeholder Manager
 * Manages deterministic token issuance, multi-turn consistency, and TTL pruning.
 */

import { randomInt } from "node:crypto";

export const TOKEN_ALPHABET = "bcdfghjkmnpqrstvwxz"; // 19 consonants
export const SUFFIX_PAT = "(?:[0-9a-f]{6}|[bcdfghjkmnpqrstvwxz]{6})";
export const PLACEHOLDER_RX = new RegExp(`\\{\\{[A-Z0-9]{1,12}_${SUFFIX_PAT}\\}\\}`, "g");
export const LOOSE_PLACEHOLDER_RX = new RegExp(`\\{{0,2}([A-Z0-9]{1,12}_${SUFFIX_PAT})\\}{0,2}`, "g");
export const ESCAPED_PLACEHOLDER_RX = new RegExp(
	`(?:\\\\{0,3}\\{){1,3}(?:\\\\{0,3})([A-Za-z0-9_]{1,12})_(${SUFFIX_PAT})(?:\\\\{0,3}\\}){1,3}`,
	"gi"
);
export const PARTIAL_RX = /(?:\\{0,3}\{){1,3}[A-Za-z0-9_]{0,20}\\{0,3}\}?\\{0,3}$|\\{1,3}$/;
export const PARTIAL_MAX = 40;

const LABEL_SAFE_RX = /[^A-Z0-9]+/g;

export function safeLabel(label: string): string {
	const up = (label || "").toUpperCase().replace(LABEL_SAFE_RX, "");
	return up.slice(0, 12) || "TERM";
}

export function generateRandomSuffix(): string {
	let res = "";
	const len = TOKEN_ALPHABET.length;
	for (let i = 0; i < 6; i++) {
		res += TOKEN_ALPHABET[randomInt(len)];
	}
	return res;
}

export interface StoredEntry {
	token: string;
	original: string;
	label: string;
	ts: number;
}

export interface SessionData {
	id: string;
	fwd: Map<string, string>; // original -> token
	rev: Map<string, string>; // token -> original
	labels: Map<string, string>;
	pending: Map<string, string>; // channel -> partial string
	lastHits: Set<string>;
	restoredTokens: Set<string>;
	unresolved: number;
	degraded: number;
	ts: number;
}

export class ShieldVault {
	private readonly recentFwd = new Map<string, StoredEntry>();
	private readonly recentRev = new Map<string, StoredEntry>();
	private readonly suffixIndex = new Map<string, string>(); // suffix -> token
	private readonly sessions = new Map<string, SessionData>();
	private lastPrune = 0;

	public readonly maxRecent: number;
	public readonly ttlMs: number;

	constructor(options: { maxRecent?: number; ttlMs?: number } = {}) {
		this.maxRecent = options.maxRecent ?? 2000;
		this.ttlMs = options.ttlMs ?? 24 * 3600 * 1000; // default 24h
	}

	public getOrCreateSession(sid: string): SessionData {
		let session = this.sessions.get(sid);
		if (!session) {
			session = {
				id: sid,
				fwd: new Map(),
				rev: new Map(),
				labels: new Map(),
				pending: new Map(),
				lastHits: new Set(),
				restoredTokens: new Set(),
				unresolved: 0,
				degraded: 0,
				ts: Date.now(),
			};
			this.sessions.set(sid, session);
		} else {
			session.ts = Date.now();
		}
		return session;
	}

	public dropSession(sid: string): void {
		this.sessions.delete(sid);
	}

	public isPlaceholder(text: string): boolean {
		return new RegExp(`^\\{\\{[A-Z0-9]{1,12}_${SUFFIX_PAT}\\}\\}\$`).test(text);
	}

	/**
	 * Recalls or issues a token for the given original text.
	 * Multi-turn consistency: returns existing token if within TTL.
	 */
	public recallToken(orig: string, label: string): string {
		// Anti-looping: If original is already a placeholder, don't nest!
		if (this.isPlaceholder(orig)) {
			const existing = this.recentRev.get(orig);
			if (existing && !this.isPlaceholder(existing.original)) {
				orig = existing.original;
				label = existing.label || label;
			} else {
				return orig;
			}
		}

		const now = Date.now();
		const hit = this.recentFwd.get(orig);
		if (hit && now - hit.ts <= this.ttlMs) {
			hit.ts = now;
			const rev = this.recentRev.get(hit.token);
			if (rev) rev.ts = now;
			return hit.token;
		}

		const token = this.newToken(label);
		const entry: StoredEntry = { token, original: orig, label, ts: now };
		this.recentFwd.set(orig, entry);
		this.recentRev.set(token, entry);

		const suffix = this.extractSuffix(token);
		if (suffix) {
			this.suffixIndex.set(suffix, token);
		}

		this.prune(now);
		return token;
	}

	private newToken(label: string): string {
		const lab = safeLabel(label);
		for (let i = 0; i < 20; i++) {
			const suffix = generateRandomSuffix();
			const token = `{{${lab}_${suffix}}}`;
			if (!this.recentRev.has(token) && !this.suffixIndex.has(suffix)) {
				return token;
			}
		}
		return `{{${lab}_${generateRandomSuffix()}}}`;
	}

	public extractSuffix(token: string): string | null {
		const m = token.match(new RegExp(`_(${SUFFIX_PAT})\\}{1,3}$`));
		return m && m[1] ? m[1].toLowerCase() : null;
	}

	/**
	 * Register mapping in session and vault.
	 */
	public remember(sid: string, orig: string, label: string): string {
		const session = this.getOrCreateSession(sid);
		if (session.fwd.has(orig)) {
			session.lastHits.add(orig);
			return session.fwd.get(orig)!;
		}

		const token = this.recallToken(orig, label);
		session.fwd.set(orig, token);
		session.rev.set(token, orig);
		session.labels.set(orig, label);
		session.lastHits.add(orig);
		return token;
	}

	/**
	 * Resolve a token back to its original value.
	 * Supports multi-layer unnesting (depth < 5) and suffix rescue.
	 */
	public lookup(token: string, sid?: string): { original: string | null; viaSuffix: boolean } {
		const session = sid ? this.sessions.get(sid) : undefined;
		let hit: string | undefined = session?.rev.get(token);
		if (!hit) {
			hit = this.recentRev.get(token)?.original;
		}

		let viaSuffix = false;
		if (!hit) {
			// Suffix recovery (e.g. model changed {{IPPRIVATE_x}} to {{IP_PRIVATE_x}})
			const suffix = this.extractSuffix(token);
			if (suffix) {
				const realToken = this.suffixIndex.get(suffix);
				if (realToken) {
					hit = session?.rev.get(realToken) ?? this.recentRev.get(realToken)?.original;
					if (hit) viaSuffix = true;
				}
			}
		}

		// Prevent nested placeholder loops
		let depth = 0;
		while (hit && this.isPlaceholder(hit) && depth < 5) {
			depth++;
			const inner = session?.rev.get(hit) ?? this.recentRev.get(hit)?.original;
			if (inner && inner !== hit) {
				hit = inner;
			} else {
				break;
			}
		}

		if (hit && this.isPlaceholder(hit)) {
			return { original: null, viaSuffix: false };
		}

		if (hit && sid) {
			this.touchRecent(token, hit);
		}

		return { original: hit ?? null, viaSuffix };
	}

	public touchRecent(token: string, orig: string): void {
		const now = Date.now();
		const entry = this.recentRev.get(token);
		if (entry) {
			entry.ts = now;
			const fwd = this.recentFwd.get(orig);
			if (fwd) fwd.ts = now;
		}
	}

	public prune(now = Date.now()): void {
		// Throttle: skip full sweep if called too recently (hot-path recallToken)
		if (now - this.lastPrune < 10_000 && this.recentFwd.size <= this.maxRecent) return;
		this.lastPrune = now;

		// Prune expired
		for (const [orig, entry] of this.recentFwd.entries()) {
			if (now - entry.ts > this.ttlMs) {
				this.recentFwd.delete(orig);
				this.recentRev.delete(entry.token);
				const suffix = this.extractSuffix(entry.token);
				if (suffix) this.suffixIndex.delete(suffix);
			}
		}

		// Prune overflow
		if (this.recentFwd.size > this.maxRecent) {
			const entries = Array.from(this.recentFwd.values()).sort((a, b) => a.ts - b.ts);
			const toRemove = entries.slice(0, this.recentFwd.size - this.maxRecent);
			for (const item of toRemove) {
				this.recentFwd.delete(item.original);
				this.recentRev.delete(item.token);
				const suffix = this.extractSuffix(item.token);
				if (suffix) this.suffixIndex.delete(suffix);
			}
		}

		// Prune idle sessions
		const sessionCutoff = now - 30 * 60 * 1000; // 30 min session TTL
		for (const [sid, session] of this.sessions.entries()) {
			if (session.ts < sessionCutoff) {
				this.sessions.delete(sid);
			}
		}
	}
}
