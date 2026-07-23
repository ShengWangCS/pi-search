import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");

interface Config {
	exaApiKey?: unknown;
}

function loadConfig(): Config {
	if (!existsSync(CONFIG_PATH)) return {};
	const raw = readFileSync(CONFIG_PATH, "utf-8");
	try {
		return JSON.parse(raw) as Config;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
}

function getExaApiKey(): string | null {
	const env = process.env.EXA_API_KEY;
	if (typeof env === "string" && env.trim().length > 0) return env.trim();
	const cfg = loadConfig();
	if (typeof cfg.exaApiKey === "string" && cfg.exaApiKey.trim().length > 0) return cfg.exaApiKey.trim();
	return null;
}

// ─── Storage ──────────────────────────────────────────────────────────────────

interface StoredSearch {
	id: string;
	type: "search" | "fetch";
	timestamp: number;
	queries?: { query: string; answer: string; results: { title: string; url: string }[]; error: string | null }[];
	urls?: { url: string; title: string; content: string; error: string | null }[];
}

const stored = new Map<string, StoredSearch>();
const MAX_STORED = 50;

function rememberStored(entry: StoredSearch): void {
	stored.set(entry.id, entry);
	while (stored.size > MAX_STORED) {
		const oldest = stored.keys().next().value;
		if (oldest === undefined) break;
		stored.delete(oldest);
	}
}

function genId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// `stored` only lives as long as this pi process does. But responseIds handed
// back to the model in tool output ("Use get_search_content({responseId...})")
// get written into the session's on-disk JSONL, which outlives the process --
// pi is a single long-lived subprocess that switches between many on-disk
// sessions over its lifetime, and can itself restart. Without this fallback,
// resuming an older session (or just outliving a restart) turns every prior
// responseId into a dead reference, even though appendEntry genuinely did
// persist the data. appendEntry's doc comment describes exactly this pattern:
// "On reload, extensions can scan entries for their customType and
// reconstruct internal state." Falls back to that scan on a cache miss,
// rather than eagerly replaying all entries on load (a session can accumulate
// a lot of these, and most are never looked up again).
function findStored(responseId: string, ctx: ExtensionContext): StoredSearch | undefined {
	const hit = stored.get(responseId);
	if (hit) return hit;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== "web-search-results") continue;
		const data = entry.data as StoredSearch | undefined;
		if (data?.id === responseId) {
			stored.set(responseId, data); // write-through so repeat lookups skip the scan
			return data;
		}
	}
	return undefined;
}

// ─── Exa search ───────────────────────────────────────────────────────────────

const EXA_ANSWER_URL = "https://api.exa.ai/answer";
const EXA_SEARCH_URL = "https://api.exa.ai/search";
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const REQUEST_TIMEOUT_MS = 60000;

function reqSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

interface ExaSearchResult {
	answer: string;
	results: { title: string; url: string; snippet: string }[];
}

function recencyStartDate(filter: string): string {
	const now = new Date();
	const offsets: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };
	const days = offsets[filter] ?? 0;
	return new Date(now.getTime() - days * 86400000).toISOString();
}

function parseDomainFilter(domains: string[] | undefined): { includeDomains?: string[]; excludeDomains?: string[] } {
	if (!domains?.length) return {};
	const inc = domains.filter(d => !d.startsWith("-")).map(d => d.trim()).filter(Boolean);
	const exc = domains.filter(d => d.startsWith("-")).map(d => d.slice(1).trim()).filter(Boolean);
	return { ...(inc.length ? { includeDomains: inc } : {}), ...(exc.length ? { excludeDomains: exc } : {}) };
}

