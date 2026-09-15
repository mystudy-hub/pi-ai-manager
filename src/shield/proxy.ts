/**
 * Data Maskit - Privacy Shield Engine: Embedded Local Proxy Server
 * Runs a lightweight in-process HTTP server inside pi-ai-manager, routing requests
 * to target gateways with automatic masking and streaming restoration.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ShieldVault } from "./vault.ts";
import { transformRequestBody, type TransformerOptions } from "./transformer.ts";
import { restoreText, SSEStreamRestoreTransform } from "./sse.ts";

export interface UpstreamConfig {
	name: string;
	targetBaseUrl: string;
	options: TransformerOptions;
}

async function fetchWithRetry(url: string, init: RequestInit, maxRetries = 2): Promise<Response> {
	let lastErr: unknown;
	for (let i = 0; i <= maxRetries; i++) {
		try {
			const res = await fetch(url, init);
			return res;
		} catch (err: any) {
			if (err.name === "AbortError") throw err;
			lastErr = err;
			if (i < maxRetries) {
				await new Promise((r) => setTimeout(r, 200 * (i + 1)));
			}
		}
	}
	throw lastErr;
}

export class ShieldProxyServer {
	private server: Server | null = null;
	private port = 0;
	private readonly vault: ShieldVault;
	private readonly upstreams = new Map<string, UpstreamConfig>();
	private startPromise: Promise<number> | null = null;

	constructor(vault?: ShieldVault) {
		this.vault = vault ?? new ShieldVault();
	}

	public getVault(): ShieldVault {
		return this.vault;
	}

	public registerUpstream(config: UpstreamConfig): void {
		this.upstreams.set(config.name, config);
	}

	public unregisterUpstream(name: string): void {
		this.upstreams.delete(name);
	}

	public isRunning(): boolean {
		return this.server !== null && this.server.listening;
	}

	public getPort(): number {
		return this.port;
	}

	public getLocalBaseUrl(providerName: string): string {
		return `http://127.0.0.1:${this.port}/_shield/${providerName}`;
	}

	/** Wait for the proxy to be listening. Safe to call before or after start(). */
	public async waitUntilReady(): Promise<void> {
		if (this.isRunning()) return;
		if (this.startPromise) await this.startPromise;
	}

	/**
	 * Start the proxy server.
	 * Attempts preferred port first (e.g. 18701), falls back to OS-assigned port 0 if busy.
	 */
	public async start(preferredPort = 18701): Promise<number> {
		if (this.isRunning()) return this.port;

		const tryListen = (port: number): Promise<number> => {
			return new Promise((resolve, reject) => {
				const srv = createServer((req, res) => this.handleRequest(req, res));
				srv.once("error", (err: NodeJS.ErrnoException) => {
					srv.close();
					reject(err);
				});
				srv.listen(port, "127.0.0.1", () => {
					const addr = srv.address();
					const actualPort = typeof addr === "object" && addr ? addr.port : port;
					this.server = srv;
					this.port = actualPort;
					// Unref server so it doesn't hold the Node.js event loop open when idle
					srv.unref();
					resolve(actualPort);
				});
			});
		};

		this.startPromise = (async () => {
			try {
				return await tryListen(preferredPort);
			} catch (err: any) {
				if (err.code === "EADDRINUSE" || err.code === "EACCES") {
					return await tryListen(0);
				}
				this.startPromise = null;
				throw err;
			}
		})();

		return this.startPromise;
	}

	public async stop(): Promise<void> {
		if (!this.server) return;
		return new Promise((resolve, reject) => {
			this.server!.close((err) => {
				this.server = null;
				this.port = 0;
				if (err) reject(err);
				else resolve();
			});
		});
	}

	private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const reqUrl = req.url || "/";
		// Route format: /_shield/:providerName/...
		const prefixMatch = reqUrl.match(/^\/_shield\/([^/?#]+)(.*)$/);

		if (!prefixMatch) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "shield_not_found", message: "Invalid shield route" }));
			return;
		}

		const providerName = prefixMatch[1]!;
		const remainingPath = prefixMatch[2] || "/";
		const upstream = this.upstreams.get(providerName);

		if (!upstream) {
			res.writeHead(502, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "unknown_provider", message: `Provider ${providerName} not registered in shield` }));
			return;
		}

		// Compute upstream target URL
		const base = upstream.targetBaseUrl.replace(/\/+$/, "");
		const targetUrlStr = `${base}${remainingPath}`;

		// Forward headers (strip hop-by-hop headers)
		const HOP_BY_HOP = new Set([
			"host",
			"connection",
			"keep-alive",
			"proxy-authenticate",
			"proxy-authorization",
			"te",
			"trailer",
			"transfer-encoding",
			"upgrade",
			"content-length",
		]);

		const forwardHeaders: Record<string, string> = {};
		for (const [k, v] of Object.entries(req.headers)) {
			const lowerKey = (k || "").toLowerCase();
			if (!k || HOP_BY_HOP.has(lowerKey)) continue;
			if (Array.isArray(v)) {
				forwardHeaders[k] = v.join(", ");
			} else if (v !== undefined) {
				forwardHeaders[k] = String(v);
			}
		}

		// Client abort handling: listen on res close (not req close)
		const controller = new AbortController();
		const upstreamTimeout = AbortSignal.timeout(60_000); // 60s upstream timeout
		const combinedSignal = typeof (AbortSignal as any).any === "function"
			? (AbortSignal as any).any([controller.signal, upstreamTimeout])
			: controller.signal;
		res.on("close", () => {
			if (!res.writableEnded) {
				controller.abort();
			}
		});

		try {
			// 1. Read-only methods (GET, HEAD, OPTIONS): Transparent Passthrough (models discovery etc.)
			if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
				const upstreamRes = await fetchWithRetry(targetUrlStr, {
					method: req.method,
					headers: forwardHeaders,
					signal: combinedSignal,
				});

				const resHeaders: Record<string, string> = {};
				upstreamRes.headers.forEach((val, key) => {
					resHeaders[key] = val;
				});

				res.writeHead(upstreamRes.status, resHeaders);
				if (upstreamRes.body) {
					// Stream response directly to client
					const reader = upstreamRes.body.getReader();
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						res.write(value);
					}
				}
				res.end();
				return;
			}

			// 2. POST requests: read body and apply Masking
			const rawBody = await new Promise<string>((resolve, reject) => {
				const chunks: Buffer[] = [];
				req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
				req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
				req.on("error", reject);
			});

			const sid = `sess-${providerName}-${Date.now()}`;
			let maskedBody = rawBody;
			let bodyIsJson = false;

			try {
				const jsonBody = JSON.parse(rawBody);
				const transformed = transformRequestBody(jsonBody, sid, this.vault, upstream.options);
				maskedBody = JSON.stringify(transformed);
				bodyIsJson = true;
			} catch {
				// Non-JSON POST body, forward as-is with original content-type
			}

			if (bodyIsJson) {
				forwardHeaders["content-type"] = "application/json";
			}

			const upstreamRes = await fetchWithRetry(targetUrlStr, {
				method: req.method,
				headers: forwardHeaders,
				body: maskedBody,
				signal: combinedSignal,
			});

			const resHeaders: Record<string, string> = {};
			upstreamRes.headers.forEach((val, key) => {
				// Don't forward content-length or content-encoding if we are transforming SSE stream
				if (key.toLowerCase() !== "content-length") {
					resHeaders[key] = val;
				}
			});

			const contentType = (upstreamRes.headers.get("content-type") || "").toLowerCase();

			// 3. SSE Stream handling (text/event-stream)
			if (contentType.includes("text/event-stream")) {
				res.writeHead(upstreamRes.status, resHeaders);
				const sseTransformer = new SSEStreamRestoreTransform(sid, this.vault);

				sseTransformer.on("data", (chunk) => {
					res.write(chunk);
				});
				sseTransformer.on("end", () => {
					res.end();
				});

				if (upstreamRes.body) {
					const reader = upstreamRes.body.getReader();
					try {
						while (true) {
							const { done, value } = await reader.read();
							if (done) break;
							sseTransformer.write(Buffer.from(value));
						}
					} finally {
						sseTransformer.end();
					}
				} else {
					sseTransformer.end();
				}
				return;
			}

			// 4. Non-SSE JSON or text response
			const respText = await upstreamRes.text();
			let restoredText = respText;
			try {
				restoredText = restoreText(respText, sid, this.vault, "rest_response", false, true);
			} catch {
				restoredText = respText;
			}

			resHeaders["content-length"] = String(Buffer.byteLength(restoredText, "utf-8"));
			res.writeHead(upstreamRes.status, resHeaders);
			res.end(restoredText);
		} catch (error: any) {
			if (error.name === "AbortError") return;
			if (!res.headersSent) {
				res.writeHead(502, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "shield_proxy_error", message: error.message || String(error) }));
			}
		}
	}
}

// Global singleton instance for pi-ai-manager
let globalProxyInstance: ShieldProxyServer | undefined;

export function getGlobalShieldProxy(): ShieldProxyServer {
	if (!globalProxyInstance) {
		globalProxyInstance = new ShieldProxyServer();
	}
	return globalProxyInstance;
}