async function searchViaExaApi(
	query: string,
	apiKey: string,
	numResults: number,
	recencyFilter?: string,
	domainFilter?: string[],
	signal?: AbortSignal,
): Promise<ExaSearchResult> {
	const useSearch = !!recencyFilter || !!domainFilter?.length || numResults !== 5;
	const sig = reqSignal(signal);

	if (!useSearch) {
		const res = await fetch(EXA_ANSWER_URL, {
			method: "POST",
			headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
			body: JSON.stringify({ query, text: true }),
			signal: sig,
		});
		if (!res.ok) throw new Error(`Exa API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
		const data = (await res.json()) as { answer?: string; citations?: Array<{ url?: string; title?: string }> };
		return {
			answer: data.answer || "",
			results: (data.citations || []).filter(c => c.url).map((c, i) => ({
				title: c.title || `Source ${i + 1}`,
				url: c.url!,
				snippet: "",
			})),
		};
	}

	const startDate = recencyFilter ? recencyStartDate(recencyFilter) : null;
	const domain = parseDomainFilter(domainFilter);
	const res = await fetch(EXA_SEARCH_URL, {
		method: "POST",
		headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
		body: JSON.stringify({
			query,
			type: "auto",
			numResults,
			...(startDate ? { startPublishedDate: startDate } : {}),
			...domain,
			contents: { text: { maxCharacters: 3000 }, highlights: true },
		}),
		signal: sig,
	});
	if (!res.ok) throw new Error(`Exa API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
	const data = (await res.json()) as {
		results?: Array<{ title?: string; url?: string; highlights?: string[] }>;
	};
	return {
		answer: "",
		results: (data.results || []).filter(r => r.url).map(r => {
			const highlights = Array.isArray(r.highlights) ? r.highlights.filter(Boolean).join(" ") : "";
			return { title: r.title || "", url: r.url!, snippet: highlights.slice(0, 500) };
		}),
	};
}

async function searchViaExaMcp(
	query: string,
	numResults: number,
	recencyFilter?: string,
	domainFilter?: string[],
	signal?: AbortSignal,
): Promise<ExaSearchResult> {
	const parts = [query];
	if (domainFilter?.length) {
		for (const d of domainFilter) {
			parts.push(d.startsWith("-") ? `-site:${d.slice(1)}` : `site:${d}`);
		}
	}
	if (recencyFilter) {
		const now = new Date();
		switch (recencyFilter) {
			case "day": parts.push("past 24 hours"); break;
			case "week": parts.push("past week"); break;
			case "month": parts.push(`${now.toLocaleString("en", { month: "long" })} ${now.getFullYear()}`); break;
			case "year": parts.push(String(now.getFullYear())); break;
		}
	}
	const enriched = parts.join(" ");
	const sig = reqSignal(signal);

	const res = await fetch(EXA_MCP_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "web_search_exa", arguments: { query: enriched, numResults, livecrawl: "fallback", type: "auto", contextMaxCharacters: 3000 } },
		}),
		signal: sig,
	});
	if (!res.ok) throw new Error(`Exa MCP error ${res.status}: ${(await res.text()).slice(0, 300)}`);

	const body = await res.text();
	const dataLines = body.split("\n").filter(l => l.startsWith("data:"));
	let result: { result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean }; error?: { message?: string } } | null = null;
	for (const line of dataLines) {
		const payload = line.slice(5).trim();
		if (!payload) continue;
		try {
			const parsed = JSON.parse(payload);
			if (parsed?.result || parsed?.error) { result = parsed; break; }
		} catch { /* skip */ }
	}
	if (!result) {
		try { result = JSON.parse(body); } catch { /* skip */ }
	}
	if (!result) throw new Error("Exa MCP returned empty response");
	if (result.error) throw new Error(result.error.message || "Exa MCP error");
	if (result.result?.isError) {
		const msg = result.result.content?.find(c => c.type === "text")?.text;
		throw new Error(msg || "Exa MCP error");
	}
	const text = result.result?.content?.find(c => c.type === "text" && typeof c.text === "string")?.text || "";
	if (!text) throw new Error("Exa MCP returned empty content");

	const results: { title: string; url: string; snippet: string }[] = [];
	let currentTitle = "", currentUrl = "", currentSnippet = "";
	for (const line of text.split("\n")) {
		const titleMatch = line.match(/^Title: (.+)/);
		const urlMatch = line.match(/^URL: (.+)/);
		if (titleMatch) {
			if (currentUrl) results.push({ title: currentTitle, url: currentUrl, snippet: currentSnippet.slice(0, 500) });
			currentTitle = titleMatch[1].trim();
			currentUrl = "";
			currentSnippet = "";
		} else if (urlMatch) {
			currentUrl = urlMatch[1].trim();
		} else if (currentUrl && line.trim()) {
			currentSnippet += (currentSnippet ? " " : "") + line.trim();
		}
	}
	if (currentUrl) results.push({ title: currentTitle, url: currentUrl, snippet: currentSnippet.slice(0, 500) });

	const answer = results.map(r => {
		const s = r.snippet.replace(/\s+/g, " ").trim().slice(0, 500);
		return s ? `${s}\nSource: ${r.title} (${r.url})` : null;
	}).filter(Boolean).join("\n\n");

	return { answer, results };
}

async function searchExa(
	query: string,
	numResults: number,
	recencyFilter?: string,
	domainFilter?: string[],
	signal?: AbortSignal,
): Promise<ExaSearchResult> {
	const apiKey = getExaApiKey();
	if (apiKey) {
		return searchViaExaApi(query, apiKey, numResults, recencyFilter, domainFilter, signal);
	}
	return searchViaExaMcp(query, numResults, recencyFilter, domainFilter, signal);
}

// ─── URL fetch ────────────────────────────────────────────────────────────────

const HTTP_TIMEOUT_MS = 30000;
const MIN_USEFUL_CONTENT = 500;

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

interface FetchResult {
	url: string;
	title: string;
	content: string;
	error: string | null;
}

async function fetchUrl(url: string, signal?: AbortSignal): Promise<FetchResult> {
	try {
		new URL(url);
	} catch {
		return { url, title: "", content: "", error: "Invalid URL" };
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort);

	try {
		const res = await fetch(url, {
			signal: controller.signal,
			headers: {
				"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
				"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.9",
			},
		});

		if (!res.ok) {
			return { url, title: "", content: "", error: `HTTP ${res.status}: ${res.statusText}` };
		}

		const contentType = res.headers.get("content-type") || "";

		// Binary / unsupported types
		if (contentType.includes("application/octet-stream") ||
			contentType.includes("image/") ||
			contentType.includes("audio/") ||
			contentType.includes("video/") ||
			contentType.includes("application/zip")) {
			return { url, title: "", content: "", error: `Unsupported content type: ${contentType.split(";")[0]}` };
		}

		const text = await res.text();
		const isHTML = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");

		if (!isHTML) {
			const title = extractTitle(text) || new URL(url).pathname.split("/").pop() || url;
			return { url, title, content: text, error: null };
		}

		const { document } = parseHTML(text);
		const reader = new Readability(document as unknown as Document);
		const article = reader.parse();

		if (!article || (turndown.turndown(article.content).length < MIN_USEFUL_CONTENT)) {
			return { url, title: article?.title || "", content: article ? turndown.turndown(article.content) : "", error: "Could not extract readable content" };
		}

		return {
			url,
			title: article.title || "",
			content: turndown.turndown(article.content),
			error: null,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.toLowerCase().includes("abort")) {
			return { url, title: "", content: "", error: "Aborted" };
		}
		return { url, title: "", content: "", error: msg };
	} finally {
		clearTimeout(timeoutId);
		signal?.removeEventListener("abort", onAbort);
	}
}

function extractTitle(text: string): string | null {
	const m = text.match(/^#{1,2}\s+(.+)/m);
	return m ? m[1].replace(/\*+/g, "").trim() : null;
}

// ─── Extension ────────────────────────────────────────────────────────────────

const webSearchSchema = Type.Object({
	query: Type.Optional(Type.String({ description: "Single search query." })),
	queries: Type.Optional(Type.Array(Type.String(), {
		description: "Multiple queries searched in sequence, each returning its own synthesized answer. Prefer this for research — vary phrasing, scope, and angle across 2-4 queries.",
	})),
	numResults: Type.Optional(Type.Number({ description: "Results per query (default: 5, max: 20)" })),
	recencyFilter: Type.Optional(Type.Union([
		Type.Literal("day"),
		Type.Literal("week"),
		Type.Literal("month"),
		Type.Literal("year"),
	], { description: "Filter by recency" })),
	domainFilter: Type.Optional(Type.Array(Type.String(), {
		description: "Limit to domains (prefix with - to exclude)",
	})),
});

interface WebSearchDetails {
	error?: string;
	queries?: string[];
	queryCount?: number;
	totalResults?: number;
	searchId?: string;
}

const fetchContentSchema = Type.Object({
	url: Type.Optional(Type.String({ description: "Single URL to fetch" })),
	urls: Type.Optional(Type.Array(Type.String(), { description: "Multiple URLs (parallel)" })),
});

interface FetchContentDetails {
	error?: string;
	url?: string;
	title?: string;
	totalChars?: number;
	responseId?: string;
	truncated?: boolean;
	urlCount?: number;
	successful?: number;
}

const getSearchContentSchema = Type.Object({
	responseId: Type.String({ description: "The responseId from web_search or fetch_content" }),
	query: Type.Optional(Type.String({ description: "Get content for this query (web_search)" })),
	queryIndex: Type.Optional(Type.Number({ description: "Get content for query at index" })),
	url: Type.Optional(Type.String({ description: "Get content for this URL" })),
	urlIndex: Type.Optional(Type.Number({ description: "Get content for URL at index" })),
});

interface GetSearchContentDetails {
	error?: string;
	query?: string;
	resultCount?: number;
	url?: string;
	title?: string;
	contentLength?: number;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool<typeof webSearchSchema, WebSearchDetails>({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web using Exa. Returns a synthesized answer with source citations. For comprehensive research, prefer queries (plural) with 2-4 varied angles over a single query — varying phrasing gives broader coverage.",
		promptSnippet:
			"Use for web research questions. Prefer {queries:[...]} with 2-4 varied angles over a single query for broader coverage.",

		parameters: webSearchSchema,

		async execute(_toolCallId, params, signal) {
			const rawQueries: unknown[] = Array.isArray(params.queries)
				? params.queries
				: (params.query !== undefined ? [params.query] : []);
			const queries = rawQueries
				.filter((q): q is string => typeof q === "string")
				.map(q => q.trim())
				.filter(Boolean);

			if (queries.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No query provided." }],
					details: { error: "No query provided" },
				};
			}

			const numResults = Math.min(params.numResults ?? 5, 20);
			const perQuery: NonNullable<StoredSearch["queries"]> = [];

			for (let i = 0; i < queries.length; i++) {
				if (signal?.aborted) break;
				try {
					const result = await searchExa(queries[i], numResults, params.recencyFilter, params.domainFilter, signal);
					perQuery.push({
						query: queries[i],
						answer: result.answer,
						results: result.results.map(r => ({ title: r.title, url: r.url })),
						error: null,
					});
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					if (msg.toLowerCase().includes("abort")) break;
					perQuery.push({ query: queries[i], answer: "", results: [], error: msg });
				}
			}

			// Store results for retrieval
			const id = genId();
			const entry: StoredSearch = {
				id,
				type: "search",
				timestamp: Date.now(),
				queries: perQuery,
			};
			rememberStored(entry);
			pi.appendEntry("web-search-results", entry);

			// Build output
			const answerBlocks = perQuery.map(q => {
				if (q.error) return `Error searching "${q.query}": ${q.error}`;
				return q.answer;
			}).filter(Boolean);
			const allResults = perQuery.flatMap(q => q.results);
			let output = answerBlocks.join("\n\n---\n\n");
			if (output) output += "\n\n---\n\n**Sources:**\n";
			output += allResults.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n\n");
			output += `\n\n---\nUse get_search_content({ responseId: "${id}" }) for full details.`;

			return {
				content: [{ type: "text", text: output }],
				details: {
					queries,
					queryCount: queries.length,
					totalResults: allResults.length,
					searchId: id,
				},
			};
		},

		renderCall(args, theme) {
			const input = args as { query?: unknown; queries?: unknown };
			const list: unknown[] = Array.isArray(input.queries) ? input.queries : (input.query !== undefined ? [input.query] : []);
			const qs = list.filter((q): q is string => typeof q === "string").map(q => q.trim()).filter(Boolean);
			if (qs.length === 0) return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("error", "(no query)"), 0, 0);
			if (qs.length === 1) {
				const d = qs[0].length > 60 ? qs[0].slice(0, 57) + "..." : qs[0];
				return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `"${d}"`), 0, 0);
			}
			return new Text(
				theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", `${qs.length} queries`),
				0, 0,
			);
		},

		renderResult(result, { expanded }, theme) {
			const d = result.details as { queryCount?: number; totalResults?: number; searchId?: string };
			const line = theme.fg("success", `${d?.totalResults ?? 0} sources from ${d?.queryCount ?? 0} queries`);
			if (!expanded) return new Text(line, 0, 0);
			const text = result.content.find(c => c.type === "text")?.text || "";
			const preview = text.length > 500 ? text.slice(0, 500) + "..." : text;
			return new Text(line + "\n" + theme.fg("dim", preview), 0, 0);
		},
	});

	pi.registerTool<typeof fetchContentSchema, FetchContentDetails>({
		name: "fetch_content",
		label: "Fetch Content",
		description: "Fetch URL(s) and extract readable content as markdown. Returns full content for single URLs (with responseId if truncated).",
		promptSnippet: "Use to extract readable content from URL(s).",

		parameters: fetchContentSchema,

		async execute(_toolCallId, params, signal) {
			const urlList = params.urls ?? (params.url ? [params.url] : []);
			if (urlList.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No URL provided." }],
					details: { error: "No URL provided" },
				};
			}

			const results = await Promise.all(urlList.map(url => fetchUrl(url, signal)));
			const successful = results.filter(r => !r.error);
			const failed = results.filter(r => r.error);

			// Store for retrieval
			const responseId = genId();
			const entry: StoredSearch = {
				id: responseId,
				type: "fetch",
				timestamp: Date.now(),
				urls: results.map(r => ({ url: r.url, title: r.title, content: r.content, error: r.error })),
			};
			rememberStored(entry);
			pi.appendEntry("web-search-results", entry);

			// Single URL: return content directly
			if (urlList.length === 1) {
				const r = results[0];
				if (r.error) {
					return {
						content: [{ type: "text", text: `Error: ${r.error}` }],
						details: { url: r.url, error: r.error, responseId },
					};
				}
				const MAX_INLINE = 30000;
				const truncated = r.content.length > MAX_INLINE;
				let output = truncated ? r.content.slice(0, MAX_INLINE) + "\n\n[Content truncated...]" : r.content;
				if (truncated) {
					output += `\n\n---\nUse get_search_content({ responseId: "${responseId}", urlIndex: 0 }) for full content.`;
				}
				return {
					content: [{ type: "text", text: output }],
					details: { url: r.url, title: r.title, totalChars: r.content.length, responseId, truncated },
				};
			}

			// Multiple URLs: summary
			let output = "## Fetched URLs\n\n";
			for (const r of results) {
				if (r.error) output += `- ${r.url}: Error - ${r.error}\n`;
				else output += `- ${r.title || r.url} (${r.content.length} chars)\n`;
			}
			output += `\n---\nUse get_search_content({ responseId: "${responseId}", urlIndex: N }) for full content.`;

			return {
				content: [{ type: "text", text: output }],
				details: { urlCount: urlList.length, successful: successful.length, responseId },
			};
		},

		renderCall(args, theme) {
			const { url, urls } = args as { url?: string; urls?: string[] };
			const list = urls ?? (url ? [url] : []);
			if (list.length === 0) return new Text(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("error", "(no URL)"), 0, 0);
			if (list.length === 1) {
				const d = list[0].length > 60 ? list[0].slice(0, 57) + "..." : list[0];
				return new Text(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", d), 0, 0);
			}
			return new Text(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", `${list.length} URLs`), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const d = result.details as { url?: string; title?: string; totalChars?: number; error?: string; urlCount?: number; successful?: number };
			if (d?.error) return new Text(theme.fg("error", `Error: ${d.error}`), 0, 0);
			if (d?.urlCount && d.urlCount > 1) {
				const line = theme.fg("success", `${d.successful}/${d.urlCount} URLs`);
				if (!expanded) return new Text(line, 0, 0);
				const text = result.content.find(c => c.type === "text")?.text || "";
				return new Text(line + "\n" + theme.fg("dim", text.length > 300 ? text.slice(0, 300) + "..." : text), 0, 0);
			}
			const line = theme.fg("success", (d?.title || "Content")) + theme.fg("muted", ` (${d?.totalChars ?? 0} chars)`);
			if (!expanded) return new Text(line, 0, 0);
			const text = result.content.find(c => c.type === "text")?.text || "";
			return new Text(line + "\n" + theme.fg("dim", text.length > 500 ? text.slice(0, 500) + "..." : text), 0, 0);
		},
	});

	pi.registerTool<typeof getSearchContentSchema, GetSearchContentDetails>({
		name: "get_search_content",
		label: "Get Search Content",
		description: "Retrieve full content from a previous web_search or fetch_content call.",
		promptSnippet: "Use after web_search/fetch_content when full stored content is needed via responseId plus query/url selectors.",

		parameters: getSearchContentSchema,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const data = findStored(params.responseId, ctx);
			if (!data) {
				return {
					content: [{ type: "text", text: `No stored results for "${params.responseId}"` }],
					details: { error: "Not found" },
				};
			}

			if (data.type === "search" && data.queries) {
				let qd: NonNullable<StoredSearch["queries"]>[number] | undefined;
				if (params.query !== undefined) {
					qd = data.queries.find(q => q.query === params.query);
					if (!qd) return { content: [{ type: "text", text: `Query "${params.query}" not found.` }], details: { error: "Not found" } };
				} else if (params.queryIndex !== undefined) {
					qd = data.queries[params.queryIndex];
					if (!qd) return { content: [{ type: "text", text: `Index ${params.queryIndex} out of range.` }], details: { error: "Out of range" } };
				} else {
					return { content: [{ type: "text", text: `Specify query or queryIndex. Available: ${data.queries.map((q, i) => `${i}: "${q.query}"`).join(", ")}` }], details: { error: "No query specified" } };
				}

				if (qd.error) return { content: [{ type: "text", text: `Error: ${qd.error}` }], details: { error: qd.error } };
				let output = qd.answer ? `${qd.answer}\n\n---\n\n` : "";
				output += qd.results.map(r => `### ${r.title}\n${r.url}`).join("\n\n");
				return { content: [{ type: "text", text: output }], details: { query: qd.query, resultCount: qd.results.length } };
			}

			if (data.type === "fetch" && data.urls) {
				let ud: NonNullable<StoredSearch["urls"]>[number] | undefined;
				if (params.url !== undefined) {
					ud = data.urls.find(u => u.url === params.url);
					if (!ud) return { content: [{ type: "text", text: `URL not found.` }], details: { error: "Not found" } };
				} else if (params.urlIndex !== undefined) {
					ud = data.urls[params.urlIndex];
					if (!ud) return { content: [{ type: "text", text: `Index ${params.urlIndex} out of range.` }], details: { error: "Out of range" } };
				} else {
					return { content: [{ type: "text", text: `Specify url or urlIndex. Available:\n${data.urls.map((u, i) => `${i}: ${u.url}`).join("\n")}` }], details: { error: "No URL specified" } };
				}

				if (ud.error) return { content: [{ type: "text", text: `Error: ${ud.error}` }], details: { error: ud.error } };
				return { content: [{ type: "text", text: `# ${ud.title}\n\n${ud.content}` }], details: { url: ud.url, title: ud.title, contentLength: ud.content.length } };
			}

			return { content: [{ type: "text", text: "Invalid stored data" }], details: { error: "Invalid data" } };
		},

		renderCall(args, theme) {
			const { responseId, query, queryIndex, url, urlIndex } = args as { responseId: string; query?: string; queryIndex?: number; url?: string; urlIndex?: number };
			let target = query ? `query="${query}"` : queryIndex !== undefined ? `queryIndex=${queryIndex}` : url ? (url.length > 30 ? url.slice(0, 27) + "..." : url) : urlIndex !== undefined ? `urlIndex=${urlIndex}` : responseId.slice(0, 8);
			return new Text(theme.fg("toolTitle", theme.bold("get_content ")) + theme.fg("accent", target), 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const d = result.details as { error?: string; query?: string; url?: string; title?: string; resultCount?: number; contentLength?: number };
			if (d?.error) return new Text(theme.fg("error", `Error: ${d.error}`), 0, 0);
			const line = d?.query
				? theme.fg("success", `"${d.query}"`) + theme.fg("muted", ` (${d.resultCount} results)`)
				: theme.fg("success", d?.title || "Content") + theme.fg("muted", ` (${d?.contentLength ?? 0} chars)`);
			if (!expanded) return new Text(line, 0, 0);
			const text = result.content.find(c => c.type === "text")?.text || "";
			return new Text(line + "\n" + theme.fg("dim", text.length > 500 ? text.slice(0, 500) + "..." : text), 0, 0);
		},
	});
}
