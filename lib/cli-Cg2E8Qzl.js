import { D as isChannelValidationBlock, E as extractDisplayErrorMessage, Q as WORKBUDDY_BRIDGE_HOME_DIRNAME, _ as CN_VARIANT, b as variantFor, d as discoverDesktopAuthFiles, et as resolveBridgeHome, h as atRestKeyProviderFor, i as WorkBuddyCatalog, k as normalizeCredits, n as FALLBACK_WORKBUDDY_AI_MODELS, nt as writeFileAtomic, r as FALLBACK_WORKBUDDY_MODELS, s as WorkBuddyCredentialStore, t as WORKBUDDY_CONNECT_VERSION, tt as withFileLock, v as WORKBUDDY_VARIANTS, w as WorkBuddyUpstreamClient } from "./version-PFU_guCs.js";
import { a as writeJson$1, c as hostIsLoopback, d as listenOnPreferredPort, i as readBody$1, l as hostnameOfHost, m as workbuddyCatalogPath, n as createWorkBuddyShim, o as writeOpenAIError, p as WorkBuddyCatalogStore, r as isJsonContentType, t as createLoopbackEndpoint, u as originIsLoopback } from "./shim-CU-wRADi.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer, request } from "node:http";
import { Readable } from "node:stream";
//#region src/standalone/wsl.ts
/**
* WSL reachability: a forwarder that re-exposes the loopback shim on the
* Windows-side address of the WSL virtual switch.
*
* ## Why this is needed
*
* WSL2 in its default NAT mode is a separate network namespace with its own
* loopback. `127.0.0.1` inside WSL is **not** the Windows loopback — it is
* WSL's own, where the bridge is not listening. So an agent running inside WSL
* (OpenCode, Claude Code, anything) cannot reach a bridge bound to `127.0.0.1`
* on Windows, and the failure looks like a bare connection refusal.
*
* Windows does expose one address WSL can reach: the host side of the WSL
* virtual switch, named `vEthernet (WSL)` (or `vEthernet (WSL (Hyper-V
* firewall))` on newer builds). It is WSL's default gateway, so WSL can always
* route to it. Binding there makes the bridge reachable from both the Windows
* host (loopback) and WSL (this address).
*
* ## Why a forwarder rather than binding the shim wider
*
* The shim's loopback-only bind is part of its security model, and the port
* promised to leave it exactly as upstream wrote it. So the shim keeps binding
* `127.0.0.1`, and this module — a frontend concern — accepts the WSL
* connection and proxies it to the loopback port.
*
* The forwarder deliberately does **not** loosen authentication. It forwards
* the `Authorization` header untouched, so the shim's per-process bearer token
* is still required on the WSL side. The forwarder only adds its own Host and
* Origin gate, and it is bound to a host-only virtual adapter: nothing on the
* LAN can reach it.
*
* ## The alternative with no code at all
*
* WSL 2.0+ on Windows 11 supports mirrored networking, which shares
* `localhost` between Windows and WSL. Adding this to `%USERPROFILE%\.wslconfig`
* and running `wsl --shutdown` makes the whole problem disappear:
*
* ```ini
* [wsl2]
* networkingMode=mirrored
* ```
*
* That is the better option when the Windows build supports it, because it
* needs no extra listener. This module is the fallback for NAT mode.
*
* @module workbuddy-bridge/standalone/wsl
*/
/**
* Are we running *inside* WSL, rather than on the Windows host?
*
* This decides which address to hand an agent: inside WSL the loopback URL is
* useless and `wslBaseUrl` is the only one that resolves. Detection is two
* cheap checks — the env var WSL sets, and the kernel banner, which every WSL
* kernel carries "microsoft" in. Both are needed because `WSL_DISTRO_NAME` is
* absent in some login paths (a bare `sh -c` from Windows, for instance).
*/
function isRunningInWsl() {
	if (process.platform !== "linux") return false;
	if (process.env["WSL_DISTRO_NAME"] !== void 0 && process.env["WSL_DISTRO_NAME"] !== "") return true;
	try {
		return /microsoft|wsl/iu.test(readFileSync("/proc/version", "utf8"));
	} catch {
		return false;
	}
}
/**
* Interface names Windows gives the WSL virtual switch.
*
* Matched case-insensitively as a substring rather than by exact name: the
* label has changed across builds (`vEthernet (WSL)` before the Hyper-V
* firewall integration, `vEthernet (WSL (Hyper-V firewall))` after), and a
* future rename should not silently disable this.
*/
const WSL_INTERFACE_PATTERN = /wsl/iu;
/**
* IPv4 addresses of the Windows-side WSL virtual switch, if any.
*
* Empty on a machine without WSL, which is not an error — it is how the caller
* knows there is nothing to expose.
*/
function wslHostAddresses() {
	const found = [];
	for (const [name, addresses] of Object.entries(networkInterfaces())) {
		if (!WSL_INTERFACE_PATTERN.test(name)) continue;
		for (const address of addresses ?? []) if (address.family === "IPv4" && !address.internal) found.push(address.address);
	}
	return found;
}
/**
* Is this request addressed to something we are willing to serve?
*
* Loopback is always acceptable, because the Windows host reaches the
* forwarder that way too. Beyond that, only the exact address we bound —
* which is the WSL switch address and nothing else.
*/
function requestAllowed(req, boundHost) {
	const host = req.headers.host;
	if (hostIsLoopback(host)) return originIsLoopback(req.headers.origin);
	if (host === void 0 || hostnameOfHost(host) !== boundHost) return false;
	const origin = req.headers.origin;
	if (origin === void 0 || origin.trim() === "") return true;
	try {
		const { hostname } = new URL(origin);
		return hostIsLoopback(hostname) || hostname === boundHost;
	} catch {
		return false;
	}
}
/**
* Start a forwarder from `host` to the loopback `target`.
*
* The Host header is rewritten to the target's before forwarding, because the
* shim's own gate requires a loopback Host and would otherwise reject every
* request that arrived through here. Everything else — method, path, body,
* `Authorization` — passes through unchanged, and the response is piped rather
* than buffered so the shim's `text/event-stream` chat responses keep
* streaming.
*/
function createWslForwarder(options) {
	const { host, logger } = options;
	const target = new URL(options.target);
	const server = createServer((req, res) => {
		handle(req, res);
	});
	const ready = listenOnPreferredPort(server, options.port, host);
	const url = () => {
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("workbuddy WSL forwarder has no address");
		return `http://${host}:${address.port}`;
	};
	async function handle(req, res) {
		if (!requestAllowed(req, host)) {
			res.writeHead(403, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "request-not-trusted" }));
			return;
		}
		const headers = { ...req.headers };
		headers["host"] = target.host;
		const upstream = request({
			hostname: target.hostname,
			port: target.port,
			path: req.url,
			method: req.method,
			headers
		}, (upstreamRes) => {
			res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
			upstreamRes.pipe(res);
		});
		upstream.on("error", (error) => {
			logger?.warn("workbuddy-bridge: WSL forwarder could not reach the loopback shim", error);
			if (!res.headersSent) {
				res.writeHead(502, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "loopback-unreachable" }));
				return;
			}
			res.end();
		});
		req.pipe(upstream);
	}
	return {
		ready,
		url,
		close: () => new Promise((resolve, reject) => {
			server.close(() => {
				resolve();
			});
			server.closeAllConnections();
			server.once("error", reject);
		})
	};
}
//#endregion
//#region src/standalone/descriptor.ts
/**
* The endpoint descriptor the standalone runner publishes.
*
* The shim keeps its upstream behaviour exactly — an ephemeral loopback port
* and a per-process in-memory secret — so nothing outside this process can
* know where to connect until the runner tells it. This document is that
* telling: one small 0600 file naming the base URL and bearer token for each
* running variant, rewritten on every start.
*
* Security note: writing the secret to disk narrows the shim's threat model
* from "no local process can forge a request" to "no *other user's* process
* can". Any process running as the same user can now read the token. That is
* the deliberate cost of letting an external agent be configured at all; use
* `--no-descriptor` or `--redact-token` to opt out, and note that an agent
* running as the same user could read the token out of this file either way.
*
* @module workbuddy-bridge/standalone/descriptor
*/
/** Basename of the descriptor inside the bridge home. */
const BRIDGE_DESCRIPTOR_FILENAME = ".workbuddy-bridge-endpoint.json";
/** Current descriptor format; readers reject others. */
const DESCRIPTOR_VERSION = 1;
/** Path of the descriptor file. */
function bridgeDescriptorPath() {
	return join(resolveBridgeHome(), BRIDGE_DESCRIPTOR_FILENAME);
}
/**
* Descriptor locations to try, most specific first.
*
* The extra entries exist for WSL. The bridge runs on Windows and writes under
* the **Windows** user profile, but inside WSL `$HOME` is the *Linux* home, so
* {@link bridgeDescriptorPath} points at a directory that has never held a
* descriptor. Without these candidates, `status`, `env` and `models` run from
* inside WSL would always report "no running bridge" — which is exactly the
* case those commands are most useful in.
*
* Each mounted drive's `Users` directory is enumerated, so a Windows account
* whose name differs from the Linux user is still found.
*/
function bridgeDescriptorCandidates() {
	const candidates = [bridgeDescriptorPath()];
	if (!isRunningInWsl()) return candidates;
	for (const usersDir of ["/mnt/c/Users", "/mnt/d/Users"]) {
		let entries;
		try {
			entries = readdirSync(usersDir);
		} catch {
			continue;
		}
		for (const entry of entries) candidates.push(join(usersDir, entry, WORKBUDDY_BRIDGE_HOME_DIRNAME, BRIDGE_DESCRIPTOR_FILENAME));
	}
	return candidates;
}
/** Parse a descriptor document, or undefined when it is absent or malformed. */
function parseDescriptor(text) {
	try {
		const parsed = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
		const document = parsed;
		if (document["version"] !== DESCRIPTOR_VERSION) return void 0;
		if (!Array.isArray(document["endpoints"])) return void 0;
		return parsed;
	} catch {
		return;
	}
}
/** Find the first readable descriptor among {@link bridgeDescriptorCandidates}. */
async function findBridgeDescriptor() {
	for (const path of bridgeDescriptorCandidates()) {
		let text;
		try {
			text = await readFile(path, "utf8");
		} catch {
			continue;
		}
		const descriptor = parseDescriptor(text);
		if (descriptor !== void 0) return {
			path,
			descriptor
		};
	}
}
/** Write the descriptor atomically at 0600. */
async function writeBridgeDescriptor(descriptor) {
	const path = bridgeDescriptorPath();
	await writeFileAtomic(path, `${JSON.stringify(descriptor, null, 2)}\n`, {
		mode: 384,
		dirMode: 448
	});
	return path;
}
/**
* Read the descriptor back, or undefined when there is none or it is
* unreadable. Never throws: a malformed file is a "no descriptor" answer, the
* same way a missing one is.
*
* Searches every candidate location, so this works when run from inside WSL as
* well as on Windows.
*/
async function readBridgeDescriptor() {
	return (await findBridgeDescriptor())?.descriptor;
}
/**
* Remove the descriptor, but only if it is still ours.
*
* Two bridges can legitimately run at once — a second instance started before
* the first was stopped, or an agent that spawned its own. There is one
* descriptor file, so the last writer wins; without this check, an exiting
* instance deletes the *other* instance's descriptor and makes a perfectly
* healthy bridge look stopped. Observed for real: a second instance exiting
* wiped the descriptor of a running one, and `status` then reported nothing.
*
* `pid` defaults to this process, which is what the CLI wants; pass it
* explicitly only to reason about another instance.
*/
async function removeBridgeDescriptor(pid = process.pid) {
	const found = await findBridgeDescriptor();
	if (found === void 0) return;
	if (found.descriptor.pid !== pid) return;
	await rm(found.path, { force: true });
}
//#endregion
//#region src/standalone/request-log.ts
/** How many turns one process remembers. */
const REQUEST_LOG_LIMIT = 200;
/** How many rows one endpoint's card shows. */
const REQUEST_ROWS_PER_CARD = 20;
/** Pull `model` out of a request body without assuming it parses. */
function modelOfBody(bodyJson) {
	try {
		const parsed = JSON.parse(bodyJson);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			const model = parsed["model"];
			if (typeof model === "string" && model !== "") return model;
		}
	} catch {}
	return "(unknown)";
}
/**
* Flatten one pool attempt for the log.
*
* The attempt's message is dropped deliberately: it is upstream error text
* that can echo request material, and `failure-capture.ts` already keeps it
* for the failures that need it. What survives is the class and the status,
* which is what makes a chain readable.
*/
function attemptRecord(attempt, labelOf) {
	const account = labelOf(attempt.index);
	switch (attempt.outcome.state) {
		case "ok": return {
			account,
			outcome: "ok"
		};
		case "credential-error": return {
			account,
			outcome: "credential-error"
		};
		case "upstream-error": return {
			account,
			outcome: attempt.outcome.kind,
			status: attempt.outcome.status
		};
	}
}
/**
* A fixed-size ring of recent turns, newest last.
*
* `record()` is called on the hot path of every request, so it does no I/O and
* cannot throw: a log that fails a turn would be worse than no log.
*/
var WorkBuddyRequestLog = class {
	limit;
	entries = [];
	nextId = 1;
	constructor(limit = 200) {
		this.limit = limit;
		if (!Number.isInteger(limit) || limit < 1) throw new Error("a request log needs a positive size");
	}
	/** How many turns are remembered. */
	get size() {
		return this.entries.length;
	}
	/** Add one turn, dropping the oldest when the ring is full. */
	record(input) {
		const entry = {
			id: this.nextId,
			atMs: Date.now(),
			...input
		};
		this.nextId += 1;
		this.entries.push(entry);
		if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
		return entry;
	}
	/** One endpoint's most recent turns, newest first. */
	recent(endpoint, limit = 20) {
		const rows = [];
		for (let index = this.entries.length - 1; index >= 0 && rows.length < limit; index -= 1) {
			const entry = this.entries[index];
			if (entry !== void 0 && entry.endpoint === endpoint) rows.push(entry);
		}
		return rows;
	}
};
//#endregion
//#region src/standalone/failure-capture.ts
/**
* Record the last channel-validation failure so a report can be diagnosed.
*
* The gateway's check is only partly understood. It rejects request shapes that
* could not be reproduced by hand, and the block behaves differently from one
* report to the next — per request in some, clustered in minutes-long bursts in
* others. Asking an operator to enable tracing *before* a rare failure is not
* realistic, so the bridge records the failing exchange itself.
*
* What is kept is deliberately narrow: the body the agent sent, and the
* upstream's error envelope. No credential, no response text, nothing from a
* successful turn. One file, overwritten each time, so it cannot accumulate.
*
* @module workbuddy-bridge/standalone/failure-capture
*/
/** Filename under the bridge home. */
const CHANNEL_FAILURE_FILENAME = "last-channel-failure.json";
/** How much of the agent's body to keep; enough to see every field. */
const REQUEST_BODY_LIMIT = 32768;
/** How much of the upstream's answer to keep. */
const UPSTREAM_BODY_LIMIT = 4096;
/** Absolute path of the capture file. */
function channelFailurePath() {
	return join(resolveBridgeHome(), CHANNEL_FAILURE_FILENAME);
}
/**
* Persist a channel-validation failure, if that is what happened.
*
* Fire-and-forget on purpose: this runs on a failure path where the caller is
* already being told something went wrong, and a disk problem must not turn a
* diagnosable refusal into a crash.
*/
async function captureChannelFailure(provider, bodyJson, result) {
	if (result.ok) return;
	if (!isChannelValidationBlock(result.status, result.message)) return;
	const record = {
		at: (/* @__PURE__ */ new Date()).toISOString(),
		provider,
		model: modelOfBody(bodyJson),
		upstreamStatus: result.status,
		upstreamBody: result.message.slice(0, UPSTREAM_BODY_LIMIT),
		requestBody: bodyJson.slice(0, REQUEST_BODY_LIMIT),
		channelHeaders: result.channelHeaders ?? {}
	};
	try {
		await writeFile(channelFailurePath(), JSON.stringify(record, null, 2), "utf8");
	} catch {}
}
//#endregion
//#region src/standalone/coalesce.ts
/** Pull the first choice's delta out of a parsed SSE payload. */
function deltaOf(event) {
	const delta = event.choices?.[0]?.delta;
	return typeof delta === "object" && delta !== null ? delta : void 0;
}
/**
* Rebuild one SSE event carrying `reasoning` as its reasoning delta.
*
* Cloned from the last real reasoning event so every field the upstream
* sends — id, model, created, object, the empty `content`/`tool_calls`
* placeholders — stays exactly as the client expects. Only
* `reasoning_content` is replaced.
*/
function reasoningEvent(template, reasoning) {
	const event = structuredClone(template);
	const delta = deltaOf(event);
	if (delta !== void 0) delta.reasoning_content = reasoning;
	return `data: ${JSON.stringify(event)}\n\n`;
}
/**
* Wrap a successful chat result so its stream carries one reasoning event per
* thinking phase.
*
* Returns the result untouched when it is a failure or has no body, so callers
* can apply this unconditionally.
*/
function coalesceReasoning(result) {
	if (!result.ok || result.response.body === null) return result;
	const upstream = result.response.body;
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let lineBuffer = "";
	let reasoning = "";
	let template;
	let suppressed = false;
	/** Send everything buffered — the reasoning run has ended. */
	const flushAll = (controller) => {
		if (reasoning === "" || template === void 0) return;
		controller.enqueue(encoder.encode(reasoningEvent(template, reasoning)));
		reasoning = "";
	};
	const handleLine = (line, controller) => {
		if (line === "") {
			if (suppressed) {
				suppressed = false;
				return;
			}
			controller.enqueue(encoder.encode("\n"));
			return;
		}
		if (!line.startsWith("data:")) {
			controller.enqueue(encoder.encode(`${line}\n`));
			return;
		}
		const payload = line.slice(5).trim();
		if (payload === "[DONE]") {
			flushAll(controller);
			controller.enqueue(encoder.encode(`${line}\n`));
			return;
		}
		let event;
		try {
			const parsed = JSON.parse(payload);
			if (typeof parsed === "object" && parsed !== null) event = parsed;
		} catch {
			event = void 0;
		}
		const delta = event === void 0 ? void 0 : deltaOf(event);
		const piece = delta?.reasoning_content;
		if (event !== void 0 && delta !== void 0 && typeof piece === "string" && piece !== "") {
			if (delta.role !== void 0 && reasoning === "") controller.enqueue(encoder.encode(reasoningEvent(event, "")));
			template = event;
			reasoning += piece;
			suppressed = true;
			return;
		}
		flushAll(controller);
		controller.enqueue(encoder.encode(`${line}\n`));
	};
	const stream = upstream.pipeThrough(new TransformStream({
		transform(chunk, controller) {
			lineBuffer += decoder.decode(chunk, { stream: true });
			let newline = lineBuffer.indexOf("\n");
			while (newline !== -1) {
				const line = lineBuffer.slice(0, newline);
				lineBuffer = lineBuffer.slice(newline + 1);
				handleLine(line, controller);
				newline = lineBuffer.indexOf("\n");
			}
		},
		flush(controller) {
			lineBuffer += decoder.decode();
			if (lineBuffer !== "") {
				handleLine(lineBuffer, controller);
				lineBuffer = "";
			}
			flushAll(controller);
		}
	}));
	const headers = new Headers(result.response.headers);
	headers.delete("content-length");
	headers.delete("content-encoding");
	return {
		ok: true,
		response: new Response(stream, {
			status: result.response.status,
			headers
		})
	};
}
//#endregion
//#region src/standalone/account-probe.ts
/**
* One real chat turn against one loopback endpoint, as evidence.
*
* "This account is signed in and has credits" is not the same claim as "this
* account can answer a turn": the credential can be present while the
* upstream refuses it, the model can be listed while the account's channel is
* rejected, and the shim's gates can fail for reasons none of the read-only
* checks see. The only honest test is the one an agent performs, so this
* sends exactly that — same base URL, same bearer token, same
* `/chat/completions` path — and reports the upstream's own words when it
* fails.
*
* The body is minimal on purpose: the shim forces streaming and prepends the
* system prompt itself, so anything larger would test the caller rather than
* the account.
*
* @module workbuddy-bridge/standalone/account-probe
*/
/** How long one probe turn may take before it is abandoned. */
const CHAT_PROBE_TIMEOUT_MS$1 = 6e4;
/** Compact message text for a thrown value. */
function messageOf$3(error) {
	return error instanceof Error ? error.message : String(error);
}
/** The minimal turn a probe sends; the account prepends its own system prompt. */
function probeBody(model) {
	return JSON.stringify({
		model,
		stream: true,
		messages: [{
			role: "user",
			content: "Reply with the single word: ok"
		}],
		max_tokens: 8
	});
}
/**
* Classify a finished probe response into the shape the page renders.
*
* Shared by the HTTP probe and the direct upstream probe, so a member test
* reads the same way whichever path it traveled.
*/
function probeDetail(status, text, startedAtMs) {
	const latencyMs = Date.now() - startedAtMs;
	if (status < 200 || status >= 300) return {
		ok: false,
		status,
		latencyMs,
		detail: `HTTP ${status}: ${text.slice(0, 400)}`
	};
	const delta = /"content"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
	const parts = [`HTTP ${status}`, `${text.length} bytes`];
	if (text.includes("[DONE]")) parts.push("terminated");
	parts.push(delta === null ? "no text delta" : `first text: ${(delta[1] ?? "").slice(0, 60)}`);
	return {
		ok: true,
		status,
		latencyMs,
		detail: parts.join(", ")
	};
}
/**
* Send one minimal streaming chat turn and classify what came back.
*
* Never throws: a refused connection, a timeout and a 402 are all answers to
* "can this account serve a turn", and the caller renders them the same way.
*/
async function probeChatTurn(options) {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort();
	}, options.timeoutMs ?? 6e4);
	const cancel = () => {
		controller.abort();
	};
	options.signal?.addEventListener("abort", cancel, { once: true });
	const startedAtMs = Date.now();
	try {
		const response = await fetch(`${options.baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...options.token === void 0 || options.token === "" ? {} : { Authorization: `Bearer ${options.token}` }
			},
			body: probeBody(options.model),
			signal: controller.signal
		});
		return probeDetail(response.status, await response.text(), startedAtMs);
	} catch (error) {
		return {
			ok: false,
			status: 0,
			latencyMs: Date.now() - startedAtMs,
			detail: messageOf$3(error)
		};
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", cancel);
	}
}
/**
* The default member probe: upstream HTTP for a provider, the account's own
* client path for an account. The same turn shape {@link probeChatTurn} sends.
*/
async function probeMemberTurn(options) {
	if (options.sendTurn === void 0) return await probeChatTurn({
		baseUrl: options.baseUrl,
		...options.apiKey === void 0 ? {} : { token: options.apiKey },
		model: options.model
	});
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort();
	}, CHAT_PROBE_TIMEOUT_MS$1);
	const startedAtMs = Date.now();
	try {
		const result = await options.sendTurn(probeBody(options.model), controller.signal);
		if (!result.ok) {
			const detail = extractDisplayErrorMessage(result.message) ?? result.message.slice(0, 400);
			const statusNote = (result.status === 401 || result.status === 403) && result.kind !== "session_dead" ? "" : ` (upstream http ${result.status})`;
			const status = result.kind === "hard_credit" ? 402 : result.kind === "soft_rate" ? 429 : result.kind === "session_dead" ? 401 : result.kind === "not_found" || result.kind === "server" ? 502 : 400;
			return {
				ok: false,
				status,
				latencyMs: Date.now() - startedAtMs,
				detail: `HTTP ${status}${statusNote}: ${detail}`
			};
		}
		return probeDetail(200, await result.response.text(), startedAtMs);
	} catch (error) {
		return {
			ok: false,
			status: 0,
			latencyMs: Date.now() - startedAtMs,
			detail: messageOf$3(error)
		};
	} finally {
		clearTimeout(timer);
	}
}
//#endregion
//#region src/standalone/pool.ts
/**
* Upstream failure classes where a different account could plausibly
* succeed, and are therefore worth failing over on:
*
* - `hard_credit` — this account's quota is gone; another account's is not
* - `soft_rate` — this account is throttled; another is not
* - `session_dead` — this credential cannot be renewed, or the gateway has
*   restricted the account itself; another may be fine
* - `server` — a 5xx may be account-scoped (per-account channel state), and
*   retrying the identical request on another account is what the upstream's
*   own 「请重新发送」 advice asks for
*
* Everything else stays on the failing member: a `client` (400) failure is a
* property of the *request*, so every account would answer it identically,
* and a transport error is a property of the *network*, which is shared.
*/
const POOL_FAILOVER_KINDS = /* @__PURE__ */ new Set([
	"hard_credit",
	"soft_rate",
	"session_dead",
	"server"
]);
/** Compact message text for a thrown value. */
function messageOf$2(error) {
	return error instanceof Error ? error.message.slice(0, 300) : String(error);
}
/**
* One pool endpoint's request router.
*
* Implements the two pieces the shim consumes — `store.resolve()` and
* `client.chatStream()` — over the member list. `resolve()` exists only as
* the shim's signed-in existence check: it answers with the head member's
* credential when any member has one, so a pool where every account is
* signed out still produces the shim's 401 rather than a confused 500. The
* real per-attempt credential resolution happens inside {@link chatStream}.
*/
var WorkBuddyFailoverPool = class {
	members;
	/** Where the next request starts; advances past failed members. */
	head = 0;
	/** Per-member traffic record, parallel to `members`. */
	observed;
	constructor(members) {
		this.members = members;
		if (members.length === 0) throw new Error("a failover pool needs at least one account");
		this.observed = members.map((_member, index) => ({
			index,
			lastAttemptAtMs: 0,
			consecutiveFailures: 0,
			successes: 0,
			failures: 0
		}));
	}
	/** How many accounts the pool can draw from. */
	get size() {
		return this.members.length;
	}
	/** The member that will answer the next request, 0-based. */
	headIndex() {
		return this.head;
	}
	/** A copy of each member's traffic record, in member order. */
	memberHealth() {
		return this.observed.map((entry) => ({ ...entry }));
	}
	/** The shim's signed-in existence check: any member's credential will do. */
	async resolve() {
		let lastError;
		for (let offset = 0; offset < this.members.length; offset += 1) {
			const member = this.members[(this.head + offset) % this.members.length];
			try {
				return await member.store.resolve();
			} catch (error) {
				lastError = error;
			}
		}
		throw lastError ?? /* @__PURE__ */ new Error("the account pool is empty");
	}
	/**
	* Send one chat turn through the pool.
	*
	* The `credential` argument is the shim's resolved head credential and is
	* deliberately ignored: each attempt resolves its own member's credential,
	* because the whole point is that the answering account is chosen by the
	* failure pattern, not by whoever happened to be head when the request
	* arrived. Returns the first success; otherwise the last failure seen.
	*/
	async chatStream(_credential, bodyJson, signal, onAttempt) {
		let last;
		for (let offset = 0; offset < this.members.length; offset += 1) {
			if (signal?.aborted === true) return last ?? {
				ok: false,
				status: 0,
				kind: "server",
				message: "transport error: request aborted before an account could answer"
			};
			const index = (this.head + offset) % this.members.length;
			const member = this.members[index];
			let credential;
			try {
				credential = await member.store.resolve();
			} catch (error) {
				const outcome = {
					state: "credential-error",
					message: messageOf$2(error)
				};
				last = {
					ok: false,
					status: 401,
					kind: "session_dead",
					message: messageOf$2(error)
				};
				this.note(index, outcome);
				onAttempt?.({
					index,
					outcome
				});
				continue;
			}
			const result = await member.client.chatStream(credential, bodyJson, signal);
			if (result.ok) {
				this.head = index;
				const outcome = { state: "ok" };
				this.note(index, outcome);
				onAttempt?.({
					index,
					outcome
				});
				return result;
			}
			last = result;
			const outcome = {
				state: "upstream-error",
				status: result.status,
				kind: result.kind,
				message: result.message
			};
			this.note(index, outcome);
			onAttempt?.({
				index,
				outcome
			});
			if (!POOL_FAILOVER_KINDS.has(result.kind)) return result;
		}
		return last ?? {
			ok: false,
			status: 0,
			kind: "server",
			message: "the account pool is empty"
		};
	}
	/**
	* Fold one attempt into that member's record.
	*
	* Recorded by the router itself rather than by the caller's `onAttempt`
	* hook, because the UI reads it whether or not anybody is listening to the
	* hook — and a record that only exists when a diagnostic is attached would
	* be empty exactly when an operator first opens the page.
	*/
	note(index, outcome) {
		const entry = this.observed[index];
		if (entry === void 0) return;
		entry.lastAttemptAtMs = Date.now();
		entry.lastOutcome = outcome;
		if (outcome.state === "ok") {
			entry.successes += 1;
			entry.consecutiveFailures = 0;
			return;
		}
		entry.failures += 1;
		entry.consecutiveFailures += 1;
	}
};
//#endregion
//#region src/standalone/endpoint-identity.ts
/**
* The stable part of a loopback endpoint: its port and its bearer secret.
*
* The shim mints both fresh every start — an OS-chosen port and a random
* in-memory secret — which is safe but makes every restart a reconfiguration:
* an agent pointed at the old port gets a connection refusal, and one holding
* the old token gets a 401. This module is the memory that removes that
* churn. It records what an endpoint actually bound, keyed by the endpoint's
* published provider id, and the next start asks for those values back.
*
* Both are *preferences*, never requirements. A port another process now
* holds falls back to an ephemeral one, and a missing or unreadable record
* simply means "start as before". Stability is the common case, not a
* precondition for starting.
*
* Security note: persisting the token has exactly the threat model the
* descriptor already has — the token is written to a `0600` file under the
* bridge home, so any process running as the same user can read it. That is
* why token persistence is separable from port persistence: `--no-descriptor`
* keeps its promise of an in-memory-only secret by disabling only the token
* half, while ports (which are not secret) stay stable.
*
* @module workbuddy-bridge/standalone/endpoint-identity
*/
/** Basename of the identity document inside the bridge home. */
const ENDPOINT_IDENTITY_FILENAME = ".workbuddy-bridge-identity.json";
/** Current document format; a different version is treated as absent. */
const IDENTITY_VERSION = 1;
/**
* Key used for the web UI's own listener.
*
* Not an endpoint — the UI publishes no bearer and is never in the descriptor
* — but its URL is printed on start and opened by hand, so a stable port is
* worth the same treatment. The leading space keeps it out of the id space
* real providers use (ids are slugs, which cannot contain a space).
*/
const UI_IDENTITY_KEY = " ui";
/** Path of the identity document. */
function endpointIdentityPath() {
	return join(resolveBridgeHome(), ENDPOINT_IDENTITY_FILENAME);
}
/** A usable TCP port number, or undefined. */
function validPort(value) {
	return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65536 ? value : void 0;
}
/** A usable bearer secret, or undefined. Empty strings are never usable. */
function validToken(value) {
	return typeof value === "string" && value.trim() !== "" ? value : void 0;
}
/**
* Read one endpoint's record from an unparsed document.
*
* Deliberately lenient per entry: one damaged entry loses that endpoint's
* stability, not the whole file's. A caller that gets `undefined` starts the
* endpoint exactly as it would with no file at all.
*/
function parseEntry(raw) {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return void 0;
	const entry = raw;
	const port = validPort(entry["port"]);
	const token = validToken(entry["token"]);
	if (port === void 0 && token === void 0) return void 0;
	return {
		...port === void 0 ? {} : { port },
		...token === void 0 ? {} : { token }
	};
}
/** Parse a document, or an empty map when it is absent, malformed, or stale. */
function parseDocument$1(text) {
	const identities = /* @__PURE__ */ new Map();
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return identities;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return identities;
	const document = parsed;
	if (document["version"] !== IDENTITY_VERSION) return identities;
	const endpoints = document["endpoints"];
	if (typeof endpoints !== "object" || endpoints === null || Array.isArray(endpoints)) return identities;
	for (const [key, value] of Object.entries(endpoints)) {
		const entry = parseEntry(value);
		if (entry !== void 0) identities.set(key, entry);
	}
	return identities;
}
/** Read the whole document; a missing or damaged file reads as empty. */
async function readIdentities() {
	let text;
	try {
		text = await readFile(endpointIdentityPath(), "utf8");
	} catch {
		return /* @__PURE__ */ new Map();
	}
	return parseDocument$1(text);
}
/**
* Every remembered endpoint, for a caller starting several listeners at once.
*
* One read for the whole start: the bridge asks for each pool's values from
* this map rather than re-reading per endpoint.
*/
async function loadEndpointIdentities() {
	return await readIdentities();
}
/**
* Record what an endpoint actually bound, so the next start can ask for it.
*
* Runs under the document's advisory lock and re-reads first, so two bridges
* starting at once keep each other's keys instead of the last writer wiping
* the file. Writes nothing when the record is already current, which keeps
* repeated starts from churning the file.
*/
async function rememberEndpointIdentity(key, identity, options) {
	const port = validPort(identity.port);
	const token = options.persistToken ? validToken(identity.token) : void 0;
	if (port === void 0 && token === void 0) return;
	const path = endpointIdentityPath();
	await withFileLock(path, async () => {
		const current = await readIdentities();
		const existing = current.get(key);
		const samePort = existing?.port === port;
		const sameToken = options.persistToken ? existing?.token === token : true;
		if (samePort && sameToken) return;
		current.set(key, {
			...port === void 0 ? {} : { port },
			...options.persistToken && token !== void 0 ? { token } : existing?.token === void 0 ? {} : { token: existing.token }
		});
		const document = {
			version: IDENTITY_VERSION,
			endpoints: Object.fromEntries(current)
		};
		await writeFileAtomic(path, `${JSON.stringify(document, null, 2)}\n`, {
			mode: 384,
			dirMode: 448
		});
	});
}
/**
* The port a published base URL names, or undefined when it cannot be read.
*
* Callers have the live base URL, not the bound port, so this is how a
* just-started endpoint's port reaches the record.
*/
function portOfBaseUrl(baseUrl) {
	try {
		const port = new URL(baseUrl).port;
		return port === "" ? void 0 : validPort(Number(port));
	} catch {
		return;
	}
}
//#endregion
//#region src/standalone/provider-config.ts
/**
* Pure parser for the custom-provider configuration document. No I/O, no
* Node builtins — the loader that reads a file lives with the caller, and
* the parser here is the only place validation rules are defined.
*
* The document shape is:
*
* ```json
* {
*   "version": 1,
*   "providers": [
*     { "id": "my-llm", "displayName": "My LLM", "baseUrl": "https://api.example.com/v1",
*       "apiKeyEnv": "MY_API_KEY", "models": ["gpt-x", "gpt-y"] }
*   ]
* }
* ```
*
* `baseUrl` is the **full API prefix**: the shim appends `/chat/completions`
* itself, so a gateway that mounts OpenAI under a non-`/v1` path works as-is.
* `apiKeyEnv` is optional; a provider without one is served without an
* upstream credential (for local gateways that need none).
*
* Error messages name the offending field by path but never echo config
* values, so a secret-bearing document can be logged safely.
*
* @module workbuddy-bridge/provider-config
*/
/** The only config document version this parser accepts. */
const PROVIDER_CONFIG_VERSION = 1;
/** ids owned by the bridge itself or used as CLI aliases; custom ids cannot take them. */
const RESERVED_IDS = /* @__PURE__ */ new Set([
	"workbuddy",
	"workbuddy-ai",
	"cn",
	"ai",
	"both",
	"workbuddy-pool",
	"workbuddy-ai-pool"
]);
const SLUG_PATTERN$1 = /^[a-z0-9][a-z0-9._-]*$/;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
const ALLOWED_TOP_KEYS = /* @__PURE__ */ new Set(["version", "providers"]);
const ALLOWED_PROVIDER_KEYS = /* @__PURE__ */ new Set([
	"id",
	"displayName",
	"baseUrl",
	"apiKeyEnv",
	"models"
]);
/** Parse and validate an already-read config value (an object from JSON). */
function parseProviderConfig(input) {
	if (!isPlainObject(input)) return {
		ok: false,
		error: "provider config must be a JSON object"
	};
	for (const key of Object.keys(input)) if (!ALLOWED_TOP_KEYS.has(key)) return {
		ok: false,
		error: "provider config contains an unknown key"
	};
	if (input["version"] !== 1) return {
		ok: false,
		error: `provider config version must be 1`
	};
	const rawProviders = input["providers"];
	if (!Array.isArray(rawProviders) || rawProviders.length === 0) return {
		ok: false,
		error: "provider config must contain a nonempty providers array"
	};
	const seenIds = /* @__PURE__ */ new Set();
	const providers = [];
	for (let index = 0; index < rawProviders.length; index += 1) {
		const entry = rawProviders[index];
		const at = `providers[${index}]`;
		if (!isPlainObject(entry)) return {
			ok: false,
			error: `${at} must be an object`
		};
		for (const key of Object.keys(entry)) if (!ALLOWED_PROVIDER_KEYS.has(key)) return {
			ok: false,
			error: `${at} contains an unknown key`
		};
		const id = entry["id"];
		if (typeof id !== "string" || !SLUG_PATTERN$1.test(id)) return {
			ok: false,
			error: `${at}.id must be a lowercase slug ([a-z0-9._-], starting alphanumeric)`
		};
		if (RESERVED_IDS.has(id)) return {
			ok: false,
			error: `${at}.id is reserved`
		};
		if (seenIds.has(id)) return {
			ok: false,
			error: `${at}.id is a duplicate`
		};
		seenIds.add(id);
		let displayName;
		const rawDisplayName = entry["displayName"];
		if (rawDisplayName !== void 0) {
			if (typeof rawDisplayName !== "string" || rawDisplayName.trim() === "") return {
				ok: false,
				error: `${at}.displayName must be a nonempty string`
			};
			displayName = rawDisplayName;
		}
		const baseUrl = validateBaseUrl(entry["baseUrl"], `${at}.baseUrl`);
		if (!baseUrl.ok) return baseUrl;
		let apiKeyEnv;
		const rawEnv = entry["apiKeyEnv"];
		if (rawEnv !== void 0) {
			if (typeof rawEnv !== "string" || !ENV_NAME_PATTERN.test(rawEnv)) return {
				ok: false,
				error: `${at}.apiKeyEnv must be a valid environment variable name`
			};
			apiKeyEnv = rawEnv;
		}
		const rawModels = entry["models"];
		if (!Array.isArray(rawModels) || rawModels.length === 0 || rawModels.some((model) => typeof model !== "string" || model.trim() === "")) return {
			ok: false,
			error: `${at}.models must be a nonempty array of nonempty strings`
		};
		if (new Set(rawModels).size !== rawModels.length) return {
			ok: false,
			error: `${at}.models contains duplicates`
		};
		providers.push({
			id,
			...displayName === void 0 ? {} : { displayName },
			baseUrl: baseUrl.value,
			...apiKeyEnv === void 0 ? {} : { apiKeyEnv },
			models: [...rawModels]
		});
	}
	return {
		ok: true,
		config: { providers }
	};
}
/**
* Validate the base URL: absolute HTTPS (HTTP allowed for loopback hosts
* only, matching the shim's own bind policy), no credentials, query, or
* fragment, trailing slashes stripped. Everything else — path shape, port,
* host — is preserved exactly, because the value is a full API prefix the
* endpoint appends `/chat/completions` to.
*/
function validateBaseUrl(value, at) {
	if (typeof value !== "string" || value.trim() === "") return {
		ok: false,
		error: `${at} must be a nonempty string`
	};
	let url;
	try {
		url = new URL(value);
	} catch {
		return {
			ok: false,
			error: `${at} must be an absolute URL`
		};
	}
	const hostname = url.hostname.toLowerCase();
	const loopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return {
		ok: false,
		error: `${at} must use https (http only for loopback hosts)`
	};
	if (url.username !== "" || url.password !== "") return {
		ok: false,
		error: `${at} must not carry credentials`
	};
	if (url.search !== "") return {
		ok: false,
		error: `${at} must not carry a query string`
	};
	if (url.hash !== "") return {
		ok: false,
		error: `${at} must not carry a fragment`
	};
	return {
		ok: true,
		value: url.origin + url.pathname.replace(/\/+$/, "")
	};
}
/** Upper bound on upstream error body bytes read for diagnostics. */
const UPSTREAM_ERROR_BODY_LIMIT = 16384;
/** Fixed marker logged instead of an unconfigured (unvalidated) model id. */
const UNCONFIGURED_MODEL_MARKER = "<unconfigured>";
/**
* Read an upstream response body incrementally, up to `limit` bytes, then
* stop consuming and cancel the rest. Returns the bounded prefix as text.
*/
async function readBoundedBody(response, limit) {
	const body = response.body;
	if (body === null) return "";
	const reader = body.getReader();
	const chunks = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done || value === void 0) break;
			size += value.byteLength;
			chunks.push(value);
			if (size >= limit) break;
		}
	} catch {} finally {
		await reader.cancel().catch(() => {});
	}
	return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).subarray(0, limit).toString("utf8");
}
/**
* Reduce an upstream error body to a bounded, secret-safe diagnostic:
* a structured OpenAI-style subset when the body parses as a JSON object
* with an `error` object, a fixed message otherwise. Every retained string
* field (`message`, `type`, `code`, `param`) passes the same sanitizer: the
* resolved API key is redacted and the value is length-capped. Non-string
* scalars on those fields are dropped (the subset is string-typed), and
* arbitrary echoed material is dropped for unstructured bodies rather than
* sanitized hopefully.
*/
const ERROR_FIELD_CAP = 800;
function sanitizeErrorField(value, resolvedKey) {
	let out = value;
	if (resolvedKey !== void 0 && resolvedKey !== "") out = out.split(resolvedKey).join("[redacted]");
	return out.length > ERROR_FIELD_CAP ? out.slice(0, ERROR_FIELD_CAP) : out;
}
function buildUpstreamError(boundedText, status, resolvedKey) {
	let parsed;
	try {
		parsed = JSON.parse(boundedText);
	} catch {
		parsed = void 0;
	}
	if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
		const error = parsed["error"];
		if (typeof error === "object" && error !== null && !Array.isArray(error)) {
			const shaped = error;
			const message = typeof shaped["message"] === "string" ? sanitizeErrorField(shaped["message"], resolvedKey) : void 0;
			const type = typeof shaped["type"] === "string" ? sanitizeErrorField(shaped["type"], resolvedKey) : void 0;
			const code = typeof shaped["code"] === "string" ? sanitizeErrorField(shaped["code"], resolvedKey) : void 0;
			const param = typeof shaped["param"] === "string" ? sanitizeErrorField(shaped["param"], resolvedKey) : void 0;
			if (message !== void 0 || type !== void 0 || code !== void 0 || param !== void 0) return {
				message: message ?? `upstream returned http ${status}`,
				type: type ?? "upstream_error",
				...code === void 0 ? {} : { code },
				...param === void 0 ? {} : { param }
			};
		}
	}
	return {
		message: `upstream returned http ${status}`,
		type: "upstream_error"
	};
}
/**
* Whether an upstream HTTP status is a property of *that* provider rather
* than of the request, and so is worth retrying elsewhere.
*/
function upstreamStatusRetryable(status) {
	return status === 401 || status === 402 || status === 403 || status === 404 || status === 429 || status >= 500;
}
/**
* Send one chat turn to one provider and stop at the response headers.
*
* This is the whole hardened transport in one place, shared by the
* single-provider shim and the multi-provider pool: manual redirect refusal
* (the key must never be replayed to an unvetted `Location`), a
* headers-only deadline that never cuts a long body, downstream cancellation
* linked through the returned stream, and a bounded, secret-redacted
* diagnostic for a failed turn.
*
* `signal` is the downstream cancellation; the header deadline is internal
* and per attempt, so a pool retrying a timed-out provider does not abort the
* whole request.
*/
async function startUpstreamTurn(request, rawBody, options = {}) {
	const headersTimeoutMs = options.headersTimeoutMs ?? 6e4;
	const downstream = options.signal;
	const controller = new AbortController();
	const onAbort = () => {
		controller.abort();
	};
	if (downstream?.aborted === true) return {
		kind: "failure",
		reason: "cancelled",
		status: 499,
		error: {
			message: "the client cancelled the request",
			type: "cancelled"
		},
		retryable: false
	};
	downstream?.addEventListener("abort", onAbort, { once: true });
	let headersTimedOut = false;
	const timer = setTimeout(() => {
		headersTimedOut = true;
		controller.abort();
	}, headersTimeoutMs);
	const releaseTimer = () => {
		clearTimeout(timer);
	};
	const headers = {
		"Content-Type": "application/json",
		"Accept": "application/json, text/event-stream",
		...request.apiKey === void 0 ? {} : { "Authorization": `Bearer ${request.apiKey}` }
	};
	let upstream;
	try {
		upstream = await fetch(`${request.baseUrl}/chat/completions`, {
			method: "POST",
			headers,
			body: rawBody,
			signal: controller.signal,
			redirect: "manual"
		});
	} catch {
		releaseTimer();
		if (headersTimedOut) return {
			kind: "failure",
			reason: "timeout",
			status: 504,
			error: {
				message: "the upstream did not send response headers in time",
				type: "upstream_timeout",
				code: "upstream_timeout"
			},
			retryable: true
		};
		if (controller.signal.aborted && !headersTimedOut) return {
			kind: "failure",
			reason: "cancelled",
			status: 499,
			error: {
				message: "the client cancelled the request",
				type: "cancelled",
				code: "cancelled"
			},
			retryable: false
		};
		return {
			kind: "failure",
			reason: "unreachable",
			status: 502,
			error: {
				message: "could not reach the upstream endpoint",
				type: "upstream_unreachable",
				code: "upstream_unreachable"
			},
			retryable: true
		};
	}
	releaseTimer();
	if (upstream.status >= 300 && upstream.status < 400) {
		await upstream.body?.cancel().catch(() => {});
		return {
			kind: "failure",
			reason: "redirect",
			status: 502,
			error: {
				message: "the upstream tried to redirect; refusing to follow it",
				type: "upstream_redirect",
				code: "upstream_redirect"
			},
			retryable: true,
			upstreamStatus: upstream.status
		};
	}
	if (!upstream.ok) {
		const bounded = await readBoundedBody(upstream, UPSTREAM_ERROR_BODY_LIMIT);
		return {
			kind: "failure",
			reason: "upstream",
			status: upstream.status,
			error: buildUpstreamError(bounded, upstream.status, request.apiKey),
			retryable: upstreamStatusRetryable(upstream.status),
			upstreamStatus: upstream.status
		};
	}
	return {
		kind: "response",
		status: upstream.status,
		contentType: upstream.headers.get("content-type") ?? "",
		body: upstream.body
	};
}
/**
* Forward one upstream response to the downstream client.
*
* Resolves once the response is committed to the wire — for a stream that is
* after the headers are written, not after the last byte, so the caller can
* record the turn without waiting for the body.
*/
async function writeUpstreamTurn(res, turn, onStreamError) {
	if (turn.contentType.includes("text/event-stream")) {
		res.writeHead(turn.status, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
			"X-Accel-Buffering": "no"
		});
		const body = Readable.fromWeb(turn.body);
		body.on("error", (error) => {
			onStreamError?.(error);
			if (res.writable) res.end();
		});
		body.pipe(res);
		return;
	}
	if (turn.status === 204 || turn.status === 304) {
		res.writeHead(turn.status);
		res.end();
		return;
	}
	const buffer = turn.body === null ? Buffer.alloc(0) : Buffer.from(await new Response(turn.body).arrayBuffer());
	res.writeHead(turn.status, { "Content-Type": turn.contentType || "application/json" });
	res.end(buffer);
}
/**
* Start the custom-provider loopback endpoint. The bearer it requires is
* the per-process shared secret from the neutral endpoint — the same
* publication model as the WorkBuddy shim.
*/
function createOpenAICompatibleShim(options) {
	if (options.provider === void 0 && options.getSnapshot === void 0) throw new Error("openai-provider shim needs provider or getSnapshot");
	const resolveEnv = options.resolveApiKeyEnv ?? ((name) => process.env[name]);
	const logger = options.logger;
	const headersTimeoutMs = options.headersTimeoutMs ?? 6e4;
	/** The raw config this request uses; resolved once per request. */
	function raw() {
		return options.getSnapshot !== void 0 ? options.getSnapshot() : options.provider;
	}
	/**
	* Freeze one request's configuration, credential included, before the body
	* is read. A stored key is copied by value into the snapshot; an env name
	* is resolved here, at capture time, not later at upstream time.
	*/
	function current() {
		const config = raw();
		let auth;
		if (config.apiKey !== void 0 && config.apiKey !== "") auth = {
			kind: "stored",
			key: config.apiKey
		};
		else if (config.apiKeyEnv !== void 0) {
			const value = resolveEnv(config.apiKeyEnv);
			auth = value === void 0 || value === "" ? {
				kind: "env",
				envName: config.apiKeyEnv,
				missing: true
			} : {
				kind: "env",
				envName: config.apiKeyEnv,
				key: value
			};
		} else auth = { kind: "none" };
		return {
			id: config.id,
			baseUrl: config.baseUrl,
			models: config.models,
			auth
		};
	}
	/** Whether the frozen snapshot is credential-ready, and its key. */
	function credentialOf(snapshot) {
		if (snapshot.auth.kind === "stored") return {
			present: true,
			key: snapshot.auth.key
		};
		if (snapshot.auth.kind === "none") return {
			present: true,
			key: void 0
		};
		if ("missing" in snapshot.auth && snapshot.auth.missing) return {
			present: false,
			key: void 0,
			missingName: snapshot.auth.envName
		};
		return {
			present: true,
			key: snapshot.auth.key
		};
	}
	/** Whether the provider can serve at all right now (the model list's view). */
	function isAvailable(config) {
		if (config.apiKey !== void 0 && config.apiKey !== "") return true;
		if (config.apiKeyEnv === void 0) return true;
		const value = resolveEnv(config.apiKeyEnv);
		return value !== void 0 && value !== "";
	}
	function resolveModelList() {
		const config = raw();
		if (!isAvailable(config)) return [];
		return config.models.map((id) => ({
			id,
			ownedBy: config.id
		}));
	}
	async function handleChat(req, res) {
		const startedAt = Date.now();
		const finish = (outcome, status, model) => {
			logger?.request?.({
				outcome,
				status,
				model,
				durationMs: Date.now() - startedAt
			});
		};
		const provider = current();
		const credential = credentialOf(provider);
		if (!isJsonContentType(req)) {
			writeOpenAIError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
			finish("error", 415, "");
			return;
		}
		let raw;
		try {
			raw = (await readBody$1(req, { destroyOnLimit: false })).toString("utf8");
		} catch (error) {
			writeOpenAIError(res, 413, "request_too_large", String(error));
			finish("error", 413, "");
			return;
		}
		let body;
		try {
			body = JSON.parse(raw);
		} catch {
			writeOpenAIError(res, 400, "invalid_request", "request body must be valid JSON");
			finish("error", 400, "");
			return;
		}
		if (typeof body !== "object" || body === null || Array.isArray(body)) {
			writeOpenAIError(res, 400, "invalid_request", "request body must be a JSON object");
			finish("error", 400, "");
			return;
		}
		const requestedModel = body.model;
		const model = typeof requestedModel === "string" ? requestedModel : "";
		if (model === "" || !provider.models.includes(model)) {
			writeOpenAIError(res, 400, "model_not_configured", "model is not offered by this provider");
			finish("error", 400, UNCONFIGURED_MODEL_MARKER);
			return;
		}
		const apiKey = credential.key;
		if (!credential.present) {
			writeOpenAIError(res, 503, "api_key_missing", `the API key environment variable ${credential.missingName} is not set; set it and retry`);
			finish("error", 503, model);
			return;
		}
		const controller = new AbortController();
		res.on("close", () => {
			if (!res.writableEnded) controller.abort();
		});
		const turn = await startUpstreamTurn({
			baseUrl: provider.baseUrl,
			...apiKey === void 0 ? {} : { apiKey }
		}, raw, {
			signal: controller.signal,
			headersTimeoutMs
		});
		if (turn.kind === "failure") {
			if (turn.reason !== "cancelled") writeJson$1(res, turn.status, { error: turn.error });
			finish("error", turn.status, model);
			return;
		}
		await writeUpstreamTurn(res, turn, (error) => {
			logger?.warn("openai-provider: upstream stream failed mid-flight", error);
		});
		finish("ok", turn.status, model);
	}
	return createLoopbackEndpoint({
		listModels: () => resolveModelList(),
		handleChat,
		serveModelsAlias: true
	});
}
//#endregion
//#region src/standalone/provider-pool.ts
/** The published provider id of the pool endpoint. */
const CUSTOM_POOL_ID = "custom-pool";
/** A request the pool refuses before any provider is attempted. */
var CustomPoolRequestError = class extends Error {
	status;
	constructor(status, message) {
		super(message);
		this.status = status;
		this.name = "CustomPoolRequestError";
	}
};
/** Whether this provider can authenticate right now. */
function poolMemberAvailable(member) {
	if (member.apiKey !== void 0 && member.apiKey !== "") return true;
	if (member.apiKeyEnv === void 0) return true;
	const value = process.env[member.apiKeyEnv];
	return value !== void 0 && value !== "";
}
/**
* Freeze the member list for one request, resolving each provider's
* credential exactly once. A stored key is copied by value; an environment
* name is resolved here rather than at attempt time, so the credential and
* the destination travel together.
*/
function capturePoolMembers(members, resolveEnv = (name) => process.env[name]) {
	return members.map((member) => {
		if (member.apiKey !== void 0 && member.apiKey !== "") return {
			...member,
			key: member.apiKey
		};
		if (member.apiKeyEnv !== void 0) {
			const value = resolveEnv(member.apiKeyEnv);
			return value === void 0 || value === "" ? {
				...member,
				missingEnv: member.apiKeyEnv
			} : {
				...member,
				key: value
			};
		}
		return { ...member };
	});
}
/**
* The models the pool can actually serve: the union of every available
* provider's roster, in member order, deduplicated. A provider whose key is
* missing contributes nothing, because a request routed to it could only
* fail — the same rule the single-provider endpoint applies.
*/
function poolModelList(members) {
	const seen = /* @__PURE__ */ new Set();
	for (const member of members) {
		if (!poolMemberAvailable(member)) continue;
		for (const model of member.models) seen.add(model);
	}
	return [...seen];
}
/** The failure class a provider's HTTP status belongs to. */
function errorKindForStatus(status) {
	if (status === 401 || status === 403) return "session_dead";
	if (status === 402) return "hard_credit";
	if (status === 404) return "not_found";
	if (status === 429) return "soft_rate";
	if (status >= 500) return "server";
	return "client";
}
/**
* The router behind the pool endpoint.
*
* Holds no listeners and no credentials of its own: it owns only the routing
* state — who answers next and what each provider has done — while the
* endpoint owns the listener and the transport. Membership is passed in on
* every call rather than stored, so a page view can never move the head or
* describe a list the next request would not see.
*/
var CustomProviderFailoverPool = class {
	/** Where the next request starts, by id so a membership edit cannot move it. */
	headMemberId;
	observed = /* @__PURE__ */ new Map();
	/** Drop routing state for providers that are no longer members. */
	prune(members) {
		const present = new Set(members.map((member) => member.id));
		for (const id of [...this.observed.keys()]) if (!present.has(id)) this.observed.delete(id);
		if (this.headMemberId !== void 0 && !present.has(this.headMemberId)) this.headMemberId = void 0;
	}
	/** The member that will answer the next request, 0-based. */
	headIndex(members) {
		if (this.headMemberId === void 0) return 0;
		const index = members.findIndex((member) => member.id === this.headMemberId);
		return index < 0 ? 0 : index;
	}
	/** One record per member, in member order. */
	memberHealth(members) {
		return members.map((member, index) => {
			const record = this.observed.get(member.id);
			return {
				index,
				lastAttemptAtMs: record?.lastAttemptAtMs ?? 0,
				...record?.lastOutcome === void 0 ? {} : { lastOutcome: record.lastOutcome },
				consecutiveFailures: record?.consecutiveFailures ?? 0,
				successes: record?.successes ?? 0,
				failures: record?.failures ?? 0
			};
		});
	}
	/**
	* Send one request through the pool.
	*
	* `members` is the request's own captured snapshot, so the routing decision
	* and the credential always come from the same instant. Returns the first
	* success, otherwise the last failure; a non-retryable failure stops the
	* chain because every other provider would answer it identically.
	*/
	async route(members, model, attempt, signal) {
		this.prune(members);
		const offering = members.filter((member) => member.models.includes(model));
		if (offering.length === 0) throw new CustomPoolRequestError(400, "model is not offered by any provider in the pool");
		const attempts = [];
		let last;
		for (const member of this.rotation(offering, members)) {
			if (signal?.aborted === true) return {
				attempts,
				failure: last ?? {
					status: 499,
					kind: "client",
					message: "the request was cancelled before a provider could answer",
					error: {
						message: "the client cancelled the request",
						type: "cancelled"
					}
				}
			};
			const index = members.findIndex((candidate) => candidate.id === member.id);
			if (member.missingEnv !== void 0) {
				const message = `the API key environment variable ${member.missingEnv} is not set`;
				const outcome = {
					state: "credential-error",
					message
				};
				last = {
					status: 503,
					kind: "session_dead",
					message,
					error: {
						message,
						type: "api_key_missing"
					}
				};
				this.note(member.id, outcome);
				attempts.push({
					index,
					outcome
				});
				continue;
			}
			const result = await attempt(member, index);
			if (result.state === "ok") {
				this.headMemberId = member.id;
				const outcome = { state: "ok" };
				this.note(member.id, outcome);
				attempts.push({
					index,
					outcome
				});
				return {
					value: result.value,
					attempts
				};
			}
			const outcome = result.state === "credential-error" ? {
				state: "credential-error",
				message: result.message
			} : {
				state: "upstream-error",
				status: result.status,
				kind: result.kind,
				message: result.message
			};
			last = result.state === "credential-error" ? {
				status: 503,
				kind: "session_dead",
				message: result.message,
				error: {
					message: result.message,
					type: "api_key_missing"
				}
			} : {
				status: result.status,
				kind: result.kind,
				message: result.message,
				error: result.error
			};
			this.note(member.id, outcome);
			attempts.push({
				index,
				outcome
			});
			if (result.state === "upstream-error" && !result.retryable) return {
				attempts,
				failure: last
			};
		}
		return {
			attempts,
			failure: last ?? {
				status: 503,
				kind: "server",
				message: "the provider pool has no member to answer",
				error: {
					message: "the provider pool has no member to answer",
					type: "pool_empty"
				}
			}
		};
	}
	/**
	* The eligible providers in attempt order: rotation starts at the head and
	* wraps, so the head's preference survives a model that only some members
	* offer.
	*/
	rotation(offering, members) {
		const start = this.headIndex(members);
		const distance = (member) => {
			const index = members.findIndex((candidate) => candidate.id === member.id);
			if (index < 0) return Number.MAX_SAFE_INTEGER;
			return (index - start + members.length) % members.length;
		};
		return [...offering].sort((left, right) => distance(left) - distance(right));
	}
	/** Fold one attempt into that provider's record. */
	note(id, outcome) {
		const record = this.observed.get(id) ?? {
			lastAttemptAtMs: 0,
			consecutiveFailures: 0,
			successes: 0,
			failures: 0
		};
		record.lastAttemptAtMs = Date.now();
		record.lastOutcome = outcome;
		if (outcome.state === "ok") {
			record.successes += 1;
			record.consecutiveFailures = 0;
		} else {
			record.failures += 1;
			record.consecutiveFailures += 1;
		}
		this.observed.set(id, record);
	}
};
/**
* Start the pool endpoint: one loopback listener over every custom provider.
*
* The listener is permanent for the life of the bridge. Adding, editing, or
* removing a provider swaps the member list the shim reads, so no provider
* change ever opens or closes a port, and the published base URL and local
* token stay stable across edits.
*/
function createCustomProviderPoolShim(options) {
	const resolveEnv = options.resolveApiKeyEnv ?? ((name) => process.env[name]);
	const pool = new CustomProviderFailoverPool();
	async function handleChat(req, res) {
		const startedAt = Date.now();
		const members = capturePoolMembers(options.getMembers(), resolveEnv);
		const finish = (outcome, status, model, attempts) => {
			options.onTurn?.({
				endpoint: CUSTOM_POOL_ID,
				model,
				status,
				outcome,
				durationMs: Date.now() - startedAt,
				attempts,
				labels: members.map((member) => member.displayName)
			});
		};
		if (!isJsonContentType(req)) {
			writeOpenAIError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
			finish("error", 415, "", []);
			return;
		}
		let raw;
		try {
			raw = (await readBody$1(req, { destroyOnLimit: false })).toString("utf8");
		} catch (error) {
			writeOpenAIError(res, 413, "request_too_large", String(error));
			finish("error", 413, "", []);
			return;
		}
		let body;
		try {
			body = JSON.parse(raw);
		} catch {
			writeOpenAIError(res, 400, "invalid_request", "request body must be valid JSON");
			finish("error", 400, "", []);
			return;
		}
		if (typeof body !== "object" || body === null || Array.isArray(body)) {
			writeOpenAIError(res, 400, "invalid_request", "request body must be a JSON object");
			finish("error", 400, "", []);
			return;
		}
		const requestedModel = body.model;
		const model = typeof requestedModel === "string" ? requestedModel : "";
		if (model === "" || !members.some((member) => member.models.includes(model))) {
			writeOpenAIError(res, 400, "model_not_configured", "model is not offered by any provider in the pool");
			finish("error", 400, "", []);
			return;
		}
		const controller = new AbortController();
		res.on("close", () => {
			if (!res.writableEnded) controller.abort();
		});
		let outcome;
		try {
			outcome = await pool.route(members, model, async (member) => {
				const turn = await startUpstreamTurn({
					baseUrl: member.baseUrl,
					...member.key === void 0 ? {} : { apiKey: member.key }
				}, raw, {
					signal: controller.signal,
					...options.headersTimeoutMs === void 0 ? {} : { headersTimeoutMs: options.headersTimeoutMs }
				});
				if (turn.kind === "response") return {
					state: "ok",
					value: turn
				};
				if (turn.reason === "cancelled") return {
					state: "upstream-error",
					status: turn.status,
					kind: "client",
					message: turn.error.message,
					error: turn.error,
					retryable: false
				};
				return {
					state: "upstream-error",
					status: turn.status,
					kind: errorKindForStatus(turn.upstreamStatus ?? turn.status),
					message: turn.error.message,
					error: turn.error,
					retryable: turn.retryable
				};
			}, controller.signal);
		} catch (error) {
			if (error instanceof CustomPoolRequestError) {
				writeOpenAIError(res, error.status, "model_not_configured", error.message);
				finish("error", error.status, model, []);
				return;
			}
			throw error;
		}
		if (outcome.value !== void 0) {
			await writeUpstreamTurn(res, outcome.value, options.onStreamError);
			finish("ok", outcome.value.status, model, outcome.attempts);
			return;
		}
		const failure = outcome.failure;
		if (failure.status !== 499) writeJson$1(res, failure.status, { error: failure.error });
		finish("error", failure.status, model, outcome.attempts);
	}
	return {
		...createLoopbackEndpoint({
			listModels: () => poolModelList(options.getMembers()).map((id) => ({
				id,
				ownedBy: CUSTOM_POOL_ID
			})),
			handleChat,
			serveModelsAlias: true,
			...options.port === void 0 ? {} : { port: options.port },
			...options.token === void 0 ? {} : { token: options.token }
		}),
		router: pool
	};
}
//#endregion
//#region src/standalone/windows-acl.ts
/**
* Windows credential-directory restriction, behind a fail-closed seam.
*
* The managed-provider store keeps its document (which contains an API key)
* under the bridge home. On POSIX the 0700/0600 mode bits are enough. On
* Windows mode bits are advisory, so the directory is handed a private,
* exact DACL before any credential is written.
*
* The boundary is deliberately strict and fail-closed:
*
* - the identity comes from Windows itself
*   (`[System.Security.Principal.WindowsIdentity]::GetCurrent().User`),
*   never from a spoofable environment variable;
* - the directory's DACL is **replaced** by a fresh protected
*   `DirectorySecurity` — not patched in place — so an arbitrary explicit
*   ACE such as a Guests read grant (S-1-5-32-546) cannot survive;
* - the allowlist is exactly the current user, LOCAL SYSTEM, and
*   Administrators, each with FullControl;
* - existing regular-file children of the managed credential directory are
*   re-secured with the same exact DACL (file form), so a broad explicit ACE
*   seeded on an already-written providers.json cannot survive either. The
*   directory is exclusively the store's; reparse points are never followed
*   and abort the pass (fail closed);
* - every step is verified against the SID-level state afterwards, and any
*   missing OS surface, failing command, or unexpected resulting ACL raises
*   so the caller refuses the credential write.
*
* The seam takes a **path and nothing else**. The API key never appears in
* any command line, argument vector, or environment of this module — that is
* the whole reason it is separated from the store. The directory path rides
* an environment variable; it is never interpolated into script text.
*
* @module workbuddy-bridge/standalone/windows-acl
*/
/** Well-known SIDs on the allowlist besides the current user. */
const SYSTEM_SID = "S-1-5-18";
const ADMINISTRATORS_SID = "S-1-5-32-544";
/** The fixed Windows PowerShell executable — never PATH-resolved. */
function powershellPath() {
	const systemRoot = process.env["SystemRoot"]?.trim();
	if (systemRoot === void 0 || systemRoot === "") throw new Error("SystemRoot is not configured; cannot locate Windows PowerShell");
	return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
/**
* Run one static PowerShell script (base64-encoded `-EncodedCommand`, argv
* only). The script text is a fixed constant — the one value that varies
* (the directory path) is passed through the environment and read with the
* .NET environment API, because Windows PowerShell 5.1 cannot index `$env`
* as a hashtable. Nothing from the caller is ever interpolated.
*/
function runStaticScript(script, envName, value) {
	return new Promise((resolve, reject) => {
		execFile(powershellPath(), [
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-EncodedCommand",
			Buffer.from(script, "utf16le").toString("base64")
		], {
			windowsHide: true,
			timeout: 3e4,
			env: {
				...process.env,
				[envName]: value
			}
		}, (error, stdout, stderr) => {
			if (error !== null && error !== void 0) reject(/* @__PURE__ */ new Error(`windows-acl powershell step failed: ${error.message}${stderr === "" ? "" : ` :: ${stderr}`}`));
			else resolve(String(stdout));
		});
	});
}
/** The script that reports the caller's Windows SID (identity from the OS). */
const SID_SCRIPT = `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($null -eq $sid) { throw 'Windows would not report the current user SID' }
Write-Output ('WBSID|' + $sid.Value)
`;
/**
* The script that, for the path in `WB_ACL_TARGET`, installs the exact
* private DACL: protection on (inheritance and inherited ACEs gone), owner
* = current user, and exactly three FullControl allow rules — current user,
* LOCAL SYSTEM, Administrators. The .NET `SetAccessControl` persist applies
* it; ACL sets propagate inherited ACEs onto existing children, which is how
* broad explicit grants on already-written files are displaced too.
* Reparse-point children are never followed: they abort the step. The
* target itself is checked first — without following a possible link — so a
* junction placed at the credential-directory path cannot redirect the pass
* into another (still Guests-readable) destination.
*
* (The `Set-Acl` cmdlet is deliberately not used as the persist path: on
* Windows PowerShell 5.1 it throws `PrivilegeNotHeldException`
* (`SeSecurityPrivilege`) whenever it rewrites the descriptor of an
* already-protected target — reproducible with any input object, including
* the `Get-Acl` roundtrip — and the store restricts the directory on every
* operation. `SetAccessControl` persists the very same
* `DirectorySecurity` object through the same primitive without that defect.)
*/
const APPLY_SCRIPT = `
$ErrorActionPreference = 'Stop'
$path = [System.Environment]::GetEnvironmentVariable('WB_ACL_TARGET')
if ([string]::IsNullOrEmpty($path)) { throw 'WB_ACL_TARGET is not set' }
# The target itself is inspected WITHOUT following a possible link first:
# GetAttributes reports ReparsePoint on a junction/symlink instead of
# traversing into the destination, and Directory.Exists would follow it.
$targetAttributes = [System.IO.File]::GetAttributes($path)
if (-not ($targetAttributes -band [System.IO.FileAttributes]::Directory)) {
  throw ('the credential directory target is not a directory: ' + $path)
}
if ($targetAttributes -band [System.IO.FileAttributes]::ReparsePoint) {
  throw ('the credential directory target itself is a reparse point and is not followed: ' + $path)
}
if (-not [System.IO.Directory]::Exists($path)) { throw ('the target directory does not exist: ' + $path) }
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($null -eq $me) { throw 'Windows would not report the current user SID' }
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$admins = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')

# Reparse points are refused before any DACL is touched, so the pass can
# never be turned into a walk into attacker-chosen targets.
foreach ($child in [System.IO.Directory]::EnumerateFileSystemEntries($path)) {
  if ([System.IO.File]::GetAttributes($child) -band [System.IO.FileAttributes]::ReparsePoint) {
    throw ('a reparse-point child is not followed by the credential restriction: ' + $child)
  }
}

function New-PrivateSecurity {
  param([bool] $forDirectory)
  $sec = if ($forDirectory) {
    [System.Security.AccessControl.DirectorySecurity]::new()
  } else {
    [System.Security.AccessControl.FileSecurity]::new()
  }
  $sec.SetAccessRuleProtection($true, $false)
  $sec.SetOwner($me)
  foreach ($sid in @($me, $system, $admins)) {
    if ($forDirectory) {
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
    } else {
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $sid, 'FullControl', 'Allow')
    }
    $sec.SetAccessRule($rule)
  }
  return $sec
}

[System.IO.Directory]::SetAccessControl($path, (New-PrivateSecurity $true))

# Re-secure existing regular children so a broad explicit ACE seeded on a
# file that predates this pass cannot survive. Inherited ACEs flowing from
# the protected directory are also replaced, keeping each child exact.
foreach ($child in [System.IO.Directory]::EnumerateFileSystemEntries($path)) {
  if ([System.IO.File]::GetAttributes($child) -band [System.IO.FileAttributes]::Directory) {
    [System.IO.Directory]::SetAccessControl($child, (New-PrivateSecurity $true))
  } else {
    [System.IO.File]::SetAccessControl($child, (New-PrivateSecurity $false))
  }
}

Write-Output 'WBAPPLY-OK'
`;
/**
* The script that, for the path in `WB_ACL_TARGET`, reports the protection
* flag, owner, and every ACE at SID level so the caller can enforce the
* exact allowlist — no localized names, no icacls text.
*/
const VERIFY_SCRIPT = `
$ErrorActionPreference = 'Stop'
$path = [System.Environment]::GetEnvironmentVariable('WB_ACL_TARGET')
if ([string]::IsNullOrEmpty($path)) { throw 'WB_ACL_TARGET is not set' }
$isDir = [System.IO.Directory]::Exists($path)
$sec = if ($isDir) { [System.IO.Directory]::GetAccessControl($path) } else { [System.IO.File]::GetAccessControl($path) }
Write-Output ('WBVERIFY-PROTECTED|' + $sec.AreAccessRulesProtected)
$owner = $sec.GetOwner([System.Security.Principal.SecurityIdentifier])
if ($null -ne $owner) { Write-Output ('WBVERIFY-OWNER|' + $owner.Value) }
$rules = $sec.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
foreach ($rule in $rules) {
  Write-Output ('WBVERIFY-ACE|' + $rule.IdentityReference.Value + '|' + $rule.AccessControlType + '|' + $rule.FileSystemRights + '|' + $rule.InheritanceFlags + '|' + $rule.IsInherited)
}
Write-Output 'WBVERIFY-OK'
`;
/** Parse a `WBVERIFY-*` probe answer; the OK sentinel must be present. */
function parseVerify(output) {
	const lines = output.split(/\r?\n/u).map((line) => line.trim());
	if (!lines.includes("WBVERIFY-OK")) throw new Error("the Windows ACL verification did not complete");
	const result = {
		isProtected: false,
		owner: "",
		aces: []
	};
	for (const line of lines) if (line.startsWith("WBVERIFY-PROTECTED|")) result.isProtected = line.endsWith("True");
	else if (line.startsWith("WBVERIFY-OWNER|")) result.owner = line.slice(15);
	else if (line.startsWith("WBVERIFY-ACE|")) {
		const [, sid = "", type = "", rights = "", flags = "", inherited = ""] = line.split("|");
		result.aces.push({
			sid,
			type,
			rights,
			flags,
			inherited: inherited === "True"
		});
	}
	return result;
}
/** Assert the target carries exactly the private DACL the allowlist defines. */
async function verifyExactAcl(target, sid, isDirectory) {
	const acl = parseVerify(await runStaticScript(VERIFY_SCRIPT, "WB_ACL_TARGET", target));
	const expected = [
		sid,
		SYSTEM_SID,
		ADMINISTRATORS_SID
	].sort();
	const sids = acl.aces.map((ace) => ace.sid).sort();
	if (acl.isProtected !== true) throw new Error(`the credential ACL on ${target} is not protected from inheritance`);
	if (acl.owner !== sid) throw new Error(`the credential ACL on ${target} is not owned by the current user`);
	if (sids.length !== expected.length || sids.some((value, index) => value !== expected[index])) throw new Error(`the credential ACL on ${target} grants a principal outside the allowlist (found: ${sids.join(", ")})`);
	for (const ace of acl.aces) {
		if (ace.type !== "Allow" || ace.rights !== "FullControl") throw new Error(`the credential ACL on ${target} grants ${ace.sid} something other than FullControl Allow`);
		if (ace.inherited === true) throw new Error(`the credential ACL on ${target} still carries an inherited ACE`);
		const flags = isDirectory ? "ContainerInherit, ObjectInherit" : "None";
		if (ace.flags !== flags) throw new Error(`the credential ACL on ${target} has unexpected inheritance flags on ${ace.sid}`);
	}
}
/**
* Restrict `dir` to an exact private DACL, then return. Any failure
* propagates to the caller so a credential write is refused while the
* directory's protection is unverified.
*
* The path rides the environment and the identity comes from Windows; no
* key, document, or file content is ever passed here or logged here.
*/
async function restrictDirToCurrentUser(dir) {
	if (process.platform !== "win32") return;
	const sid = parseSid(await runStaticScript(SID_SCRIPT, "WB_ACL_TARGET", ""));
	await runStaticScript(APPLY_SCRIPT, "WB_ACL_TARGET", dir);
	await verifyExactAcl(dir, sid, true);
}
/** Extract the `S-1-...` token from the SID probe; absence is an error. */
function parseSid(output) {
	const line = output.split(/\r?\n/u).map((l) => l.trim()).find((l) => l.startsWith("WBSID|"));
	const sid = line === void 0 ? void 0 : line.slice(6);
	if (sid === void 0 || !/^S-1-\d+(?:-\d+)+$/u.test(sid)) throw new Error("the current Windows user SID could not be resolved");
	return sid;
}
//#endregion
//#region src/standalone/provider-store.ts
/**
* The UI-managed provider store: file-backed CRUD for custom
* OpenAI-compatible providers the user adds from the web UI (rather than a
* config file the CLI reads).
*
* Responsibilities, in the shape the UI and the bridge agreed:
*
* - **Validation** — one authoritative `validateSave` for every save; unknown
*   fields reject; the base URL re-uses the file-config parser's rules
*   (https, or http only for loopback). Error messages name the offending
*   field but never echo a value, because a payload can carry a key.
* - **Ids** — generated from the display name's slug, collision-safe by
*   suffix, and checked against the reserved set the file-config parser
*   enforces, so a managed provider can never shadow a built-in product or a
*   pool endpoint. The id is immutable across edits.
* - **Revisions** — an opaque token; every mutation demands the caller's
*   revision to match the current document's, so a stale tab (or a stale
*   process) fails with 409 instead of overwriting.
* - **Secrets** — the key is written only into the document; every answer,
*   error, and log line carries `hasApiKey` instead. `authMode: 'none'`
*   clears it; an edit that omits the key keeps the stored one.
* - **Durability** — atomic write plus an advisory lock (the shared
*   `core/atomic-write.ts` helpers), POSIX 0600/0700 via the write itself,
*   and a Windows restriction pass over the credential directory through an
*   injectable seam (`restrictCredentialDir`) so tests never spawn and the
*   production seam never puts the key on a command line (it takes a path,
*   nothing else).
*
* There is deliberately **no encryption**: the plan approved plaintext at
* rest under the user's own home directory with restrictive permissions —
* the same trust level as the config file this store parallels — and
* pretending otherwise would only misstate the threat model.
*
* A corrupt or unrecognized document **fails safe**: reads report an error
* and writes refuse, so a broken file can never be silently overwritten with
* an empty roster. Recovery is human: fix or delete the file.
*
* @module workbuddy-bridge/standalone/provider-store
*/
/** On-disk format version this store reads and writes. */
const MANAGED_PROVIDERS_VERSION = 1;
/** Directory name under the bridge home holding the managed store. */
const MANAGED_PROVIDERS_DIRNAME = "managed-providers";
/** Document filename inside {@link MANAGED_PROVIDERS_DIRNAME}. */
const MANAGED_PROVIDERS_FILENAME = "providers.json";
/**
* A manager rejection with an HTTP status and a message safe to show: no
* field value, no key, no filesystem detail ever appears in one.
*/
var ProviderManagementError = class extends Error {
	status;
	constructor(status, message) {
		super(message);
		this.status = status;
		this.name = "ProviderManagementError";
	}
};
/** Strip the stored key, yielding the metadata-only view. */
function viewOf(stored) {
	return {
		id: stored.id,
		displayName: stored.displayName,
		baseUrl: stored.baseUrl,
		models: [...stored.models],
		authMode: stored.authMode,
		hasApiKey: stored.apiKey !== void 0 && stored.apiKey !== ""
	};
}
const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
/**
* The id slug a display name would generate: lowercased, runs of anything
* outside `[a-z0-9._-]` collapsed to a single dash, edge separators dropped.
*/
function slugOf(displayName) {
	return displayName.toLowerCase().normalize("NFKD").replace(/[^a-z0-9._-]+/gu, "-").replace(/[-._]{2,}/gu, "-").replace(/^[-._]+|[-._]+$/gu, "");
}
/** Whether the value is a string with content after trimming. */
function isNonemptyString(value) {
	return typeof value === "string" && value.trim() !== "";
}
/**
* Validate one save payload, or throw a {@link ProviderManagementError}.
* The file-config parser stays the authority on base URLs; this adds the
* management payload's own rules on top.
*/
function validateSave(input) {
	if (typeof input !== "object" || input === null || Array.isArray(input)) throw new ProviderManagementError(400, "provider payload must be a JSON object");
	const record = input;
	const allowed = /* @__PURE__ */ new Set([
		"revision",
		"id",
		"displayName",
		"baseUrl",
		"models",
		"authMode",
		"apiKey"
	]);
	for (const key of Object.keys(record)) if (!allowed.has(key)) throw new ProviderManagementError(400, "provider payload contains an unknown field");
	if (!isNonemptyString(record["revision"])) throw new ProviderManagementError(400, "provider payload must carry the current revision");
	const rawId = record["id"];
	if (rawId !== void 0 && (typeof rawId !== "string" || !SLUG_PATTERN.test(rawId))) throw new ProviderManagementError(400, "provider id must be a lowercase slug");
	if (!isNonemptyString(record["displayName"])) throw new ProviderManagementError(400, "provider displayName must be a nonempty string");
	if (!isNonemptyString(record["baseUrl"])) throw new ProviderManagementError(400, "provider baseUrl must be a nonempty string");
	const probe = parseProviderConfig({
		version: 1,
		providers: [{
			id: "probe",
			baseUrl: record["baseUrl"],
			models: ["probe"]
		}]
	});
	if (!probe.ok) throw new ProviderManagementError(400, "provider baseUrl is not a valid OpenAI-compatible base URL");
	const rawModels = record["models"];
	if (!Array.isArray(rawModels) || rawModels.length === 0 || rawModels.some((model) => typeof model !== "string" || model.trim() === "")) throw new ProviderManagementError(400, "provider models must be a nonempty array of nonempty strings");
	if (new Set(rawModels).size !== rawModels.length) throw new ProviderManagementError(400, "provider models must not contain duplicates");
	const authMode = record["authMode"];
	if (authMode !== "api-key" && authMode !== "none") throw new ProviderManagementError(400, "provider authMode must be \"api-key\" or \"none\"");
	const base = slugOf(record["displayName"]);
	if (!SLUG_PATTERN.test(base)) throw new ProviderManagementError(400, "provider displayName does not produce a usable id; choose another name");
	if (RESERVED_IDS.has(base)) throw new ProviderManagementError(400, "provider displayName is reserved; choose another name");
	let apiKey = record["apiKey"];
	if (typeof apiKey === "string") apiKey = apiKey.trim() === "" ? void 0 : apiKey;
	else if (apiKey !== void 0) throw new ProviderManagementError(400, "provider apiKey must be a string when present");
	if (authMode === "api-key" && apiKey === void 0 && rawId === void 0) throw new ProviderManagementError(400, "a new api-key provider requires an apiKey");
	return {
		revision: record["revision"],
		id: rawId,
		displayName: record["displayName"].trim(),
		baseUrl: probe.config.providers[0].baseUrl,
		models: [...rawModels],
		authMode,
		apiKey
	};
}
/**
* The generated id for a display name, unique against `taken` and never one
* of the parser's reserved ids: `my-gateway`, then `my-gateway-2`, … and, as
* a last resort, a short random suffix. A name whose own slug is reserved or
* unusable is an explicit error rather than a silently mangled id.
*/
function generateId(displayName, taken) {
	const base = slugOf(displayName);
	if (!taken.has(base)) return base;
	for (let n = 2; n < 100; n += 1) {
		const candidate = `${base}-${n}`;
		if (!taken.has(candidate) && !RESERVED_IDS.has(candidate)) return candidate;
	}
	for (;;) {
		const candidate = `${base}-${randomBytes(4).toString("hex")}`;
		if (!taken.has(candidate) && !RESERVED_IDS.has(candidate)) return candidate;
	}
}
/**
* The file-backed managed-provider store. Every operation serializes through
* the document's advisory lock, so two tabs (or two processes) cannot lose
* each other's writes, and the revision check turns a loser into a 409
* instead of a silent overwrite.
*/
var WorkBuddyManagedProviderStore = class {
	path;
	dir;
	restrictCredentialDir;
	constructor(options = {}) {
		this.path = options.path ?? join(resolveBridgeHome(), "managed-providers", "providers.json");
		this.dir = join(this.path, "..");
		this.restrictCredentialDir = options.restrictCredentialDir ?? restrictDirToCurrentUser;
	}
	/** The document path, for diagnostics and tests. */
	filePath() {
		return this.path;
	}
	/**
	* The id a new provider with this display name would get, **without
	* persisting anything** — the staging step's dry run. `undefined` when the
	* name would generate an unusable or reserved id (the caller treats that
	* as a validation failure). Collision suffixes depend on what is already
	* stored, so a concurrent create can still change the final id; the commit
	* is authoritative.
	*/
	previewId(displayName) {
		if (!isNonemptyString(displayName)) return void 0;
		const base = slugOf(displayName);
		if (!SLUG_PATTERN.test(base) || RESERVED_IDS.has(base)) return void 0;
		return base;
	}
	/**
	* Create the credential directory with 0700 **before** the lock runs:
	* `withFileLock` makes its own recursive mkdir with default modes, so
	* letting it create the directory would leave a 0755 credential directory
	* behind. chmod after mkdir repairs a directory an older version created
	* wide; the Windows seam runs in the same place. A failed ACL pass fails
	* closed — the caller refuses to write a credential into a directory whose
	* protection could not be verified.
	*/
	async ensurePrivateDir() {
		const { mkdir, chmod } = await import("node:fs/promises");
		await mkdir(this.dir, {
			recursive: true,
			mode: 448
		});
		if (process.platform !== "win32") try {
			await chmod(this.dir, 448);
		} catch {
			throw new ProviderManagementError(500, "the credential directory could not be locked down to 0700; refusing to store a key");
		}
		try {
			await this.restrictCredentialDir(this.dir);
		} catch (error) {
			throw new ProviderManagementError(500, "the credential directory could not be restricted to the current user; refusing to store a key");
		}
	}
	async list() {
		await this.ensurePrivateDir();
		return await withFileLock(this.path, async () => {
			const document = await this.readUnderLock();
			return {
				revision: document.revision,
				providers: document.providers.map(viewOf)
			};
		});
	}
	/**
	* The full committed state under one lock: the metadata snapshot AND every
	* provider's captured credential, from the **same** document at the **same**
	* revision. The runtime consumes this so a configuration and its key can
	* never be assembled from two different commits (this process's or another
	* process's). Secrets live in the return value only — never in the public
	* projection, never in a log.
	*/
	async loadInternal() {
		await this.ensurePrivateDir();
		return await withFileLock(this.path, async () => {
			const document = await this.readUnderLock();
			return {
				metadata: {
					revision: document.revision,
					providers: document.providers.map(viewOf)
				},
				secrets: Object.fromEntries(document.providers.map((provider) => [provider.id, provider.apiKey]))
			};
		});
	}
	/**
	* The transactional save: validates and persists exactly like {@link save},
	* then returns the committed state (metadata + captured keys) from the same
	* document the commit wrote, under the same lock.
	*
	* `blockedIds` names ids the runtime already serves under other ownership
	* (external configured providers): the FINAL allocated id — collision
	* suffix included — may not take one, so a create can never shadow an
	* external endpoint.
	*/
	async saveInternal(input, options = {}) {
		const request = validateSave(input);
		await this.ensurePrivateDir();
		const blocked = new Set(options.blockedIds ?? []);
		const { metadata, secrets } = await this.withDocumentInternal(request.revision, async (document) => {
			if (request.id === void 0) {
				const id = generateId(request.displayName, new Set(document.providers.map((provider) => provider.id)));
				if (blocked.has(id)) throw new ProviderManagementError(400, "the new provider would collide with an external configured provider; choose another name");
				document.providers.push({
					id,
					displayName: request.displayName,
					baseUrl: request.baseUrl,
					models: request.models,
					authMode: request.authMode,
					...request.authMode === "api-key" && request.apiKey !== void 0 ? { apiKey: request.apiKey } : {}
				});
			} else {
				const index = document.providers.findIndex((candidate) => candidate.id === request.id);
				if (index === -1) throw new ProviderManagementError(404, "no stored provider with that id");
				const existing = document.providers[index];
				document.providers[index] = {
					id: existing.id,
					displayName: request.displayName,
					baseUrl: request.baseUrl,
					models: request.models,
					authMode: request.authMode,
					...request.authMode === "api-key" ? { apiKey: request.apiKey ?? existing.apiKey } : {}
				};
				if (document.providers[index].authMode === "api-key" && document.providers[index].apiKey === void 0) throw new ProviderManagementError(400, "the stored provider has no key to keep; supply an apiKey");
			}
			document.revision = newRevision();
			await writeFileInternal(this.path, document);
			return {
				metadata: {
					revision: document.revision,
					providers: document.providers.map(viewOf)
				},
				secrets: Object.fromEntries(document.providers.map((provider) => [provider.id, provider.apiKey]))
			};
		});
		return {
			metadata,
			secrets
		};
	}
	/** The public metadata-only save: a thin projection over the transaction. */
	async save(input) {
		return (await this.saveInternal(input)).metadata;
	}
	/** The transactional remove: same contract as {@link remove} with the internal return. */
	async removeInternal(input) {
		if (typeof input !== "object" || input === null || Array.isArray(input)) throw new ProviderManagementError(400, "remove payload must be a JSON object");
		const record = input;
		for (const key of Object.keys(record)) if (key !== "revision" && key !== "id") throw new ProviderManagementError(400, "remove payload contains an unknown field");
		if (!isNonemptyString(record["revision"])) throw new ProviderManagementError(400, "remove payload must carry the current revision");
		if (!isNonemptyString(record["id"])) throw new ProviderManagementError(400, "remove payload must carry the provider id");
		await this.ensurePrivateDir();
		const revision = record["revision"];
		const id = record["id"];
		return await this.withDocumentInternal(revision, async (document) => {
			const index = document.providers.findIndex((candidate) => candidate.id === id);
			if (index === -1) throw new ProviderManagementError(404, "no stored provider with that id");
			document.providers.splice(index, 1);
			document.revision = newRevision();
			await writeFileInternal(this.path, document);
			return {
				metadata: {
					revision: document.revision,
					providers: document.providers.map(viewOf)
				},
				secrets: Object.fromEntries(document.providers.map((provider) => [provider.id, provider.apiKey]))
			};
		});
	}
	/** The public metadata-only remove: a thin projection over the transaction. */
	async remove(input) {
		return (await this.removeInternal(input)).metadata;
	}
	/**
	* Load, mutate, and persist under one lock, checking the caller's revision
	* against the document just loaded — the cross-tab and cross-process guard.
	*/
	async withDocumentInternal(expectedRevision, mutate) {
		return await withFileLock(this.path, async () => {
			const document = await this.readUnderLock();
			if (document.revision !== expectedRevision) throw new ProviderManagementError(409, "the provider list changed elsewhere; reload and retry");
			return await mutate(document);
		});
	}
	/** Read and parse the document; a corrupt one fails safe. */
	async readUnderLock() {
		const { readFile } = await import("node:fs/promises");
		let text;
		try {
			text = await readFile(this.path, "utf8");
		} catch (error) {
			if (error.code === "ENOENT") return {
				version: 1,
				revision: ABSENT_REVISION,
				providers: []
			};
			throw new ProviderManagementError(500, "the managed provider document could not be read");
		}
		const parsed = parseDocument(text);
		if (parsed === void 0) throw new ProviderManagementError(500, "the managed provider document is corrupt; fix or remove it by hand");
		return parsed;
	}
};
/** Persist under the caller's lock; the caller assembles the answer. */
async function writeFileInternal(path, document) {
	await writeFileAtomic(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 384 });
}
/**
* The revision an absent document reports, fixed until the first write: two
* callers looking at the same empty store must agree it is "revision zero",
* or a create would race itself. Random tokens start with the first write.
*/
const ABSENT_REVISION = "absent";
/** A fresh opaque revision token. */
function newRevision() {
	return randomBytes(16).toString("base64url");
}
/** Parse an on-disk document; `undefined` when it is not one we trust. */
function parseDocument(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const document = parsed;
	for (const key of Object.keys(document)) if (key !== "version" && key !== "revision" && key !== "providers") return void 0;
	if (document["version"] !== 1) return void 0;
	if (!isNonemptyString(document["revision"])) return void 0;
	if (!Array.isArray(document["providers"])) return void 0;
	const providers = [];
	const seenIds = /* @__PURE__ */ new Set();
	for (const raw of document["providers"]) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return void 0;
		const entry = raw;
		for (const key of Object.keys(entry)) if (key !== "id" && key !== "displayName" && key !== "baseUrl" && key !== "models" && key !== "authMode" && key !== "apiKey") return;
		if (!isNonemptyString(entry["id"]) || !SLUG_PATTERN.test(entry["id"]) || RESERVED_IDS.has(entry["id"])) return;
		if (seenIds.has(entry["id"])) return void 0;
		seenIds.add(entry["id"]);
		if (!isNonemptyString(entry["displayName"])) return void 0;
		if (!isNonemptyString(entry["baseUrl"])) return void 0;
		const urlProbe = parseProviderConfig({
			version: 1,
			providers: [{
				id: "probe",
				baseUrl: entry["baseUrl"],
				models: ["probe"]
			}]
		});
		if (!urlProbe.ok) return void 0;
		if (!Array.isArray(entry["models"]) || entry["models"].length === 0 || entry["models"].some((model) => typeof model !== "string" || model.trim() === "")) return void 0;
		if (new Set(entry["models"]).size !== entry["models"].length) return void 0;
		const authMode = entry["authMode"];
		if (authMode !== "api-key" && authMode !== "none") return void 0;
		const apiKey = entry["apiKey"];
		if (authMode === "none" && apiKey !== void 0) return void 0;
		if (authMode === "api-key" && (typeof apiKey !== "string" || apiKey === "")) return void 0;
		providers.push({
			id: entry["id"],
			displayName: entry["displayName"],
			baseUrl: urlProbe.config.providers[0].baseUrl,
			models: [...entry["models"]],
			authMode,
			...typeof apiKey === "string" && apiKey !== "" ? { apiKey } : {}
		});
	}
	return {
		version: 1,
		revision: document["revision"],
		providers
	};
}
//#endregion
//#region src/standalone/ui.ts
/**
* The bridge's local web UI: a single self-contained page showing each
* endpoint's sign-in state, credit balance, and model list — plus, for a
* failover pool, one row per member with a button that proves whether that
* account can actually answer a turn.
*
* It follows the same trust model as the upstream plugin's status route
* (`src/dsh/web-status.ts`), which is the important part:
*
* - it binds loopback only, and
* - every request must name a loopback `Host` and, if a browser sent one, a
*   loopback `Origin`. The `Host` check is what defeats DNS rebinding, because
*   a rebinding page carries the attacker's domain in `Host`.
*
* Unlike the shim it does **not** require a bearer token. It cannot: a browser
* navigating to a URL cannot attach an `Authorization` header. The loopback
* pair above is therefore the whole boundary, which is exactly why the token
* is never placed in this document — a page that cannot be authenticated must
* not be able to read the secret that authenticates the other one.
*
* Probing is the one action this page can take, and it is the one that spends
* money, so it is gated separately: the page carries a per-process nonce that
* a `POST /api/pool/test` must repeat in a header. A cross-origin page cannot
* read the nonce (this server sends no CORS headers), and a custom header
* forces a preflight it will not pass, so "any local page can burn credits by
* posting to the UI port" is not a thing that can happen. The nonce is not a
* secret worth protecting — it authenticates nothing upstream — but it does
* bind the action to a document this server handed out.
*
* @module workbuddy-bridge/standalone/ui
*/
/**
* A request the caller got wrong, with the status to answer it with.
*
* Separate from an ordinary `Error` because "there is no pool at that
* provider" and "the upstream refused this account" are different answers: the
* first is a 404 the page should surface as a bug, the second is a 200 with
* `ok: false` and is the whole point of the feature.
*/
var UiRequestError = class extends Error {
	status;
	constructor(status, message) {
		super(message);
		this.status = status;
		this.name = "UiRequestError";
	}
};
/**
* Strip anything token-shaped before it crosses to the browser.
*
* Ported from the upstream status route. Every error string that reaches the
* page goes through this: an upstream failure can echo back request material,
* and a page with no authentication must not become a way to read a credential
* out of a diagnostic.
*/
function redactForBrowser(text) {
	return text.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]").slice(0, 500);
}
/**
* Apply {@link redactForBrowser} to every string field that can carry an error.
*
* Done as one pass over the finished document rather than at each throw site,
* so a future field cannot forget it: the choke point is the response, not the
* producer.
*/
function redactState(state) {
	return {
		...state,
		endpoints: state.endpoints.map((endpoint) => ({
			...endpoint,
			...endpoint.error === void 0 ? {} : { error: redactForBrowser(endpoint.error) },
			...endpoint.creditsError === void 0 ? {} : { creditsError: redactForBrowser(endpoint.creditsError) },
			...endpoint.pool === void 0 ? {} : { pool: {
				...endpoint.pool,
				members: endpoint.pool.members.map((member) => ({
					...member,
					...member.creditsError === void 0 ? {} : { creditsError: redactForBrowser(member.creditsError) },
					...member.lastOutcomeDetail === void 0 ? {} : { lastOutcomeDetail: redactForBrowser(member.lastOutcomeDetail) }
				}))
			} }
		}))
	};
}
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload),
		"Cache-Control": "no-store"
	});
	res.end(payload);
}
/**
* Host gate for every route: the Host header must name the loopback
* interface. A DNS-rebinding page carries its own domain in Host, so this is
* what defeats rebinding; the WSL forwarder rewrites Host to the loopback
* target, so forwarded requests pass here too.
*/
function hostGate(req) {
	return hostIsLoopback(req.headers.host);
}
/**
* Origin gate for page/state: absent (non-browser) or loopback passes as
* before; otherwise the Origin must exactly match one of the host-configured
* UI origins (the WSL forwarder URL). No arbitrary loopback port and no
* substring match — a sibling local server's port is not this UI.
*/
function pageOriginAllowed(req, allowedUiOrigins) {
	const origin = req.headers.origin;
	if (origin === void 0 || origin.trim() === "") return true;
	if (originIsLoopback(origin)) return true;
	return (allowedUiOrigins?.() ?? []).some((entry) => entry.trim() === origin.trim());
}
/**
* Origin gate for management routes: stricter than the page's. A browser
* Origin is only trusted when it exactly matches a host-configured UI origin;
* "merely loopback" is not enough, because any local page can send loopback
* origins and the nonce alone must not become the whole boundary for a route
* that stores credentials. An absent Origin (non-browser caller, or a page
* whose client sent no Origin) still passes — the nonce carries that request.
*/
function managementOriginAllowed(req, allowedUiOrigins) {
	const origin = req.headers.origin;
	if (origin === void 0 || origin.trim() === "") return true;
	return (allowedUiOrigins?.() ?? []).some((entry) => entry.trim() === origin.trim()) || entryMatchesSelf(req, origin);
}
/** The served loopback origin itself is always a trusted management origin. */
function entryMatchesSelf(req, origin) {
	const address = selfAddress(req);
	return address !== void 0 && origin.trim() === `http://127.0.0.1:${address}`;
}
function selfAddress(req) {
	const host = req.headers.host;
	if (host === void 0) return void 0;
	const { hostname, port } = new URL(`http://${host.trim()}`);
	return hostname === "127.0.0.1" && port !== "" ? Number(port) : void 0;
}
/** Largest probe body accepted; the page sends a provider name and an index. */
const PROBE_BODY_LIMIT = 8192;
/** Largest management body accepted; a provider description with model list. */
const MANAGEMENT_BODY_LIMIT = 65536;
/** Header the page repeats the nonce in. Custom, so it forces a preflight. */
const PROBE_HEADER = "x-bridge-ui";
/** Read a request body with a size cap. */
async function readBody(req, limit) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		size += buffer.length;
		if (size > limit) throw new UiRequestError(413, "request body too large");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}
/** Validate a probe body into a request, or answer with what is wrong. */
function parseProbeRequest(raw) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new UiRequestError(400, "body must be JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new UiRequestError(400, "body must be a JSON object");
	const record = parsed;
	const provider = record["provider"];
	const index = record["index"];
	const model = record["model"];
	if (typeof provider !== "string" || provider === "") throw new UiRequestError(400, "provider must be a non-empty string");
	if (typeof index !== "number" || !Number.isInteger(index) || index < 0) throw new UiRequestError(400, "index must be a non-negative integer");
	if (model !== void 0 && typeof model !== "string") throw new UiRequestError(400, "model must be a string when present");
	return {
		provider,
		index,
		...model === void 0 || model === "" ? {} : { model }
	};
}
/**
* Validate a management save body at the transport boundary.
*
* Field-level rules (URL shape, model syntax, reserved ids) belong to the
* manager — the store owns them and its errors carry precise messages. Here
* only the shape the route forwards is checked, and only enough that a
* non-object or a wrong-typed revision never reaches the manager. Unknown
* keys are passed through: rejecting them here would duplicate the manager's
* schema, and the manager already rejects what it does not know.
*/
function parseSaveBody(raw) {
	const record = parseManagementBody(raw);
	const requireNonEmptyString = (key) => {
		const value = record[key];
		if (typeof value !== "string" || value.trim() === "") throw new UiRequestError(400, `${key} must be a non-empty string`);
		return value;
	};
	requireNonEmptyString("displayName");
	requireNonEmptyString("baseUrl");
	const models = record["models"];
	if (!Array.isArray(models) || models.some((model) => typeof model !== "string" || model.trim() === "")) throw new UiRequestError(400, "models must be an array of non-empty strings");
	if (record["authMode"] !== "api-key" && record["authMode"] !== "none") throw new UiRequestError(400, "authMode must be \"api-key\" or \"none\"");
	const apiKey = record["apiKey"];
	if (apiKey !== void 0 && typeof apiKey !== "string") throw new UiRequestError(400, "apiKey must be a string when present");
	return record;
}
/**
* Validate a management body at the transport boundary: object with a
* non-empty string revision. Field-level rules (URL shape, model syntax,
* reserved ids) belong to the manager — the store owns them and its errors
* carry precise messages.
*/
function parseManagementBody(raw) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new UiRequestError(400, "body must be JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new UiRequestError(400, "body must be a JSON object");
	const record = parsed;
	if (typeof record["revision"] !== "string" || record["revision"] === "") throw new UiRequestError(400, "revision must be a non-empty string");
	return record;
}
function parseRemoveBody(raw) {
	const record = parseManagementBody(raw);
	const id = record["id"];
	if (typeof id !== "string" || id === "") throw new UiRequestError(400, "id must be a non-empty string");
	return {
		revision: record["revision"],
		id
	};
}
/**
* Start the UI server.
*
* Returns `ready` rather than awaiting the listen, so a caller can hold the
* handle before the port is known — the same shape the shim exposes.
*/
function createWorkBuddyUiServer(options) {
	const { state, probe, providers, allowedUiOrigins, logger } = options;
	const nonce = randomUUID();
	const page = PAGE.replace("\"__UI_NONCE__\"", JSON.stringify(nonce)).replace("\"__MANAGE__\"", JSON.stringify(providers !== void 0));
	const server = createServer((req, res) => {
		handle(req, res);
	});
	const ready = listenOnPreferredPort(server, options.port, "127.0.0.1");
	const url = () => {
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("workbuddy UI has no listening address");
		return `http://127.0.0.1:${address.port}`;
	};
	async function handle(req, res) {
		try {
			if (!hostGate(req)) {
				writeJson(res, 403, { error: "request-not-trusted" });
				return;
			}
			const path = (req.url ?? "/").split("?")[0];
			if (req.method === "GET") {
				if (path === "/" || path === "/index.html") {
					if (!pageOriginAllowed(req, allowedUiOrigins)) {
						writeJson(res, 403, { error: "request-not-trusted" });
						return;
					}
					res.writeHead(200, {
						"Content-Type": "text/html; charset=utf-8",
						"Content-Length": Buffer.byteLength(page),
						"Cache-Control": "no-store"
					});
					res.end(page);
					return;
				}
				if (path === "/api/state") {
					if (!pageOriginAllowed(req, allowedUiOrigins)) {
						writeJson(res, 403, { error: "request-not-trusted" });
						return;
					}
					writeJson(res, 200, redactState(await state()));
					return;
				}
				if (path === "/api/providers") {
					if (!managementGate(req, nonce)) {
						writeJson(res, 403, { error: "request-not-trusted" });
						return;
					}
					if (providers === void 0) {
						writeJson(res, 501, { error: "provider management is not available" });
						return;
					}
					writeJson(res, 200, await providers.list());
					return;
				}
				writeJson(res, 404, { error: `no such route: ${req.method} ${path}` });
				return;
			}
			if (req.method === "POST" && path === "/api/pool/test") {
				if (req.headers[PROBE_HEADER] !== nonce || !originIsLoopback(req.headers.origin)) {
					writeJson(res, 403, { error: "request-not-trusted" });
					return;
				}
				if (probe === void 0) {
					writeJson(res, 501, { error: "probing is not available" });
					return;
				}
				const type = req.headers["content-type"];
				if (typeof type !== "string" || !type.trim().toLowerCase().startsWith("application/json")) {
					writeJson(res, 415, { error: "Content-Type must be application/json" });
					return;
				}
				const request = parseProbeRequest(await readBody(req, PROBE_BODY_LIMIT));
				const result = await probe(request);
				writeJson(res, 200, {
					...result,
					detail: redactForBrowser(result.detail)
				});
				return;
			}
			if (req.method === "POST" && (path === "/api/providers/save" || path === "/api/providers/remove")) {
				if (!managementGate(req, nonce)) {
					writeJson(res, 403, { error: "request-not-trusted" });
					return;
				}
				if (providers === void 0) {
					writeJson(res, 501, { error: "provider management is not available" });
					return;
				}
				const type = req.headers["content-type"];
				if (typeof type !== "string" || !type.trim().toLowerCase().startsWith("application/json")) {
					writeJson(res, 415, { error: "Content-Type must be application/json" });
					return;
				}
				const raw = await readBody(req, MANAGEMENT_BODY_LIMIT);
				if (path === "/api/providers/save") writeJson(res, 200, await providers.save(parseSaveBody(raw)));
				else writeJson(res, 200, await providers.remove(parseRemoveBody(raw)));
				return;
			}
			writeJson(res, 405, { error: "method not allowed" });
		} catch (error) {
			if (error instanceof UiRequestError) {
				writeJson(res, error.status, { error: error.message });
				return;
			}
			if (isManagementRoute(req) && !res.headersSent) {
				if (error instanceof ProviderManagementError) {
					writeJson(res, error.status, { error: error.message });
					return;
				}
				writeJson(res, 500, { error: "provider management failed" });
				return;
			}
			logger?.warn("workbuddy-bridge: UI request failed", error);
			if (!res.headersSent) writeJson(res, 500, { error: "internal" });
			else res.end();
		}
	}
	/** Which paths are management, so their error handling is secrecy-first. */
	function isManagementRoute(req) {
		const path = (req.url ?? "/").split("?")[0];
		return req.method === "GET" && path === "/api/providers" || req.method === "POST" && (path === "/api/providers/save" || path === "/api/providers/remove");
	}
	/**
	* The management gate: the page nonce plus, when a browser sent an Origin,
	* an exact match against the host-configured UI origins (or this server's
	* own loopback origin). Merely-loopback origins are not management origins.
	*/
	function managementGate(req, expected) {
		if (req.headers[PROBE_HEADER] !== expected) return false;
		return managementOriginAllowed(req, allowedUiOrigins);
	}
	return {
		ready,
		url,
		close: () => new Promise((resolve, reject) => {
			server.close(() => {
				resolve();
			});
			server.closeAllConnections();
			server.once("error", reject);
		})
	};
}
/**
* The page itself.
*
* Deliberately self-contained: no CDN, no fonts, no build step. A page whose
* whole job is to report on a local bridge must work with the network down,
* and the host's CSP allowlist would not survive a redesign anyway.
*
* The client script uses string concatenation rather than template literals so
* this file needs no escaping gymnastics, and every value is passed through
* `esc()` — model names come from the upstream and are rendered as text.
*/
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WorkBuddy Bridge</title>
<style>
  :root {
    --bg: #16161a; --panel: #1e1e24; --panel-2: #26262e; --line: #33333d;
    --fg: #e8e8ee; --muted: #9a9aa8; --dim: #6f6f7d;
    --accent: #a89cf0; --ok: #5dcaa5; --warn: #ef9f27; --bad: #f09595;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f6f6f8; --panel: #ffffff; --panel-2: #f0f0f4; --line: #dcdce4;
      --fg: #1c1c22; --muted: #5c5c6a; --dim: #8a8a98;
      --accent: #534ab7; --ok: #0f6e56; --warn: #854f0b; --bad: #a32d2d;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  header {
    display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
    padding: 18px 24px; border-bottom: 1px solid var(--line);
  }
  h1 { font-size: 15px; font-weight: 500; margin: 0; }
  .spacer { flex: 1; }
  .muted { color: var(--muted); font-size: 12px; }
  .dim { color: var(--dim); font-size: 12px; }
  button {
    font: inherit; font-size: 12px; color: var(--fg); background: var(--panel-2);
    border: 1px solid var(--line); border-radius: 8px; padding: 5px 12px; cursor: pointer;
  }
  button:hover { border-color: var(--accent); }
  main { padding: 24px; display: flex; flex-direction: column; gap: 20px; max-width: 1100px; }
  .account-toggle-bar { display: flex; justify-content: center; padding: 4px 0; }
  .account-toggle { font: inherit; font-size: 12px; color: var(--muted); background: var(--panel-2);
    border: 1px solid var(--line); border-radius: 8px; padding: 6px 16px; cursor: pointer;
  }
  .account-toggle:hover { border-color: var(--accent); color: var(--fg); }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
  .connection { display: flex; gap: 16px; flex-wrap: wrap; padding: 10px 20px 14px; }
  .connection label { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 260px; }
  .connection .conn-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .connection input {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
    color: var(--fg); background: var(--panel-2); border: 1px solid var(--line);
    border-radius: 6px; padding: 5px 8px; width: 100%; box-sizing: border-box;
  }
  .connection input:focus { outline: none; border-color: var(--accent); }
  /* The head carries the title and the tab strip; the hairline under the strip
     is the border, so the two rows read as one unit rather than two blocks. */
  .card-head { padding: 16px 20px 0; border-bottom: 1px solid var(--line); }
  .card-title { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; padding-bottom: 12px; }
  .card-title h2 { font-size: 14px; font-weight: 500; margin: 0; }
  .tabs { display: flex; gap: 20px; }
  .tab {
    font: inherit; font-size: 12px; color: var(--muted); background: none;
    border: 0; border-bottom: 2px solid transparent; border-radius: 0;
    padding: 7px 0 9px; margin-bottom: -1px; cursor: pointer;
  }
  .tab:hover { color: var(--fg); border-bottom-color: var(--line); }
  .tab[aria-selected="true"] { color: var(--fg); border-bottom-color: var(--accent); }
  .tab .count { color: var(--dim); font-variant-numeric: tabular-nums; }
  .panel.hidden { display: none; }
  .meta { padding: 12px 20px 0; color: var(--dim); font-size: 12px; }
  .toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 20px 0; }
  .pill {
    font-size: 11px; padding: 2px 8px; border-radius: 999px;
    border: 1px solid var(--line); background: var(--panel-2); color: var(--muted);
  }
  .pill.ok { color: var(--ok); border-color: var(--ok); }
  .pill.bad { color: var(--bad); border-color: var(--bad); }
  .url { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--muted); }
  .notice { margin: 14px 20px 0; padding: 10px 12px; border-radius: 8px; font-size: 12px;
            background: var(--panel-2); border: 1px solid var(--line); color: var(--muted); }
  .notice.bad { color: var(--bad); }
  .credits { display: flex; gap: 28px; flex-wrap: wrap; padding: 14px 20px; }
  .credit-num { font-size: 22px; font-weight: 500; }
  .credit-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 8px 20px; border-top: 1px solid var(--line); font-size: 13px; }
  th { font-weight: 500; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  td.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .tag { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: var(--panel-2);
         border: 1px solid var(--line); color: var(--muted); margin-right: 4px; }
  .tag.free { color: var(--ok); border-color: var(--ok); }
  .yes { color: var(--ok); } .no { color: var(--dim); }
  button:disabled { opacity: .45; cursor: default; }
  button:disabled:hover { border-color: var(--line); }
  .pill.head { color: var(--accent); border-color: var(--accent); }
  .pill.warn { color: var(--warn); border-color: var(--warn); }
  .members td { vertical-align: top; }
  .members tr.head td { background: var(--panel-2); }
  /* One line per snippet: an upstream refusal can be a paragraph of repeated
     HTML text, and four wrapped lines in a status cell make the table
     unscannable. The untruncated string stays in the tooltip. */
  .members .sub { max-width: 34ch; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* A column of pills, left-aligned: without this the flex column stretches
     every pill to the column's width and the whole row reads as a bar chart. */
  .who { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; }
  .who .name { font-size: 13px; }
  .sub { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--dim);
         max-width: 30ch; overflow-wrap: anywhere; }
  .result { font-size: 12px; }
  .result.ok { color: var(--ok); }
  .result.bad { color: var(--bad); }
  .result .detail { color: var(--muted); font-size: 11px; display: block; margin-top: 2px;
                    max-width: 40ch; overflow-wrap: anywhere; }
  .model-pick {
    font: inherit; font-size: 12px; color: var(--fg); background: var(--panel-2);
    border: 1px solid var(--line); border-radius: 8px; padding: 4px 8px; max-width: 22ch;
  }
  /* Fixed layout so the columns line up down the table instead of being sized
     by whichever model name or error text happens to be longest. Widths are in
     px and total well under the card, so the leftover goes to the flexible
     columns rather than overflowing. */
  .requests { table-layout: fixed; }
  .requests td { vertical-align: middle; padding-top: 6px; padding-bottom: 6px; }
  .requests tbody tr:hover td { background: var(--panel-2); }
  .requests .col-time { width: 100px; }
  .requests .col-model { width: 210px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .requests .col-result { width: 160px; }
  .requests .col-took { width: 84px; }
  .requests .pill { margin-right: 6px; }
  .code { color: var(--dim); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
  .chip {
    display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 4px;
    border: 1px solid var(--line); background: var(--panel-2); color: var(--muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap;
  }
  .chip.ok { color: var(--ok); border-color: var(--ok); }
  .chip.bad { color: var(--bad); border-color: var(--bad); }
  .chip.warn { color: var(--warn); border-color: var(--warn); }
  .chip .code { color: inherit; opacity: .7; margin-left: 4px; }
  .arrow { color: var(--dim); margin: 0 6px; }
  /* --- provider management --- */
  .add-bar { display: flex; justify-content: flex-start; padding: 2px 0; }
  .dialog-backdrop {
    position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 20;
    display: flex; align-items: center; justify-content: center; padding: 24px;
  }
  /* A hidden attribute alone is not enough here: the author display:flex rule
     above beats the UA stylesheet's [hidden] rule, and both dialogs would sit
     open over the page from the first paint, blocking every click below them. */
  .dialog-backdrop[hidden] { display: none; }
  .dialog {
    background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
    width: 520px; max-width: 100%; max-height: 90vh; overflow: auto; padding: 20px;
    box-shadow: 0 12px 40px rgba(0,0,0,.4);
  }
  .dialog h2 { font-size: 14px; font-weight: 500; margin: 0 0 12px; }
  .dialog .field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
  .dialog .field > span { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .dialog .field .hint { font-size: 11px; color: var(--dim); text-transform: none; letter-spacing: 0; }
  .dialog input, .dialog textarea {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
    color: var(--fg); background: var(--panel-2); border: 1px solid var(--line);
    border-radius: 6px; padding: 6px 8px; width: 100%; box-sizing: border-box;
  }
  .dialog textarea { font-family: inherit; min-height: 90px; resize: vertical; }
  .dialog input:focus, .dialog textarea:focus { outline: none; border-color: var(--accent); }
  .dialog .radio-row { display: flex; gap: 16px; align-items: center; }
  .dialog .radio-row label { display: flex; gap: 6px; align-items: center; font-size: 13px; color: var(--fg); }
  .dialog .error-line { color: var(--bad); font-size: 12px; margin: 0 0 10px; min-height: 1em;
                        overflow-wrap: anywhere; }
  .dialog .buttons { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
  .dialog .buttons .primary { color: var(--bg); background: var(--accent); border-color: var(--accent); }
  .dialog .buttons .danger { color: var(--bg); background: var(--bad); border-color: var(--bad); }
  .dialog .confirm-text { font-size: 13px; color: var(--fg); margin: 0 0 6px; overflow-wrap: anywhere; }
  .dialog .confirm-sub { font-size: 12px; color: var(--muted); margin: 0 0 10px; overflow-wrap: anywhere; }
  /* A persistent publication warning, fixed above everything so it survives
     the #app poll rewrite and stays visible over cards and dialogs alike. */
  #provider-warning {
    position: sticky; top: 0; z-index: 10; display: none;
    padding: 10px 24px; font-size: 12px; color: var(--warn);
    background: var(--panel-2); border-bottom: 1px solid var(--warn);
    overflow-wrap: anywhere;
  }
  #provider-warning.active { display: block; }
  .dialog p { overflow-wrap: anywhere; }
  footer { padding: 0 24px 32px; }
</style>
</head>
<body>
<header>
  <h1>WorkBuddy Bridge</h1>
  <span class="muted" id="version"></span>
  <span class="spacer"></span>
  <span class="dim" id="updated"></span>
  <button id="refresh">Refresh</button>
  <button id="add-provider" hidden>Add provider</button>
</header>
<!-- Publication warning: lives outside #app so the poll rewrite can never
     drop it, and the text is a host-owned safe status string, never error
     detail. Rendered via textContent by the poll's render() pass. -->
<div id="provider-warning" role="alert"></div>
<main id="app"></main>
<footer><p class="dim" id="pool-note"></p></footer>
<!-- The editor and its confirmation live outside #app on purpose: the 5s poll
     rewrites #app's innerHTML, and a dialog whose DOM was rebuilt under the
     user would drop the sentence being typed. -->
<div id="editor-backdrop" class="dialog-backdrop" hidden>
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="editor-title">
    <h2 id="editor-title"></h2>
    <div class="error-line" id="editor-error" role="alert"></div>
    <label class="field"><span>Name</span>
      <input id="editor-name" type="text" autocomplete="off" spellcheck="false">
    </label>
    <label class="field"><span>API base URL</span>
      <input id="editor-baseurl" type="text" autocomplete="off" spellcheck="false"
             placeholder="https://api.example.com/v1">
    </label>
    <label class="field"><span>API key</span>
      <span class="hint" id="editor-key-hint"></span>
      <input id="editor-key" type="password" autocomplete="new-password" spellcheck="false">
    </label>
    <div class="field"><span>Models (one per line)</span>
      <textarea id="editor-models" spellcheck="false" aria-label="Models, one per line"></textarea>
    </div>
    <fieldset class="field" style="border:0;padding:0;margin:0 0 12px;">
      <legend style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;padding:0;">Authentication</legend>
      <div class="radio-row">
        <label><input type="radio" name="editor-authmode" id="editor-auth-key" value="api-key"> API key</label>
        <label><input type="radio" name="editor-authmode" id="editor-auth-none" value="none"> No authentication</label>
      </div>
    </fieldset>
    <div class="buttons">
      <button id="editor-cancel">Cancel</button>
      <button id="editor-save" class="primary">Save</button>
    </div>
  </div>
</div>
<div id="remove-backdrop" class="dialog-backdrop" hidden>
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="remove-title">
    <h2 id="remove-title">Remove provider</h2>
    <div class="error-line" id="remove-error" role="alert"></div>
    <p class="confirm-text" id="remove-text"></p>
    <p class="confirm-sub">Active requests through this provider stop. Its entry and saved key are deleted;
       add it again if you change your mind.</p>
    <div class="buttons">
      <button id="remove-cancel">Cancel</button>
      <button id="remove-confirm" class="danger">Remove</button>
    </div>
  </div>
</div>
<script>
var UI_NONCE = "__UI_NONCE__";
var MANAGE = "__MANAGE__";
function esc(v) {
  return String(v).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function fmtNum(n) {
  return typeof n === 'number' ? n.toLocaleString('en-US') : String(n);
}
function fmtTime(ms) {
  if (typeof ms !== 'number' || ms <= 0) return '';
  var d = new Date(ms);
  return d.toLocaleString();
}
function fmtClock(ms) {
  if (typeof ms !== 'number' || ms <= 0) return '';
  /* 24-hour and zero-padded: a log column should be a constant width and
     scannable down the seconds, which "8:06:46 AM" is not. */
  return new Date(ms).toLocaleTimeString(undefined, { hour12: false });
}
function fmtLatency(ms) {
  if (typeof ms !== 'number' || ms < 0) return '';
  /* Sub-second turns are the common case here, and "0.1s" hides whether that
     was 60 ms or 140 ms. */
  return ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(2) + ' s';
}
/* Upstream refusals are sometimes a whole HTML page (an openresty 401). The
   row is for reading, so markup and runs of whitespace go and the words stay;
   the untruncated original is still in the tooltip. */
function plain(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/<[^>]*>/g, ' ')
    /* A diagnostic string is often cut mid-tag before it gets here, so the
       unterminated tail needs removing too — otherwise "<p" survives as text. */
    .replace(/<[^>]*$/, ' ')
    .replace(/\\s+/g, ' ')
    .trim();
}
/* A diagnostic notice, readable: plain text, a bounded prefix, raw in the title. */
function noticeOf(text, bad) {
  return '<div class="notice' + (bad ? ' bad' : '') + '" title="' + esc(text) + '">'
    + esc(clip(plain(text), 240)) + '</div>';
}
/* Upstream refusals can be a wall of HTML; the row shows a readable prefix and
   keeps the whole thing in the title attribute. */
function clip(text, max) {
  var s = String(text === undefined || text === null ? '' : text);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
function creditsBlock(ep) {
  var html = '';
  if (ep.creditsError) {
    return noticeOf('Could not read credits: ' + ep.creditsError, true);
  }
  if (!ep.credits) return '';
  var c = ep.credits;
  html += '<div class="credits">';
  html += '<div><div class="credit-num">' + (c.unlimited ? 'Unlimited' : fmtNum(c.total)) + '</div>'
        + '<div class="credit-label">' + (c.unlimited ? 'quota' : 'credits remaining') + '</div></div>';
  if (c.cycleResetTime) {
    html += '<div><div class="credit-num">' + esc(c.cycleResetTime) + '</div>'
          + '<div class="credit-label">cycle reset</div></div>';
  }
  html += '</div>';
  if (c.accounts && c.accounts.length) {
    html += '<table><thead><tr><th>Package</th><th class="num">Remaining</th><th class="num">Size</th><th>Ends</th></tr></thead><tbody>';
    for (var i = 0; i < c.accounts.length; i++) {
      var a = c.accounts[i];
      html += '<tr><td>' + esc(a.packageName) + '</td>'
            + '<td class="num">' + (a.unlimited ? 'Unlimited' : fmtNum(a.remain)) + '</td>'
            + '<td class="num">' + (a.unlimited ? '' : fmtNum(a.size)) + '</td>'
            + '<td class="dim">' + esc(fmtTime(a.endTimeMs)) + '</td></tr>';
    }
    html += '</tbody></table>';
  }
  return html;
}
function modelsTable(models, generic) {
  if (generic) {
    if (!models.length) return '<div class="notice">No models. Set the configured API key environment variable.</div>';
    var configured = '<table><thead><tr><th>Configured model ID</th></tr></thead><tbody>';
    for (var c = 0; c < models.length; c++) configured += '<tr><td class="mono">' + esc(models[c].id) + '</td></tr>';
    return configured + '</tbody></table>';
  }
  if (!models.length) {
    return '<div class="notice">No models. This product has no usable credential, so the list is empty by design rather than broken.</div>';
  }
  var html = '<table><thead><tr><th>Model</th><th>Id</th><th class="num">Rate</th>'
           + '<th class="num">Context</th><th class="num">Max out</th><th>Images</th><th>Notes</th></tr></thead><tbody>';
  for (var i = 0; i < models.length; i++) {
    var m = models[i];
    var tags = '';
    if (m.free) tags += '<span class="tag free">free</span>';
    if (m.rateUnknown) tags += '<span class="tag">price needs refresh</span>';
    if (m.badges) for (var b = 0; b < m.badges.length; b++) tags += '<span class="tag">' + esc(m.badges[b]) + '</span>';
    if (m.reasoning && m.reasoning.supports) {
      var eff = m.reasoning.efforts && m.reasoning.efforts.length ? m.reasoning.efforts.join('/') : 'default';
      tags += '<span class="tag">reasoning: ' + esc(eff) + '</span>';
    }
    var ctx = m.contextWindow ? fmtNum(m.contextWindow) : '';
    if (m.maxContextWindow && m.maxContextWindow > (m.contextWindow || 0)) {
      ctx = fmtNum(m.contextWindow) + ' <span class="dim">(max ' + fmtNum(m.maxContextWindow) + ')</span>';
    }
    html += '<tr>'
          + '<td>' + esc(m.name) + '</td>'
          + '<td class="mono">' + esc(m.id) + '</td>'
          + '<td class="num">' + esc(m.credits || '') + '</td>'
          + '<td class="num">' + ctx + '</td>'
          + '<td class="num">' + (m.maxTokens ? fmtNum(m.maxTokens) : '') + '</td>'
          + '<td class="' + (m.supportsImages ? 'yes' : 'no') + '">' + (m.supportsImages ? 'yes' : 'no') + '</td>'
          + '<td>' + tags + '</td>'
          + '</tr>';
  }
  return html + '</tbody></table>';
}
/* Per-member test results, keyed provider#index. Kept outside the rendered
   DOM so the 5s poll cannot wipe a result the user is still reading. */
var tests = {};
var lastState = null;
function testKey(provider, index) { return provider + '#' + index; }
function testOf(provider, index) { return tests[testKey(provider, index)]; }
function memberLabel(pool, index) {
  var m = pool.members[index];
  return m ? m.label : 'account ' + (index + 1);
}
function creditsCell(m) {
  if (m.credits) return m.credits.unlimited ? 'Unlimited' : fmtNum(m.credits.total);
  if (m.creditsError) {
    return '<span class="no" title="' + esc(m.creditsError) + '">error</span>';
  }
  return '<span class="no">—</span>';
}
function attemptCell(m) {
  if (m.lastOutcome === undefined) return '<span class="no">no routed traffic yet</span>';
  var when = m.lastAttemptAtMs ? fmtTime(m.lastAttemptAtMs) : '';
  var pill = m.lastOutcome === 'ok'
    ? '<span class="pill ok">ok</span>'
    : '<span class="pill bad">' + esc(m.lastOutcome === 'credential-error' ? 'credential' : 'upstream') + '</span>';
  var detail = m.lastOutcomeDetail
    ? '<span class="sub" title="' + esc(m.lastOutcomeDetail) + '">' + esc(clip(plain(m.lastOutcomeDetail), 90)) + '</span>'
    : '';
  return '<div class="who">' + pill + '<span class="sub">' + esc(when) + '</span>' + detail + '</div>';
}
function resultCell(provider, index) {
  var t = testOf(provider, index);
  if (t === undefined) return '';
  if (t.running) return '<span class="result">testing…</span>';
  var cls = t.ok ? 'ok' : 'bad';
  var head = t.ok
    ? 'pass · ' + (typeof t.latencyMs === 'number' ? (t.latencyMs / 1000).toFixed(1) + 's' : '')
    : 'fail';
  return '<span class="result ' + cls + '">' + head
    + '<span class="detail" title="' + esc((t.model ? t.model + ' · ' : '') + (t.detail || '')) + '">'
    + esc(clip(plain(t.detail), 140)) + '</span></span>';
}
/*
 * Which model a test asks for. Kept outside the DOM for the same reason as the
 * results: the 5s re-render rebuilds the select, and losing the choice between
 * polls would make "test bob on this model" impossible to hold still.
 * An empty value means "whatever this account lists first", which is the only
 * default that cannot be wrong for an account whose roster differs.
 */
var chosenModels = {};
function modelPicker(ep) {
  if (!ep.models || !ep.models.length) return '';
  var chosen = chosenModels[ep.provider] || '';
  var html = '<select class="model-pick" data-model-provider="' + esc(ep.provider) + '">'
    + '<option value="">default model</option>';
  for (var i = 0; i < ep.models.length; i++) {
    var id = ep.models[i].id;
    html += '<option value="' + esc(id) + '"' + (id === chosen ? ' selected' : '') + '>' + esc(id) + '</option>';
  }
  return html + '</select>';
}
function poolBlock(ep) {
  var p = ep.pool;
  if (!p || !p.members || !p.members.length) return '';
  var providers = p.kind === 'providers';
  var html = '<div class="notice">One endpoint over ' + p.members.length + (providers ? ' providers' : ' accounts')
    + '. The next request is answered by '
    + '<strong>' + esc(memberLabel(p, p.headIndex)) + '</strong>. A test runs against that '
    + (providers ? 'provider' : 'account') + ' only — it does not move the head.</div>';
  /* The test controls live here rather than in the card head: they act on the
     member table below them, and a header control that does nothing on the
     Models tab would be a dead button. */
  html += '<div class="toolbar">' + modelPicker(ep)
    + '<button class="test-all" data-test-all="' + esc(ep.provider) + '">Test all</button></div>';
  html += '<table class="members"><thead><tr><th>' + (providers ? 'Provider' : 'Account') + '</th><th>State</th>'
        + '<th class="num">Credits</th><th>Last routed turn</th><th>Test</th>'
        + (providers ? '<th>Manage</th>' : '') + '</tr></thead><tbody>';
  for (var i = 0; i < p.members.length; i++) {
    var m = p.members[i];
    var t = testOf(ep.provider, m.index);
    var busy = t !== undefined && t.running;
    var state = '<div class="who">'
      + '<span class="pill ' + (m.signedIn ? 'ok' : 'bad') + '">'
      + (m.signedIn ? (providers ? 'ready' : 'signed in') : (providers ? 'no key' : 'signed out')) + '</span>';
    if (m.head) {
      state += m.signedIn
        ? '<span class="pill head">next</span>'
        : '<span class="pill warn">next · ' + (providers ? 'no key' : 'signed out') + '</span>';
    }
    if (m.consecutiveFailures > 0) {
      state += '<span class="pill bad">' + m.consecutiveFailures + ' fail in a row</span>';
    }
    state += '<span class="sub">' + fmtNum(m.successes) + ' ok / ' + fmtNum(m.failures) + ' failed</span></div>';
    html += '<tr' + (m.head ? ' class="head"' : '') + '>'
          + '<td><div class="who"><span class="name">' + esc(m.label) + '</span>'
          + (m.uid ? '<span class="sub">' + esc(m.uid) + '</span>' : '')
          + '</div></td>'
          + '<td>' + state + '</td>'
          + '<td class="num">' + (providers ? '<span class="no">—</span>' : creditsCell(m)) + '</td>'
          + '<td>' + attemptCell(m) + '</td>'
          + '<td><button class="test" data-test-provider="' + esc(ep.provider) + '" data-test-index="' + m.index + '"'
          + (busy ? ' disabled' : '') + '>' + (busy ? 'testing…' : 'Test') + '</button>'
          + resultCell(ep.provider, m.index) + '</td>'
          + (providers ? '<td>' + manageCell(m) + '</td>' : '')
          + '</tr>';
  }
  return html + '</tbody></table>';
}
/* A pool row that is also a provider card gets the same controls here, so a
   provider can be edited from the pool it belongs to as well as from its own
   card. An externally configured provider has no entry to edit, so it gets the
   same read-only note its card carries. */
function manageCell(m) {
  if (m.editId) {
    return '<button data-edit-provider="' + esc(m.editId) + '">Edit</button> '
      + '<button data-remove-provider="' + esc(m.editId) + '">Remove</button>';
  }
  return '<span class="pill">externally configured · read-only</span>';
}
/* One member's attempt, as a chip. The class carries the verdict so the chain
   reads at a glance: green answered, red refused, amber could not sign in. */
function attemptChip(at) {
  var ok = at.outcome === 'ok';
  var label = ok ? 'ok' : (at.outcome === 'credential-error' ? 'no credential' : at.outcome);
  var cls = ok ? 'ok' : (at.outcome === 'credential-error' ? 'warn' : 'bad');
  var code = !ok && at.status ? '<span class="code">' + esc(String(at.status)) + '</span>' : '';
  return '<span class="chip ' + cls + '">' + esc(at.account) + ' ' + esc(label) + code + '</span>';
}
function attemptsCell(row) {
  var list = row.attempts || [];
  if (!list.length) return '<span class="no">—</span>';
  var parts = [];
  for (var i = 0; i < list.length; i++) parts.push(attemptChip(list[i]));
  return parts.join('<span class="arrow">\u2192</span>');
}
function requestsTable(ep) {
  var rows = ep.requests || [];
  if (!rows.length) {
    return '<div class="notice">No requests yet. This log is metadata only — model, account, '
      + 'outcome, timing — and lives in memory.</div>';
  }
  /* A pool row answers a different question than an account row, so the table
     has one extra column for it: what the router tried, in order. The account
     is not a column anywhere — the card's own title already names it. */
  var pooled = ep.pool !== undefined;
  var html = '<table class="requests"><thead><tr>'
    + '<th class="col-time">Time</th>'
    + '<th class="col-model">Model</th>'
    + (pooled ? '<th class="col-tried">Tried</th>' : '')
    + '<th class="col-result">Result</th>'
    + '<th class="col-took num">Took</th>'
    + '</tr></thead><tbody>';
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var ok = r.outcome === 'ok';
    var result = '<span class="pill ' + (ok ? 'ok' : 'bad') + '">' + esc(ok ? 'ok' : r.outcome) + '</span>'
      + (ok ? '' : '<span class="code">' + esc(String(r.status)) + '</span>');
    html += '<tr>'
      + '<td class="col-time mono">' + esc(fmtClock(r.atMs)) + '</td>'
      + '<td class="col-model mono" title="' + esc(r.model) + '">' + esc(r.model) + '</td>'
      + (pooled ? '<td class="col-tried">' + attemptsCell(r) + '</td>' : '')
      + '<td class="col-result">' + result + '</td>'
      + '<td class="col-took num mono">' + esc(fmtLatency(r.latencyMs)) + '</td>'
      + '</tr>';
  }
  return html + '</tbody></table>';
}
/*
 * Three sections per endpoint, one visible at a time: Account (who is signed
 * in, what is left, and for a pool who answers next), Models, and Logs.
 *
 * The choice is kept outside the DOM for the same reason as the test results:
 * the 5s poll rebuilds the card, and a tab that jumped back to Account on
 * every refresh would be unusable.
 */
var activeTabs = Object.create(null);
function tabOf(provider) { return activeTabs[provider] || 'account'; }
function tabStrip(ep) {
  var active = tabOf(ep.provider);
  var providerPool = ep.pool !== undefined && ep.pool.kind === 'providers';
  var tabs = [
    {
      id: 'account',
      label: providerPool ? 'Providers' : 'Account'
    },
    { id: 'models', label: 'Models', count: (ep.models || []).length },
    { id: 'logs', label: 'Logs', count: (ep.requests || []).length }
  ];
  var html = '<div class="tabs" role="tablist">';
  for (var i = 0; i < tabs.length; i++) {
    var tab = tabs[i];
    html += '<button class="tab" role="tab" data-tab="' + tab.id + '"'
      + ' aria-selected="' + (tab.id === active ? 'true' : 'false') + '">'
      + esc(tab.label)
      + (tab.count === undefined ? '' : ' <span class="count">' + fmtNum(tab.count) + '</span>')
      + '</button>';
  }
  return html + '</div>';
}
function panel(name, active, inner) {
  return '<div class="panel' + (name === active ? '' : ' hidden') + '"'
    + ' data-panel="' + name + '" role="tabpanel">' + inner + '</div>';
}
function accountPanel(ep) {
  if (ep.pool && ep.pool.kind === 'providers') {
    var providerNotice = 'One endpoint over ' + ep.pool.members.length + ' custom providers with failover. '
      + 'A request goes to the provider that offers its model; when that provider refuses in a way another '
      + 'could survive, the next one is tried. Models come from the saved configurations and changes are live at once. '
      + 'The Local bridge API key above is the local bridge token, not any upstream key.';
    return (ep.error ? noticeOf(ep.error, true) : '') + '<div class="notice">' + providerNotice + '</div>' + poolBlock(ep);
  }
  var html = '';
  var meta = [];
  if (ep.catalogSource) meta.push('catalog: ' + ep.catalogSource);
  if (ep.catalogFetchedAtMs) meta.push('fetched ' + fmtTime(ep.catalogFetchedAtMs));
  if (meta.length) html += '<div class="meta">' + esc(meta.join('  ·  ')) + '</div>';
  if (ep.error) html += noticeOf(ep.error, true);
  html += poolBlock(ep);
  return html;
}
function renderCard(ep) {
  var active = tabOf(ep.provider);
  var providerPool = ep.pool !== undefined && ep.pool.kind === 'providers';
  var html = '<section class="card" data-provider="' + esc(ep.provider) + '">';
  html += '<div class="card-head"><div class="card-title">';
  html += '<h2>' + esc(ep.displayName) + '</h2>';
  var status = providerPool
    ? (ep.signedIn ? 'configured' : 'no usable key')
    : (ep.signedIn ? 'signed in' : 'signed out');
  var generic = providerPool;
  html += '<span class="pill ' + (ep.signedIn ? 'ok' : 'bad') + '">' + status + '</span>';
  if (ep.nickname) html += '<span class="pill">' + esc(ep.nickname) + '</span>';
  if (ep.domain) html += '<span class="pill">' + esc(ep.domain) + '</span>';
  /* Every card is a pool card now, so the card-level Edit/Remove buttons go:
     the provider pool's members are edited from the table below, and an
     account pool is managed from the WorkBuddy app, not this page. */
  html += '</div>';
  if (ep.baseUrl || ep.token) {
    html += '<div class="connection">';
    if (ep.baseUrl) {
      html += '<label><span class="conn-label">Base URL</span>'
        + '<input readonly value="' + esc(ep.baseUrl) + '" onclick="this.select()"></label>';
    }
    if (ep.wslBaseUrl) {
      html += '<label><span class="conn-label">WSL URL</span>'
        + '<input readonly value="' + esc(ep.wslBaseUrl) + '" onclick="this.select()"></label>';
    }
    if (ep.token) {
      /* "Local bridge API key", not just "API Key": the editor below also has
         an API-key field for the upstream credential, and the two must not be
         mistakable for each other. */
      html += '<label><span class="conn-label">Local bridge API key</span>'
        + '<input readonly value="' + esc(ep.token) + '" onclick="this.select()"></label>';
    }
    html += '</div>';
  }
  html += tabStrip(ep);
  html += '</div>';
  html += panel('account', active, accountPanel(ep));
  html += panel('models', active, modelsTable(ep.models || [], generic));
  html += panel('logs', active, requestsTable(ep));
  html += '</section>';
  return html;
}
function render(state) {
  lastState = state;
  /* The publication warning is host-owned text (a fixed safe status string,
     never error detail) set on the state document after a mutation whose
     publication failed, and cleared when publication later succeeds. It is
     set via textContent outside #app, so it persists across polls. */
  var banner = document.getElementById('provider-warning');
  if (state.providerWarning) {
    banner.textContent = state.providerWarning;
    banner.className = 'active';
  } else {
    banner.textContent = '';
    banner.className = '';
  }
  var poolEndpoints = (state.endpoints || []).filter(function (ep) { return ep.pool !== undefined; });
  var providerPoolShown = poolEndpoints.some(function (ep) { return ep.pool.kind === 'providers'; });
  var accountPoolShown = poolEndpoints.some(function (ep) { return ep.pool.kind !== 'providers'; });
  document.getElementById('pool-note').textContent = providerPoolShown
    ? "A test sends one real chat turn through that provider's own upstream — it spends a few credits there and does not move the pool's head."
    : accountPoolShown
      ? "A test sends one real chat turn through that account's own upstream path — it spends a few credits and does not move the pool's head."
      : '';
  document.getElementById('version').textContent = 'v' + (state.version === 1 ? '1' : '?');
  document.getElementById('updated').textContent = 'updated ' + new Date(state.nowMs).toLocaleTimeString();
  document.getElementById('add-provider').hidden = !MANAGE;
  var app = document.getElementById('app');
  if (!state.endpoints || !state.endpoints.length) {
    app.innerHTML = '<div class="notice">' + (MANAGE
      ? 'No endpoints are being served. Add a provider to serve one.'
      : 'No endpoints are being served.') + '</div>';
    return;
  }
  /* Every card is a pool card. The custom-provider pool comes first: it is
     the endpoint an agent should use when several providers exist, so it must
     not sit below the other cards. */
  var pools = (state.endpoints || []).slice();
  pools.sort(function (a, b) {
    return (b.pool && b.pool.kind === 'providers' ? 1 : 0) - (a.pool && a.pool.kind === 'providers' ? 1 : 0);
  });
  var html = '';
  for (var p = 0; p < pools.length; p++) html += renderCard(pools[p]);
  app.innerHTML = html;
}

/*
 * Run one probe. The "done" callback lets "Test all" chain the accounts one at
 * a time — serial on purpose: firing every account at once would spend several
 * turns of quota to answer a question one turn at a time answers better, and a
 * burst from one machine across several identities is exactly the pattern the
 * pool's own notes warn about.
 */
function runTest(provider, index, done) {
  var key = testKey(provider, index);
  var body = { provider: provider, index: index };
  var chosen = chosenModels[provider];
  if (chosen) body.model = chosen;
  tests[key] = { running: true };
  if (lastState) render(lastState);
  fetch('/api/pool/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bridge-Ui': UI_NONCE },
    body: JSON.stringify(body)
  })
    .then(function (r) {
      return r.json().then(function (body) { return { status: r.status, body: body }; });
    })
    .then(function (res) {
      tests[key] = res.status === 200
        ? res.body
        : { ok: false, detail: (res.body && res.body.error) || ('HTTP ' + res.status) };
    })
    .catch(function (e) {
      tests[key] = { ok: false, detail: e.message };
    })
    .then(function () {
      tests[key].running = false;
      if (lastState) render(lastState);
      // A passing test just spent a credit: re-read the state so the row's
      // balance is not stale for up to five seconds.
      load();
      if (done) done();
    });
}
function runAll(provider) {
  var ep = null;
  if (lastState && lastState.endpoints) {
    for (var i = 0; i < lastState.endpoints.length; i++) {
      if (lastState.endpoints[i].provider === provider) ep = lastState.endpoints[i];
    }
  }
  if (!ep || !ep.pool) return;
  var queue = ep.pool.members.map(function (m) { return m.index; });
  function step() {
    if (!queue.length) return;
    runTest(provider, queue.shift(), step);
  }
  step();
}
document.getElementById('app').addEventListener('click', function (event) {
  /* "closest", not event.target directly: a tab's label carries a count span,
     and clicking the number must switch the tab like clicking the word. */
  var button = event.target && event.target.closest ? event.target.closest('button') : null;
  if (!button) return;
  /* A tab switch is a class toggle rather than a re-render: it keeps the
     scroll position, and it cannot race the 5s poll into showing the wrong
     panel. The choice is recorded so the next poll rebuilds it open. */
  if (button.dataset.tab !== undefined) {
    var card = button.closest('.card');
    if (!card) return;
    activeTabs[card.getAttribute('data-provider') || ''] = button.dataset.tab;
    var tabs = card.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].setAttribute('aria-selected', tabs[i] === button ? 'true' : 'false');
    }
    var panels = card.querySelectorAll('.panel');
    for (var p = 0; p < panels.length; p++) {
      panels[p].classList.toggle('hidden', panels[p].getAttribute('data-panel') !== button.dataset.tab);
    }
    return;
  }
  if (button.dataset.testProvider !== undefined) {
    runTest(button.dataset.testProvider, Number(button.dataset.testIndex));
    return;
  }
  if (button.dataset.testAll !== undefined) runAll(button.dataset.testAll);
  /* Managed cards: Edit prefills the editor, Remove opens its confirmation. */
  if (button.dataset.editProvider !== undefined) openEditor(button.dataset.editProvider);
  if (button.dataset.removeProvider !== undefined) openRemove(button.dataset.removeProvider);
});
document.getElementById('app').addEventListener('change', function (event) {
  var target = event.target;
  if (target && target.dataset && target.dataset.modelProvider !== undefined) {
    chosenModels[target.dataset.modelProvider] = target.value;
  }
});

/* ------------------------------------------------------------------ *
 * Provider management. Everything here lives OUTSIDE #app: the editor *
 * and its confirmation are fixed DOM, so the 5s poll can never rebuild *
 * them under a sentence being typed. The key field is a password input *
 * that is only read into a request body — never into render strings,  *
 * state objects, or storage — and a close/cancel clears it.           *
 * ------------------------------------------------------------------ */
/* Managed ids, from /api/providers. The state document stays metadata-only
   about management: cards look it up here rather than carrying it. */
var managedIds = {};
var providersList = {};
var providerRevision = null;
/* The revision each open dialog acts on, pinned when the dialog opens. The
   5s poll keeps adopting newer snapshots, but a dialog the user has already
   based edits on must not silently ride them: a save that ships a stale
   revision would overwrite whatever changed between open and save (the
   reviewer's r1-editor / r2-poll scenario). A conflict therefore fails and
   asks for a reopen; it never auto-adopts. */
var editorRevision = null;
var removalRevision = null;
var lastFocus = null;
var removeTarget = null;
var editingId = null;
function editorEl(id) { return document.getElementById(id); }

function openEditor(id) {
  editingId = id || null;
  var p = id ? providersList[id] : null;
  editorRevision = providerRevision;
  editorEl('editor-title').textContent = p ? 'Edit provider' : 'Add provider';
  editorEl('editor-name').value = p ? p.displayName : '';
  editorEl('editor-baseurl').value = p ? p.baseUrl : '';
  /* The key is never round-tripped: blank keeps what is saved. */
  editorEl('editor-key').value = '';
  editorEl('editor-key-hint').textContent = p && p.hasApiKey
    ? 'Leave blank to keep the saved key'
    : '';
  editorEl('editor-models').value = p ? p.models.join('\\n') : '';
  editorEl(p && p.authMode === 'none' ? 'editor-auth-none' : 'editor-auth-key').checked = true;
  editorEl('editor-error').textContent = '';
  editorEl('editor-save').disabled = false;
  showBackdrop('editor-backdrop');
  editorEl('editor-name').focus();
}
function showBackdrop(id) {
  var backdrop = editorEl(id);
  backdrop.hidden = false;
  lastFocus = document.activeElement;
  /* Focus the dialog itself so Tab cycles inside it (simple focus trap). */
  var dialog = backdrop.querySelector('.dialog');
  var focusables = dialog.querySelectorAll('button, input, textarea');
  if (focusables.length) focusables[0].focus();
}
function closeEditor() {
  editorEl('editor-backdrop').hidden = true;
  /* The key never outlives the dialog: blank it on close as well as cancel. */
  editorEl('editor-key').value = '';
  if (lastFocus && lastFocus.focus) lastFocus.focus();
  lastFocus = null;
}
function openRemove(id) {
  var p = providersList[id];
  if (!p) return;
  removeTarget = id;
  removalRevision = providerRevision;
  editorEl('remove-text').textContent = 'Remove ' + p.displayName + ' (' + p.id + ')?';
  editorEl('remove-error').textContent = '';
  editorEl('remove-confirm').disabled = false;
  showBackdrop('remove-backdrop');
  editorEl('remove-cancel').focus();
}
function closeRemove() {
  editorEl('remove-backdrop').hidden = true;
  removeTarget = null;
  if (lastFocus && lastFocus.focus) lastFocus.focus();
  lastFocus = null;
}

function authModeOf() {
  return editorEl('editor-auth-none').checked ? 'none' : 'api-key';
}
/* Transport-shape validation only; the store owns URL shape, model syntax,
   reserved ids, and collisions, and its messages are written to be shown. */
function editorValidate() {
  if (editorEl('editor-name').value.trim() === '') return 'Name is required.';
  if (editorEl('editor-baseurl').value.trim() === '') return 'API base URL is required.';
  var lines = editorEl('editor-models').value.split('\\n').map(function (line) { return line.trim(); }).filter(function (line) { return line !== ''; });
  if (!lines.length) return 'At least one model is required.';
  return '';
}
function saveEditor() {
  var problem = editorValidate();
  /* The save carries the revision the dialog was opened with, not the one the
     poll has since adopted. A newer live revision means someone (another tab,
     another mutation) changed the roster under this dialog; sending the old
     fields with the new revision would overwrite it silently, so the conflict
     is refused and the dialog must be reopened instead. */
  if (editorRevision !== providerRevision) {
    editorEl('editor-error').textContent =
      'This provider changed since the dialog opened. Cancel and reopen to edit the current version.';
    editorEl('editor-save').disabled = true;
    return;
  }
  editorEl('editor-error').textContent = problem;
  if (problem) return;
  var body = {
    revision: editorRevision,
    displayName: editorEl('editor-name').value.trim(),
    baseUrl: editorEl('editor-baseurl').value.trim(),
    models: editorEl('editor-models').value.split('\\n').map(function (line) { return line.trim(); }).filter(function (line) { return line !== ''; }),
    authMode: authModeOf()
  };
  var editing = editorEl('editor-title').textContent === 'Edit provider';
  if (editing && editingId) body.id = editingId;
  var key = editorEl('editor-key').value;
  if (authModeOf() === 'api-key' && key !== '') body.apiKey = key;
  editorEl('editor-save').disabled = true;
  editorEl('editor-error').textContent = 'Saving...';
  postManagement('/api/providers/save', body)
    .then(function (snapshot) {
      applySnapshot(snapshot);
      closeEditor();
      load();
    })
    .catch(function (message) {
      editorEl('editor-error').textContent = message;
      editorEl('editor-save').disabled = false;
    });
}
function confirmRemove() {
  if (!removeTarget) return;
  /* Same pinning as the editor: remove with the revision the confirmation was
     opened against, never one a later poll adopted. */
  if (removalRevision !== providerRevision) {
    editorEl('remove-error').textContent =
      'The provider list changed since this was opened. Cancel and try again.';
    editorEl('remove-confirm').disabled = true;
    return;
  }
  editorEl('remove-confirm').disabled = true;
  editorEl('remove-error').textContent = 'Removing...';
  postManagement('/api/providers/remove', { revision: removalRevision, id: removeTarget })
    .then(function (snapshot) {
      applySnapshot(snapshot);
      closeRemove();
      load();
    })
    .catch(function (message) {
      editorEl('remove-error').textContent = message;
      editorEl('remove-confirm').disabled = false;
    });
}
function postManagement(path, body) {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bridge-Ui': UI_NONCE },
    body: JSON.stringify(body)
  }).then(function (r) {
    return r.json().then(function (data) { return { status: r.status, data: data }; });
  }).then(function (res) {
    if (res.status === 200) return res.data;
    throw (res.data && res.data.error) || ('HTTP ' + res.status);
  });
}
function applySnapshot(snapshot) {
  providersList = {};
  for (var i = 0; i < snapshot.providers.length; i++) {
    providersList[snapshot.providers[i].id] = snapshot.providers[i];
  }
  managedIds = Object.assign({}, providersList);
  providerRevision = snapshot.revision;
}
/* The list is fetched separately from /api/state: management metadata and the
   card document have different lifetimes, and the cards only need the ids. */
function loadProviders() {
  if (!MANAGE) return;
  fetch('/api/providers', { headers: { 'X-Bridge-Ui': UI_NONCE }, cache: 'no-store' })
    .then(function (r) {
      if (r.status === 200) return r.json();
      throw new Error('HTTP ' + r.status);
    })
    .then(applySnapshot)
    .catch(function () { /* read-only rendering continues; retry on next poll */ })
    .then(function () { if (lastState) render(lastState); });
}
editorEl('editor-cancel').addEventListener('click', closeEditor);
editorEl('editor-save').addEventListener('click', saveEditor);
editorEl('remove-cancel').addEventListener('click', closeRemove);
editorEl('remove-confirm').addEventListener('click', confirmRemove);
editorEl('add-provider').addEventListener('click', function () { openEditor(null); });
/* Escape cancels whichever dialog is open; Tab is trapped inside it so focus
   cannot wander behind the backdrop. */
document.addEventListener('keydown', function (event) {
  var openBackdrop = document.querySelector('.dialog-backdrop:not([hidden])');
  if (!openBackdrop) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    if (openBackdrop.id === 'editor-backdrop') closeEditor(); else closeRemove();
    return;
  }
  if (event.key === 'Tab') {
    var focusables = openBackdrop.querySelectorAll('button, input, textarea');
    if (!focusables.length) return;
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});

var timer = null;
function load() {
  fetch('/api/state', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(render)
    .catch(function (e) {
      document.getElementById('app').innerHTML =
        '<div class="notice bad">Could not reach the bridge: ' + esc(e.message) + '</div>';
    });
}
document.getElementById('refresh').addEventListener('click', load);
load();
loadProviders();
timer = setInterval(load, 5000);
/* Keep the managed roster fresh too; the card labels are the same either way,
   and Edit/Remove are what the ids gate. */
setInterval(loadProviders, 5000);
<\/script>
</body>
</html>
`;
//#endregion
//#region src/standalone/bridge.ts
/**
* The standalone bridge: the agent-agnostic frontend.
*
* This is the same wiring the DeepSeek Harness plugin performs in its
* `startVariant` / `syncVariant` / `fetchCatalog` triple, with the DSH seam
* removed. Each WorkBuddy product variant gets its own credential store,
* upstream client, catalog, and loopback shim; a sweep reconciles each variant
* with its credentials and keeps the catalog fresh.
*
* What it deliberately does NOT do is register a provider with any agent. That
* was the only DSH-specific job, and it is exactly what an external agent does
* for itself by pointing at the published base URL. The shim is unchanged.
*
* @module workbuddy-bridge/standalone/bridge
*/
/**
* How often the credential files are re-checked, in milliseconds.
*
* Same value and same rationale as the plugin's `CREDENTIAL_POLL_MS`: a
* startup-only catalog fetch cannot notice a sign-in that happens while the
* bridge is already running, so the model list would not appear until a
* restart. The read is a cheap existence/parse check of a few local files — no
* network, no probe.
*
* `WORKBUDDY_BRIDGE_POLL_MS` overrides it, clamped so a mistaken value cannot
* turn the sweep into a busy loop.
*/
const CREDENTIAL_POLL_MS = 3e4;
const MIN_POLL_MS = 100;
const MAX_POLL_MS = 864e5;
/** Resolve the sweep interval, honoring the override when it is usable. */
function credentialPollMs() {
	const override = Number(process.env["WORKBUDDY_BRIDGE_POLL_MS"]);
	if (!Number.isFinite(override) || override < MIN_POLL_MS) return CREDENTIAL_POLL_MS;
	return Math.min(override, MAX_POLL_MS);
}
/**
* How many sweeps to wait before retrying a catalog fetch that failed.
*
* Same reasoning as the plugin's `CATALOG_RETRY_SWEEPS`: a transient network
* blip at startup must not leave the bridge on the built-in roster until
* somebody notices, but a persistent outage must not become a request loop.
*/
const CATALOG_RETRY_SWEEPS = 10;
/** Stable identity key used by credentials and saved catalogs. */
function credentialIdentity(credential) {
	return `${credential.uid}:${credential.enterpriseId ?? ""}`;
}
/** The static roster a variant serves before its first successful fetch. */
function fallbackFor(variant) {
	return variant.id === CN_VARIANT.id ? FALLBACK_WORKBUDDY_MODELS : FALLBACK_WORKBUDDY_AI_MODELS;
}
/** Compact message text for a thrown value. */
function messageOf$1(error) {
	return error instanceof Error ? error.message.slice(0, 300) : String(error);
}
/**
* Render one pool attempt for a human, in the two fields the row needs.
*
* The attempt's `kind` is kept rather than folded into prose because it is the
* distinction the pool itself acts on: `hard_credit` means that account is
* done for the cycle, while `client` means the request was wrong and every
* account would refuse it.
*/
function attemptText(outcome) {
	if (outcome === void 0) return {};
	switch (outcome.state) {
		case "ok": return { lastOutcome: "ok" };
		case "credential-error": return {
			lastOutcome: "credential-error",
			lastOutcomeDetail: outcome.message
		};
		case "upstream-error": return {
			lastOutcome: "upstream-error",
			lastOutcomeDetail: `HTTP ${outcome.status} · ${outcome.kind} · ${outcome.message}`
		};
	}
}
/**
* Flatten one catalog row into the display shape.
*
* Mirrors the mapping the upstream status route performs, so the standalone UI
* and the plugin card agree on what a rate, a badge, and a context window
* mean — including the two cases that are easy to get wrong: a rate that must
* be withheld (`rateUnknown`) rather than shown stale, and a maximum window
* that only appears when it actually exceeds the default.
*/
function uiModelOf(model) {
	const rate = normalizeCredits(model.billing?.credits);
	const supported = model.supportedContextWindows ?? [];
	const maxContextWindow = supported.length > 0 ? Math.max(...supported) : void 0;
	const defaultContextWindow = model.defaultContextWindow ?? model.contextWindow;
	const reasoning = model.reasoning;
	return {
		id: model.id,
		name: model.name,
		supportsImages: model.supportsImages === true,
		...rate === void 0 ? {} : { credits: rate },
		...model.billing?.free === true ? { free: true } : {},
		...model.billing?.badges !== void 0 && model.billing.badges.length > 0 ? { badges: model.billing.badges } : {},
		...model.billing?.rateUnknown === true ? { rateUnknown: true } : {},
		...model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {},
		...defaultContextWindow > 0 && defaultContextWindow < model.contextWindow ? { defaultContextWindow } : {},
		...maxContextWindow === void 0 || maxContextWindow <= defaultContextWindow ? {} : { maxContextWindow },
		...model.maxTokens > 0 ? { maxTokens: model.maxTokens } : {},
		...reasoning === void 0 || reasoning.supports !== true ? {} : { reasoning: {
			supports: true,
			...reasoning.supportedEfforts === void 0 ? {} : { efforts: reasoning.supportedEfforts },
			...reasoning.canDisableThinking === void 0 ? {} : { canDisableThinking: reasoning.canDisableThinking }
		} }
	};
}
/** Copy the credit fields the UI renders, leaving the rest behind. */
function uiCreditsOf(credits) {
	return {
		total: credits.total,
		accounts: credits.accounts.map((account) => ({
			packageName: account.packageName,
			remain: account.remain,
			size: account.size,
			...account.unlimited === void 0 ? {} : { unlimited: account.unlimited },
			...account.endTimeMs === void 0 ? {} : { endTimeMs: account.endTimeMs }
		})),
		...credits.unlimited === void 0 ? {} : { unlimited: credits.unlimited },
		...credits.cycleResetTime === void 0 ? {} : { cycleResetTime: credits.cycleResetTime }
	};
}
/**
* One variant's pool endpoint display name: the product's name plus the pool
* marker, so the page and the CLI can tell the pool endpoint apart at a
* glance from any other row.
*/
function poolDisplayName(variant) {
	return `${variant.displayName} · pool (failover)`;
}
/**
* Both variants' loopback endpoints, running for the life of the process.
*
* Start order is load-bearing: every variant's shim must hold a port before
* the bridge publishes anything, because the published base URL *is* the
* shim's origin and it is only known once the listener is up.
*/
var WorkBuddyBridge = class {
	runtimes = [];
	pools = [];
	genericRuntimes = [];
	/** The failover pool over custom providers; present when two or more exist. */
	customPool;
	options;
	/** The managed-provider store; present only with `manageProviders: true`. */
	managedStore;
	/**
	* The pinned active snapshot: the managed document this bridge actually
	* serves. `listManagedProviders` answers from here, so the UI can never
	* see a document this process would then fail to act on; a remote commit
	* that moved the on-disk revision surfaces as a 409 on the next operation.
	*/
	managedSnapshot;
	/**
	* The captured keys of the pinned snapshot, in memory only — same commit,
	* same revision as {@link managedSnapshot}. A runtime's snapshot embeds the
	* key from here at stage time; nothing re-reads the disk per request.
	*/
	managedSecrets = {};
	/**
	* Serializes management operations so a save/remove cannot interleave with
	* another on this bridge; cross-process safety stays with the file lock.
	*/
	manageQueue = Promise.resolve();
	/** Probe keys (`provider#index`) currently in flight, so a double click cannot double-spend. */
	probes = /* @__PURE__ */ new Set();
	/** The turns agents have sent, for the UI. Metadata only, in memory, bounded. */
	requests = new WorkBuddyRequestLog();
	timer;
	stopped = false;
	startedAtMs = 0;
	/**
	* What each endpoint bound in an earlier run, so a restart can ask for the
	* same port and token instead of making every client re-copy its settings.
	* Loaded once at start; an empty map means every endpoint starts fresh.
	* Kept current as endpoints bind, so one that closes and reopens within this
	* run (the custom pool, when its last provider leaves and one arrives) asks
	* for the values it just held rather than the ones from the last run.
	*/
	identities = /* @__PURE__ */ new Map();
	/** Whether the bearer secrets in {@link identities} may be reused. */
	reuseTokens = true;
	constructor(options = {}) {
		this.options = options;
	}
	/**
	* The last step before a chat result reaches the shim: regroup reasoning
	* deltas unless the operator turned that off. Failures pass through
	* untouched, so error handling is unaffected.
	*/
	finishChat(result) {
		if (this.options.coalesceReasoning === false) return result;
		return coalesceReasoning(result);
	}
	/**
	* Record one turn against the endpoint the agent addressed.
	*
	* Metadata only: the body is parsed for its model name and then dropped, so
	* the log never holds a prompt. Called on the request path, therefore free
	* of I/O — and it cannot fail a turn, because the log is worth less than the
	* request it describes.
	*/
	noteTurn(input) {
		this.requests.record({
			endpoint: input.endpoint,
			model: modelOfBody(input.bodyJson),
			status: input.result.ok ? 200 : input.result.status,
			outcome: input.result.ok ? "ok" : input.result.kind,
			latencyMs: input.latencyMs,
			...input.attempts === void 0 || input.attempts.length === 0 ? {} : { attempts: input.attempts }
		});
	}
	/**
	* Bring up every variant's endpoint and publish the descriptor.
	*
	* A variant that fails to start is skipped rather than fatal — the same
	* containment the plugin applies, so a machine with only one of the two apps
	* installed still serves that one.
	*/
	async start() {
		let providers = [];
		if (this.options.providers !== void 0) {
			const parsed = parseProviderConfig({
				version: 1,
				providers: this.options.providers
			});
			if (!parsed.ok) throw new Error(parsed.error);
			providers = parsed.config.providers;
		}
		if (this.options.manageProviders === true) {
			this.managedStore = new WorkBuddyManagedProviderStore();
			const loaded = await this.managedStore.loadInternal();
			this.managedSnapshot = loaded.metadata;
			this.managedSecrets = loaded.secrets;
			const external = new Set(providers.map((provider) => provider.id));
			for (const managed of loaded.metadata.providers) if (external.has(managed.id)) throw new Error(`workbuddy-bridge: managed provider ${managed.id} collides with an external configured provider of the same id; remove one`);
			providers = [...providers, ...loaded.metadata.providers.map((managed) => this.managedToConfig(managed))];
		}
		try {
			return await this.startEndpoints(providers);
		} catch (error) {
			await this.close();
			throw error;
		}
	}
	/** The store's metadata view, as the generic runtime sees it. */
	managedToConfig(managed) {
		return {
			id: managed.id,
			displayName: managed.displayName,
			baseUrl: managed.baseUrl,
			models: managed.models
		};
	}
	async startEndpoints(providers) {
		this.startedAtMs = Date.now();
		this.reuseTokens = this.options.reuseEndpointTokens !== false;
		this.identities = this.options.persistEndpointIdentity === false ? /* @__PURE__ */ new Map() : await loadEndpointIdentities();
		const variants = this.options.variants ?? WORKBUDDY_VARIANTS;
		for (const variant of variants) {
			const explicit = this.options.authFiles?.get(variant.id) ?? [];
			const discovered = explicit.length > 0 ? explicit : this.options.discoverAccounts === true ? discoverDesktopAuthFiles(variant).map((account) => account.path) : [];
			const paths = discovered.length > 0 ? discovered : [void 0];
			const savedCatalogs = new WorkBuddyCatalogStore(workbuddyCatalogPath(variant.catalogFilename));
			const total = paths.length;
			for (const [index, path] of paths.entries()) {
				const runtime = await this.startVariant(variant, {
					...index === 0 ? {} : { ownPath: join(resolveBridgeHome(), `.workbuddy-auth-${index + 1}.json`) },
					...path === void 0 ? {} : { desktopPath: path },
					accountIndex: index + 1,
					accountTotal: total,
					savedCatalogs
				});
				if (runtime !== void 0) this.runtimes.push(runtime);
			}
		}
		await this.startPools(variants);
		for (const provider of providers) {
			const key = this.managedStore === void 0 ? void 0 : this.managedSecrets[provider.id];
			this.startGeneric(provider, key);
		}
		await this.syncCustomPool();
		await this.syncAll();
		const descriptor = await this.publish();
		this.timer = setInterval(() => {
			this.syncAll().then(() => this.publish());
		}, credentialPollMs());
		this.timer.unref?.();
		return descriptor;
	}
	/**
	* The pool's current members: every custom provider this bridge serves,
	* each with the credential it would send.
	*
	* A managed provider's key comes from the pinned transaction, not from a
	* fresh disk read, so the pool's view and the per-provider endpoints' view
	* are the same commit. External providers keep their `apiKeyEnv` lookup.
	*/
	customPoolMembers() {
		return this.genericRuntimes.map((runtime) => {
			const provider = runtime.getSnapshot();
			return {
				id: provider.id,
				displayName: provider.displayName ?? provider.id,
				baseUrl: provider.baseUrl,
				models: provider.models,
				...provider.apiKey === void 0 ? {} : { apiKey: provider.apiKey },
				...provider.apiKeyEnv === void 0 ? {} : { apiKeyEnv: provider.apiKeyEnv },
				managed: this.managedSnapshot?.providers.some((entry) => entry.id === provider.id) === true
			};
		});
	}
	/**
	* The port a listener should ask for, when the runner keeps addresses
	* stable. Used for listeners that are not published endpoints — the web UI
	* and the WSL forwarders — so their addresses survive a restart too.
	*
	* Exposed as a method rather than by handing out the map, so the document's
	* rules stay in one place.
	*/
	preferredPortFor(key) {
		if (this.options.persistEndpointIdentity === false) return void 0;
		return this.identities.get(key)?.port;
	}
	/** Record the port a non-endpoint listener actually bound. Never throws. */
	async rememberPortFor(key, baseUrl) {
		await this.rememberBound(key, baseUrl, "");
	}
	/**
	* The port the web UI should ask for. The UI is not a published endpoint, so
	* it has no token — only the address the operator has open matters.
	*/
	preferredUiPort() {
		return this.preferredPortFor(" ui");
	}
	/** Record the port the UI actually bound. Never throws. */
	async rememberUiPort(baseUrl) {
		await this.rememberPortFor(" ui", baseUrl);
	}
	/**
	* The port and token an endpoint should ask for, from what it bound last
	* time. Both are preferences — the shim falls back on its own — so this only
	* has to answer "what did we use before".
	*/
	wantedIdentity(key) {
		const remembered = this.identities.get(key);
		if (remembered === void 0) return {};
		return {
			...remembered.port === void 0 ? {} : { port: remembered.port },
			...this.reuseTokens && remembered.token !== void 0 ? { token: remembered.token } : {}
		};
	}
	/**
	* Record what an endpoint actually bound.
	*
	* Never throws and never rejects: a failure to remember makes the *next*
	* start less convenient, which must not fail this one. The port is read back
	* from the live base URL because the shim may have fallen back from the
	* preferred one, and the remembered value has to be the truth.
	*/
	async rememberBound(key, baseUrl, token) {
		if (this.options.persistEndpointIdentity === false) return;
		const port = portOfBaseUrl(baseUrl);
		const identity = {
			...port === void 0 ? {} : { port },
			...this.reuseTokens && token !== "" ? { token } : {}
		};
		this.identities.set(key, identity);
		try {
			await rememberEndpointIdentity(key, identity, { persistToken: this.reuseTokens });
		} catch (error) {
			this.options.logger?.warn(`workbuddy-bridge: could not remember the endpoint address for ${key}`, error);
		}
	}
	/**
	* Keep the custom-provider pool in step with the provider list.
	*
	* The pool is the only endpoint a custom provider is served on, so it
	* exists however many providers there are — one is enough — and closes only
	* when the last one goes. Between states the same listener is kept and only
	* the member list changes, so the published base URL and local token
	* survive every edit.
	*/
	async syncCustomPool() {
		const members = this.customPoolMembers();
		if (members.length === 0) {
			const existing = this.customPool;
			this.customPool = void 0;
			await existing?.shim.close().catch(() => {});
			return;
		}
		if (this.customPool !== void 0) {
			this.customPool.shim.router.prune(members);
			return;
		}
		const shim = createCustomProviderPoolShim({
			getMembers: () => this.customPoolMembers(),
			onTurn: (record) => {
				this.requests.record({
					endpoint: CUSTOM_POOL_ID,
					model: record.model,
					status: record.status,
					outcome: record.outcome === "ok" ? "ok" : errorKindForStatus(record.status),
					latencyMs: record.durationMs,
					...record.attempts.length === 0 ? {} : { attempts: record.attempts.map((attempt) => attemptRecord(attempt, (index) => record.labels[index] ?? `provider ${index + 1}`)) }
				});
			},
			onStreamError: (error) => {
				this.options.logger?.warn("workbuddy-bridge: custom provider stream failed mid-flight", error);
			},
			...this.wantedIdentity(CUSTOM_POOL_ID)
		});
		this.customPool = { shim };
		await shim.ready;
		await this.rememberBound(CUSTOM_POOL_ID, shim.baseUrl(), shim.token());
	}
	/**
	* Bring one provider's snapshot into the served set.
	*
	* The pool reads membership live, so attaching a snapshot is all it takes:
	* the pool endpoint serves the provider from its next request, and an edit
	* swaps the snapshot in place without touching any listener.
	*/
	startGeneric(provider, apiKey) {
		let snapshot = {
			...provider,
			...apiKey === void 0 ? {} : { apiKey }
		};
		this.genericRuntimes.push({
			provider,
			getSnapshot: () => snapshot,
			setSnapshot: (next) => {
				snapshot = next;
			}
		});
	}
	/**
	* The pinned active managed snapshot, for the UI's provider editor.
	*
	* Answers from what this bridge actually serves, never straight from the
	* disk: a commit another process made after this bridge started would
	* otherwise describe endpoints the UI cannot then edit (any mutation would
	* 409 against it). Off-bridge loading is a reload/restart.
	*/
	async listManagedProviders() {
		this.assertManaged();
		return this.managedSnapshot;
	}
	/**
	* Validate, commit, then expose one managed provider — strictly in that
	* order. The payload's revision must name the pinned state here AND the
	* store's on-disk revision at commit (a second guard under the store's
	* lock), so neither a stale tab nor a stale process can overwrite. A failed
	* save throws before the commit, so the old state keeps serving unchanged
	* and nothing is persisted.
	*/
	async saveManagedProvider(input) {
		this.assertManaged();
		return await this.enqueueManagement(async () => {
			const store = this.managedStore;
			const active = this.managedSnapshot;
			const record = this.assertPinnedRevision(input, active);
			const externalIds = (this.options.providers ?? []).map((provider) => provider.id);
			if (record["id"] === void 0) {
				const preview = store.previewId(record["displayName"]);
				if (preview !== void 0 && externalIds.includes(preview)) throw new ProviderManagementError(400, "the new provider would collide with an external configured provider; choose another name");
			}
			const committed = await store.saveInternal(input, { blockedIds: externalIds });
			await this.attachManaged(active, committed.metadata, committed.secrets);
			this.managedSnapshot = committed.metadata;
			this.managedSecrets = committed.secrets;
			await this.syncCustomPool();
			return committed.metadata;
		});
	}
	/**
	* Persist one removal, then drop the provider's snapshot — persist first,
	* so a failed remove leaves the serving state unchanged. The payload's
	* revision must name the pinned state here AND the disk's at the store's
	* commit, matching save's dual guard.
	*/
	async removeManagedProvider(input) {
		this.assertManaged();
		return await this.enqueueManagement(async () => {
			const active = this.managedSnapshot;
			this.assertPinnedRevision(input, active);
			const committed = await this.managedStore.removeInternal(input);
			await this.attachManaged(active, committed.metadata, committed.secrets);
			this.managedSnapshot = committed.metadata;
			this.managedSecrets = committed.secrets;
			await this.syncCustomPool();
			return committed.metadata;
		});
	}
	/** Serialize management operations per bridge; cross-process stays on the file lock. */
	enqueueManagement(operation) {
		const run = this.manageQueue.then(operation, operation);
		this.manageQueue = run.catch(() => {});
		return run;
	}
	/** A bridge not started with `manageProviders` has no management surface. */
	assertManaged() {
		if (this.stopped) throw new ProviderManagementError(409, "the bridge has stopped; management is no longer available");
		if (this.options.manageProviders !== true || this.managedStore === void 0) throw new ProviderManagementError(409, "provider management is not enabled on this bridge; start it with manageProviders enabled");
	}
	/**
	* Shared management payload guard: the payload must be an object carrying
	* the pinned revision, so a stale tab cannot overwrite the active state.
	* The store re-checks the same revision against the disk under its lock —
	* the dual guard for cross-process conflicts.
	*/
	assertPinnedRevision(input, active) {
		if (typeof input !== "object" || input === null || Array.isArray(input)) throw new ProviderManagementError(400, "management payload must be a JSON object");
		const record = input;
		if (record["revision"] !== active.revision) throw new ProviderManagementError(409, "the provider list changed elsewhere; reload and retry");
		return record;
	}
	/**
	* Make the live provider snapshots match a freshly committed managed
	* transaction.
	*
	* A create attaches a snapshot built from the commit's metadata and
	* captured key. An edit swaps the existing runtime's snapshot in place
	* (in-flight turns preserved) with the commit's captured key. A removal
	* drops the runtime after the persist. The managed/external split is by
	* the `managedIds` set built from the pinned snapshot — never by matching
	* against external ids.
	*/
	async attachManaged(previous, snapshot, secrets) {
		const previousIds = new Set(previous.providers.map((managed) => managed.id));
		const nextIds = new Set(snapshot.providers.map((managed) => managed.id));
		const keep = [];
		for (const runtime of this.genericRuntimes) {
			const isManagedRuntime = previousIds.has(runtime.provider.id);
			if (isManagedRuntime && nextIds.has(runtime.provider.id)) keep.push(runtime);
			else if (isManagedRuntime) {} else keep.push(runtime);
		}
		this.genericRuntimes.length = 0;
		this.genericRuntimes.push(...keep);
		for (const managed of snapshot.providers) {
			const existing = keep.find((runtime) => runtime.provider.id === managed.id);
			if (existing !== void 0) {
				const key = secrets[managed.id];
				existing.setSnapshot({
					...this.managedToConfig(managed),
					...key === void 0 ? {} : { apiKey: key }
				});
				continue;
			}
			this.startGeneric(this.managedToConfig(managed), secrets[managed.id]);
		}
	}
	/**
	* One pool endpoint per product, serving every account of that product.
	*
	* The pool rides on the same shim the accounts used to — same gates, same
	* per-process secret — but its store and client are the failover router,
	* so the shim never learns the difference. The pool is the only endpoint
	* the product serves, and it exists however many accounts are signed in:
	* the URL an agent is configured with survives accounts being added,
	* removed, or signed out, and failover appears the moment a second account
	* can answer.
	*/
	async startPools(variants) {
		const logger = this.options.logger;
		for (const variant of variants) {
			const members = this.runtimes.filter((runtime) => runtime.variant.id === variant.id);
			if (members.length === 0) continue;
			const catalog = new WorkBuddyCatalog(fallbackFor(variant));
			if (variant.id !== CN_VARIANT.id) catalog.setUseMaximumContextWindow(true);
			catalog.setVisible(false);
			const pool = new WorkBuddyFailoverPool(members.map((runtime) => ({
				store: runtime.store,
				client: { chatStream: (credential, bodyJson, signal) => runtime.chat(credential, bodyJson, signal) }
			})));
			const shim = createWorkBuddyShim({
				store: pool,
				client: { chatStream: async (credential, bodyJson, signal) => {
					const startedAtMs = Date.now();
					const attempts = [];
					const result = await pool.chatStream(credential, bodyJson, signal, (attempt) => {
						attempts.push(attemptRecord(attempt, (index) => {
							const member = members[index];
							return member?.nickname ?? `account ${member?.accountIndex ?? index + 1}`;
						}));
					});
					this.noteTurn({
						endpoint: `${variant.id}-pool`,
						bodyJson,
						result,
						latencyMs: Date.now() - startedAtMs,
						attempts
					});
					return result;
				} },
				catalog,
				...logger === void 0 ? {} : { logger },
				...this.wantedIdentity(`${variant.id}-pool`)
			});
			try {
				await shim.ready;
			} catch (error) {
				logger?.error(`workbuddy-bridge: ${variant.displayName} pool endpoint failed to start`, error);
				continue;
			}
			await this.rememberBound(`${variant.id}-pool`, shim.baseUrl(), shim.token());
			this.pools.push({
				variant,
				members,
				pool,
				catalog,
				shim
			});
		}
	}
	/** The descriptor as of the last publish. */
	async publish() {
		return {
			version: 1,
			pid: process.pid,
			startedAtMs: this.startedAtMs,
			endpoints: this.endpoints()
		};
	}
	/** Write the descriptor to disk and return it. */
	async publishToDisk() {
		const descriptor = await this.publish();
		await writeBridgeDescriptor(descriptor);
		return descriptor;
	}
	/** Current endpoints, without touching disk. */
	endpoints() {
		return [...this.pools.map((pool) => this.poolEndpointOf(pool)), ...this.customPool === void 0 ? [] : [this.customPoolEndpointOf(this.customPool)]];
	}
	/**
	* Build the web UI's state document. Carries the bearer token so the user
	* can copy it from the pool card. The page itself is still unauthenticated —
	* it relies on the Host/Origin loopback gate — but the token is now part of
	* the rendered state.
	*/
	async uiState() {
		const endpoints = [];
		const credits = /* @__PURE__ */ new Map();
		for (const runtime of this.runtimes) credits.set(runtime, await this.accountCreditsOf(runtime));
		for (const pool of this.pools) endpoints.push(await this.uiPoolOf(pool, credits));
		if (this.customPool !== void 0) endpoints.push(this.uiCustomPoolOf(this.customPool));
		return {
			version: 1,
			startedAtMs: this.startedAtMs,
			nowMs: Date.now(),
			endpoints
		};
	}
	/**
	* The custom-provider pool's card: its membership, who answers next, and
	* what the router has seen of each provider's real traffic.
	*
	* The same shape the account pool uses, so the page renders one component
	* for both. A provider with no key shows as unavailable rather than as a
	* routing failure; the upstream base URL stays out of the page — the pool
	* card is the only thing an agent is configured with.
	*/
	uiCustomPoolOf(pool) {
		const members = this.customPoolMembers();
		const health = pool.shim.router.memberHealth(members);
		const headIndex = pool.shim.router.headIndex(members);
		const models = poolModelList(members);
		return {
			provider: CUSTOM_POOL_ID,
			displayName: "Custom providers · pool (failover)",
			baseUrl: `${pool.shim.baseUrl()}/v1`,
			token: pool.shim.token(),
			signedIn: models.length > 0,
			models: models.map((id) => ({
				id,
				name: id,
				supportsImages: false
			})),
			requests: this.uiRequestsOf(CUSTOM_POOL_ID),
			pool: {
				kind: "providers",
				headIndex,
				members: members.map((member, index) => {
					const record = health[index];
					return {
						index,
						accountIndex: index + 1,
						label: member.displayName,
						signedIn: poolMemberAvailable(member),
						head: index === headIndex,
						successes: record?.successes ?? 0,
						failures: record?.failures ?? 0,
						consecutiveFailures: record?.consecutiveFailures ?? 0,
						...record === void 0 || record.lastAttemptAtMs <= 0 ? {} : { lastAttemptAtMs: record.lastAttemptAtMs },
						...attemptText(record?.lastOutcome),
						...member.managed ? { editId: member.id } : {}
					};
				})
			},
			...models.length === 0 ? { error: "no provider in the pool has a usable key" } : {}
		};
	}
	/**
	* The pool's UI row: its membership, who answers next, and what the router
	* has seen of each member's real traffic.
	*
	* No credit figure of its own: credits belong to accounts, and each member
	* row shows its own — a pool balance would have to pick one member's number
	* and present it as the pool's, which is a lie. What the pool row adds is
	* the thing no account card can show: the routing state.
	*/
	async uiPoolOf(pool, credits) {
		const health = pool.pool.memberHealth();
		const headIndex = pool.pool.headIndex();
		return {
			provider: `${pool.variant.id}-pool`,
			displayName: poolDisplayName(pool.variant),
			baseUrl: `${pool.shim.baseUrl()}/v1`,
			token: pool.shim.token(),
			signedIn: pool.members.some((runtime) => runtime.identity !== void 0),
			models: pool.catalog.current().map(uiModelOf),
			requests: this.uiRequestsOf(`${pool.variant.id}-pool`),
			pool: {
				headIndex,
				members: pool.members.map((runtime, index) => this.uiPoolMemberOf(runtime, index, headIndex, health[index], credits.get(runtime)))
			},
			...pool.members.every((runtime) => runtime.identity === void 0) ? { error: "no account in the pool is signed in" } : {}
		};
	}
	/** One pool member row, assembled from the runtime, its health, and its credit read. */
	uiPoolMemberOf(runtime, index, headIndex, health, billing) {
		return {
			index,
			accountIndex: runtime.accountIndex,
			label: runtime.nickname ?? runtime.uid ?? `account ${runtime.accountIndex}`,
			...runtime.uid === void 0 ? {} : { uid: runtime.uid },
			signedIn: runtime.identity !== void 0,
			head: index === headIndex,
			successes: health?.successes ?? 0,
			failures: health?.failures ?? 0,
			consecutiveFailures: health?.consecutiveFailures ?? 0,
			...health === void 0 || health.lastAttemptAtMs <= 0 ? {} : { lastAttemptAtMs: health.lastAttemptAtMs },
			...attemptText(health?.lastOutcome),
			...billing?.credits === void 0 ? {} : { credits: billing.credits },
			...billing?.creditsError === void 0 ? {} : { creditsError: billing.creditsError }
		};
	}
	/**
	* Send one real chat turn through one pool member, for the page's test
	* button.
	*
	* An account member is probed in process, through the same wrapped client a
	* pool-served request runs — same gates, same credential resolution, same
	* upstream call — so the claim being tested is "this account can answer",
	* without a per-account endpoint to knock on. A provider member is probed
	* over HTTP at its own base URL with its own key. Either way the pool is
	* deliberately untouched — a manual test must not move the head, or
	* checking a spare member would silently redirect live traffic onto it.
	*/
	async probePoolMember(request) {
		if (request.provider === "custom-pool") return await this.probeCustomProvider(request);
		const pool = this.pools.find((candidate) => `${candidate.variant.id}-pool` === request.provider);
		if (pool === void 0) throw new UiRequestError(404, `no pool endpoint named ${request.provider}`);
		const member = pool.members[request.index];
		if (member === void 0) throw new UiRequestError(404, `no pool account at index ${request.index}`);
		const served = member.catalog.current();
		if (request.model !== void 0 && served.every((model) => model.id !== request.model)) throw new UiRequestError(400, `this account does not serve ${request.model}`);
		const model = request.model ?? served[0]?.id ?? pool.catalog.current()[0]?.id ?? fallbackFor(pool.variant)[0]?.id;
		if (model === void 0) throw new UiRequestError(409, "this account serves no model to test against");
		const key = `${request.provider}#${request.index}`;
		if (this.probes.has(key)) throw new UiRequestError(409, "a test is already running for this account");
		this.probes.add(key);
		try {
			const result = await (this.options.probe ?? probeMemberTurn)({
				provider: request.provider,
				index: request.index,
				model,
				sendTurn: async (bodyJson, signal) => member.chat(await member.store.resolve(), bodyJson, signal)
			});
			return {
				provider: request.provider,
				index: request.index,
				label: member.nickname ?? `account ${member.accountIndex}`,
				model,
				...result
			};
		} finally {
			this.probes.delete(key);
		}
	}
	/**
	* Test one provider inside the custom pool.
	*
	* Probed over HTTP at the provider's own base URL with its own key — the
	* claim is "this provider can answer", and a test must not move the head or
	* spend a turn on another provider. A provider with no usable key is
	* refused before any call, so a test never becomes an accidental
	* unauthenticated request.
	*/
	async probeCustomProvider(request) {
		const member = this.customPoolMembers()[request.index];
		if (member === void 0) throw new UiRequestError(404, `no provider at index ${request.index} in the pool`);
		if (!poolMemberAvailable(member)) throw new UiRequestError(409, `provider ${member.displayName} has no usable API key`);
		if (request.model !== void 0 && !member.models.includes(request.model)) throw new UiRequestError(400, `this provider does not serve ${request.model}`);
		const model = request.model ?? member.models[0];
		if (model === void 0) throw new UiRequestError(409, "this provider serves no model to test against");
		const key = `${request.provider}#${request.index}`;
		if (this.probes.has(key)) throw new UiRequestError(409, "a test is already running for this provider");
		this.probes.add(key);
		try {
			const result = await (this.options.probe ?? probeMemberTurn)({
				provider: request.provider,
				index: request.index,
				model,
				baseUrl: member.baseUrl,
				...member.apiKey === void 0 ? {} : { apiKey: member.apiKey }
			});
			return {
				provider: request.provider,
				index: request.index,
				label: member.displayName,
				model,
				...result
			};
		} finally {
			this.probes.delete(key);
		}
	}
	/** One endpoint's recent turns, newest first, as the page shows them. */
	uiRequestsOf(endpoint) {
		return this.requests.recent(endpoint).map((record) => ({
			atMs: record.atMs,
			...record.account === void 0 ? {} : { account: record.account },
			model: record.model,
			status: record.status,
			outcome: record.outcome,
			latencyMs: record.latencyMs,
			...record.attempts === void 0 ? {} : { attempts: record.attempts }
		}));
	}
	/** One account's live credit read, for its pool member row. */
	async accountCreditsOf(runtime) {
		let credential;
		try {
			credential = await runtime.store.current();
		} catch {
			return {};
		}
		if (credential === void 0) return {};
		try {
			return { credits: uiCreditsOf(await runtime.client.fetchCredits(credential)) };
		} catch (error) {
			return { creditsError: messageOf$1(error) };
		}
	}
	/** Stop serving and destroy open connections. */
	async close() {
		this.stopped = true;
		if (this.timer !== void 0) clearInterval(this.timer);
		this.timer = void 0;
		await this.manageQueue.catch(() => {});
		await Promise.all([...this.pools.map((pool) => pool.shim.close()), ...this.customPool === void 0 ? [] : [this.customPool.shim.close()]]);
		this.runtimes.length = 0;
		this.pools.length = 0;
		this.genericRuntimes.length = 0;
		this.customPool = void 0;
	}
	/**
	* The custom-provider pool's descriptor row.
	*
	* Its provider id is `custom-pool`, which no provider may take (the store
	* and the external parser both reserve it), so tooling that filters by
	* provider id never confuses the pool with one of its members.
	*/
	customPoolEndpointOf(pool) {
		const models = poolModelList(this.customPoolMembers());
		return {
			provider: CUSTOM_POOL_ID,
			displayName: "Custom providers · pool (failover)",
			baseUrl: `${pool.shim.baseUrl()}/v1`,
			token: pool.shim.token(),
			signedIn: models.length > 0,
			modelCount: models.length
		};
	}
	/** The pool's descriptor row. Provider id gets a `-pool` suffix so tooling that filters by product id does not match it. */
	poolEndpointOf(pool) {
		return {
			provider: `${pool.variant.id}-pool`,
			displayName: poolDisplayName(pool.variant),
			baseUrl: `${pool.shim.baseUrl()}/v1`,
			token: pool.shim.token(),
			modelCount: pool.catalog.current().length,
			signedIn: pool.members.some((runtime) => runtime.identity !== void 0)
		};
	}
	async startVariant(variant, account) {
		const client = new WorkBuddyUpstreamClient();
		const store = new WorkBuddyCredentialStore({
			variant,
			...account.desktopPath === void 0 ? {} : { desktopPath: account.desktopPath },
			...account.ownPath === void 0 ? {} : { ownPath: account.ownPath },
			keyProvider: atRestKeyProviderFor(variant),
			refresh: (credential) => client.refreshToken(credential)
		});
		const catalog = new WorkBuddyCatalog(fallbackFor(variant));
		if (variant.id !== CN_VARIANT.id) catalog.setUseMaximumContextWindow(true);
		catalog.setVisible(false);
		return {
			variant,
			store,
			client,
			chat: async (credential, bodyJson, signal) => {
				const result = await client.chatStream(credential, bodyJson, signal);
				captureChannelFailure(variant.id, bodyJson, result);
				return this.finishChat(result);
			},
			catalog,
			savedCatalogs: account.savedCatalogs,
			identity: void 0,
			source: "fallback",
			error: void 0,
			lastFetchAtMs: 0,
			inflight: void 0,
			accountIndex: account.accountIndex,
			accountTotal: account.accountTotal,
			nickname: void 0,
			uid: void 0
		};
	}
	async syncAll() {
		for (const runtime of this.runtimes) await this.syncVariant(runtime);
		for (const pool of this.pools) this.syncPool(pool);
	}
	/**
	* The pool's model list is the union of its members' lists, first account
	* wins per model id. The accounts all belong to one product, so their
	* rosters are near-identical and the union is mostly a deduplication — but
	* it is the honest answer to "what can this endpoint serve": any model any
	* member can serve, since failover means the answering account is not
	* known until the request fails or succeeds.
	*/
	syncPool(pool) {
		const seen = /* @__PURE__ */ new Set();
		const merged = [];
		let visible = false;
		for (const runtime of pool.members) {
			if (runtime.catalog.isVisible() === false) continue;
			visible = true;
			for (const model of runtime.catalog.current()) {
				if (seen.has(model.id)) continue;
				seen.add(model.id);
				merged.push(model);
			}
		}
		pool.catalog.set(merged.length > 0 ? merged : fallbackFor(pool.variant));
		pool.catalog.setVisible(visible);
	}
	/**
	* Reconcile one variant with its credentials.
	*
	* Three transitions matter, mirroring the plugin's sweep: signed-out hides
	* the list, a first sighting or an identity change re-seeds from the saved
	* catalog and fetches, and an unchanged identity only retries a fetch that
	* previously failed and is now due.
	*/
	async syncVariant(runtime) {
		if (this.stopped) return;
		let credential;
		try {
			credential = await runtime.store.current();
		} catch (error) {
			runtime.error = messageOf$1(error);
			return;
		}
		if (this.stopped) return;
		if (credential === void 0) {
			if (runtime.identity !== void 0) {
				runtime.savedCatalogs.delete(runtime.identity);
				runtime.identity = void 0;
			}
			runtime.nickname = void 0;
			runtime.uid = void 0;
			runtime.catalog.set(fallbackFor(runtime.variant));
			runtime.source = "fallback";
			runtime.error = void 0;
			runtime.catalog.setVisible(false);
			return;
		}
		const identity = credentialIdentity(credential);
		if (runtime.identity === identity) {
			const stale = runtime.source !== "live";
			const due = Date.now() - runtime.lastFetchAtMs >= credentialPollMs() * CATALOG_RETRY_SWEEPS;
			if (stale && due) await this.fetchCatalog(runtime, identity);
			return;
		}
		runtime.identity = identity;
		runtime.nickname = credential.nickname;
		runtime.uid = credential.uid;
		const saved = runtime.savedCatalogs.get(identity);
		if (saved !== void 0) {
			runtime.catalog.set([...saved.models]);
			runtime.source = "saved";
		} else {
			runtime.catalog.set(fallbackFor(runtime.variant));
			runtime.source = "fallback";
		}
		runtime.error = void 0;
		runtime.catalog.setVisible(true);
		await this.fetchCatalog(runtime, identity);
	}
	/**
	* Fetch one variant's catalog for the current credential.
	*
	* Single-flight per identity: a second caller joins the in-flight fetch, and
	* a response whose identity has since been superseded writes nothing — which
	* is what stops a slow answer from resurrecting a departed account's roster.
	* Uses `resolve()`, not `current()`, so an expired token is renewed rather
	* than failing every request until something else refreshes it.
	*/
	async fetchCatalog(runtime, identity) {
		const inflight = runtime.inflight;
		if (inflight !== void 0 && inflight.identity === identity) return inflight.promise;
		let run;
		run = (async () => {
			try {
				const credential = await runtime.store.resolve();
				if (credentialIdentity(credential) !== identity) {
					await this.syncVariant(runtime);
					return;
				}
				const models = await runtime.client.fetchModels(credential);
				if (this.stopped || runtime.identity !== identity) return;
				runtime.lastFetchAtMs = Date.now();
				runtime.catalog.set([...models]);
				runtime.source = "live";
				runtime.error = void 0;
				const last = runtime.client.lastCatalog;
				runtime.savedCatalogs.set(identity, {
					source: last?.source ?? "unknown",
					fetchedAtMs: last?.fetchedAtMs ?? Date.now(),
					models: [...models],
					...last?.appVersion === void 0 ? {} : { appVersion: last.appVersion.version }
				});
			} catch (error) {
				if (this.stopped || runtime.identity !== identity) return;
				runtime.lastFetchAtMs = Date.now();
				runtime.error = messageOf$1(error);
			}
		})().finally(() => {
			if (runtime.inflight?.promise === run) runtime.inflight = void 0;
		});
		runtime.inflight = {
			identity,
			promise: run
		};
		return run;
	}
};
//#endregion
//#region src/standalone/cli.ts
/**
* `workbuddy-bridge` — run the WorkBuddy loopback bridge for any
* OpenAI-compatible agent.
*
* The bridge itself is agent-agnostic: it serves a standard `/v1` surface on
* loopback and this CLI publishes where to find it. DeepSeek Harness reaches
* the same core through its own plugin entry instead; nothing here imports a
* DSH package.
*
* @module workbuddy-bridge/standalone/cli
*/
const PROGRAM = "workbuddy-bridge";
const USAGE = `${PROGRAM} ${WORKBUDDY_CONNECT_VERSION}

Serve the WorkBuddy desktop app's models over a local OpenAI-compatible
endpoint, for any agent that can be pointed at a base URL.

Usage:
  ${PROGRAM} serve [options]     start the bridge (default command)
  ${PROGRAM} ui                  start the bridge plus a local web UI, which
                                 shows each pool member and can test it
  ${PROGRAM} test [options]      send one real chat turn through the running
                                 bridge, over both the loopback and WSL routes
  ${PROGRAM} models [--json]     list the models the running bridge serves
  ${PROGRAM} status [--json]     show the running bridge, if any
  ${PROGRAM} env                 print shell exports for the running bridge
  ${PROGRAM} help                show this text

Options:
  --config <path>           explicit version-1 custom provider JSON (serve/ui);
                            no automatic config discovery
  --provider <id[,id...]>    cn, ai, both, built-in or custom provider IDs;
                            repeat or separate with commas; default: both
                            built-in products plus all configured providers
                            (both selects built-in products only)
  --model <id>              model for "test" (default: the endpoint's first)
  --ui                      also serve the web UI (models + credits)
  --wsl                     also listen on the WSL switch address, so agents
                            running inside WSL can reach the bridge
  --auth-file <path>        explicit WorkBuddy (CN) desktop auth file;
                            repeat to serve several CN accounts at once
  --auth-file-ai <path>     explicit WorkBuddy AI desktop auth file;
                            repeat to serve several AI accounts at once
  --all-accounts            serve every account found in the desktop auth
                            directory (explicit --auth-file* flags win for
                            the product they name)
  --no-coalesce-reasoning   forward reasoning deltas exactly as the upstream
                            sends them (by default tiny per-word deltas are
                            regrouped, so clients show paragraphs rather than
                            one thinking block per word)
  --home <dir>              override the bridge home directory
  --no-descriptor           do not write the endpoint descriptor file
  --redact-token            write the descriptor without the bearer token
  --no-stable-endpoints     choose a fresh port and token on every start
                            (default: the port and token an endpoint used last
                            time are reused, so a configured agent keeps
                            working across restarts)
  --json                    machine-readable output
  -h, --help                show this text

WSL note: WSL2 in NAT mode has its own loopback, so a bridge on 127.0.0.1 is
unreachable from inside WSL. Either pass --wsl (which binds the host side of
the WSL virtual switch as well), or set networkingMode=mirrored in .wslconfig,
which shares localhost between Windows and WSL and needs no extra listener.

Environment:
  WORKBUDDY_BRIDGE_HOME     bridge home (default: ~/.workbuddy-bridge)
  WORKBUDDY_BRIDGE_POLL_MS  credential sweep interval (default: 30000)
  WORKBUDDY_AUTH_FILE       CN desktop auth file, when --auth-file is absent
  WORKBUDDY_AI_AUTH_FILE    AI desktop auth file, when --auth-file-ai is absent

By default each endpoint reuses the loopback port and bearer token it bound on
the previous start, so a client configured once keeps working. Both are
preferences: a port another process now holds falls back to a free one, and the
descriptor always records what actually bound. Pass --no-stable-endpoints for a
fresh pair each start. With --no-descriptor the token stays in memory only and
is never written to the identity file.
`;
/** Parse argv into the shape the commands consume. */
function parseArgs(argv) {
	const args = {
		command: "serve",
		ui: false,
		wsl: false,
		allAccounts: false,
		noCoalesceReasoning: false,
		providerIds: [],
		config: void 0,
		model: void 0,
		descriptor: true,
		redactToken: false,
		stableEndpoints: true,
		json: false,
		home: void 0,
		authFileCN: [],
		authFileAI: []
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === void 0) continue;
		switch (arg) {
			case "serve":
			case "models":
			case "status":
			case "env":
			case "test":
				args.command = arg;
				break;
			case "ui":
				args.command = "serve";
				args.ui = true;
				break;
			case "--ui":
				args.ui = true;
				break;
			case "--wsl":
				args.wsl = true;
				break;
			case "--all-accounts":
				args.allAccounts = true;
				break;
			case "--no-coalesce-reasoning":
				args.noCoalesceReasoning = true;
				break;
			case "help":
			case "--help":
			case "-h":
				args.command = "help";
				break;
			case "--config": {
				const value = argv[index += 1];
				if (value === void 0 || value.startsWith("-") || value.trim() === "") throw new Error("--config needs a value");
				args.config = value;
				break;
			}
			case "--provider": {
				const value = argv[index += 1];
				if (value === void 0 || value.startsWith("-") || !value.split(",").some((part) => part.trim() !== "")) throw new Error("--provider needs a value");
				args.providerIds.push(...value.split(",").map((part) => part.trim()).filter((part) => part !== ""));
				break;
			}
			case "--model": {
				const value = argv[index += 1];
				if (value === void 0) throw new Error("--model needs a value");
				args.model = value;
				break;
			}
			case "--auth-file": {
				const value = argv[index += 1];
				if (value === void 0) throw new Error("--auth-file needs a value");
				args.authFileCN.push(value);
				break;
			}
			case "--auth-file-ai": {
				const value = argv[index += 1];
				if (value === void 0) throw new Error("--auth-file-ai needs a value");
				args.authFileAI.push(value);
				break;
			}
			case "--home":
				args.home = argv[index += 1];
				break;
			case "--no-descriptor":
				args.descriptor = false;
				break;
			case "--no-stable-endpoints":
				args.stableEndpoints = false;
				break;
			case "--redact-token":
				args.redactToken = true;
				break;
			case "--json":
				args.json = true;
				break;
			default: throw new Error(`unknown argument: ${arg}`);
		}
	}
	return args;
}
/** Expand aliases once, retaining selection order and removing duplicates. */
function selectedIds(providerIds) {
	return [...new Set(providerIds.flatMap((id) => id === "both" ? WORKBUDDY_VARIANTS.map((variant) => variant.id) : [id === "cn" ? "workbuddy" : id === "ai" ? "workbuddy-ai" : id]))];
}
/** Explicit opt-in only. Do not echo JSON input or filesystem error details. */
async function loadProviders(path) {
	if (path === void 0) return [];
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch {
		throw new Error("provider config file could not be read");
	}
	let input;
	try {
		input = JSON.parse(text);
	} catch {
		throw new Error("provider config file must contain valid JSON");
	}
	const parsed = parseProviderConfig(input);
	if (!parsed.ok) throw new Error(parsed.error);
	return parsed.config.providers;
}
/** Validate every selection before any listener starts. */
function resolveProviders(providerIds, configured) {
	if (providerIds.length === 0) return {
		variants: WORKBUDDY_VARIANTS,
		providers: configured
	};
	const wanted = selectedIds(providerIds);
	for (const id of wanted) if (variantFor(id) === void 0 && !configured.some((provider) => provider.id === id)) throw new Error(`unknown provider: ${id}`);
	return {
		variants: wanted.flatMap((id) => {
			const variant = variantFor(id);
			return variant === void 0 ? [] : [variant];
		}),
		providers: wanted.flatMap((id) => {
			const provider = configured.find((candidate) => candidate.id === id);
			return provider === void 0 ? [] : [provider];
		})
	};
}
/** Copy a descriptor with the bearer tokens blanked, for `--redact-token`. */
function redacted(descriptor) {
	return {
		...descriptor,
		endpoints: descriptor.endpoints.map((endpoint) => ({
			...endpoint,
			token: ""
		}))
	};
}
/** The identity key of the WSL forwarder serving one published endpoint. */
function wslPortKey(provider) {
	return `wsl:${provider}`;
}
/** The identity key of the WSL forwarder serving the web UI. */
const UI_WSL_PORT_KEY = "wsl-ui";
/**
* The publish step after a managed-provider mutation: re-read the bridge's
* endpoints, apply `--redact-token`, write the descriptor when the operator
* has not disabled it, and reconcile the WSL forwarders.
*
* It never rejects. A failure here is not a rollback — the saved change is
* already live in the bridge's runtime — so the operator is told exactly
* that. Two channels: the console line (for the operator at the terminal) and
* `providerWarning` in the state callback's mutable slot (so the page's next
* poll renders the persistent banner the UI shows). The mutation's own
* promise resolves only after this settles.
*/
const PROVIDER_WARNING_PUBLISH_FAILED = "Provider change saved, but endpoint publication failed.";
const PROVIDER_WARNING_SAVE_PUBLISH_FAILED = "Provider saved and active, but endpoint publication failed.";
async function publishAfterMutation(bridge, runtime) {
	let failed = false;
	try {
		const descriptor = await bridge.publish();
		failed = !await reconcileWslForwarders(bridge.endpoints(), runtime);
		const published = {
			...descriptor,
			endpoints: descriptor.endpoints.map((endpoint) => {
				const wsl = runtime.wslUrls.get(endpoint.baseUrl);
				return wsl === void 0 ? endpoint : {
					...endpoint,
					wslBaseUrl: wsl
				};
			})
		};
		if (runtime.descriptor) await writeBridgeDescriptor(runtime.redactToken ? redacted(published) : published);
	} catch (error) {
		failed = true;
		runtime.logger.error("workbuddy-bridge: the saved provider change is active, but publication failed — the descriptor and WSL addresses may be stale", error);
	}
	if (failed) runtime.providerWarning.value = runtime.lastMutationWasSave === true ? PROVIDER_WARNING_SAVE_PUBLISH_FAILED : PROVIDER_WARNING_PUBLISH_FAILED;
	else runtime.providerWarning.value = void 0;
}
/**
* Reconcile the WSL forwarders with the bridge's current endpoints.
*
* A forwarder is bound once per endpoint base URL and never rebound while its
* endpoint survives: editing a managed provider (a model-list change, a new
* upstream key) must not re-expose the same endpoint on a new port, because
* every restart-like churn makes clients re-copy their settings for nothing.
* Only genuinely new base URLs get a forwarder and only genuinely gone ones
* are closed — the registry is keyed by the loopback base URL itself, so the
* handle closed is exactly the one bound to that URL (ports cannot be matched
* by target, since the forwarder's *public* port has nothing to do with the
* target's). The registry holds **endpoint** forwarders only; the UI's own WSL
* forwarder lives outside it, so reconciling can never close the page's own
* access route.
*
* Resolves to `true` when every wanted endpoint ended up bound, `false` when
* any bind failed (the failure is also logged and flagged for the page) — a
* partial failure is not a throw, because the descriptor write that follows
* should still happen for the non-WSL world.
*/
async function reconcileWslForwarders(endpoints, runtime) {
	if (runtime.wslHost === void 0) return true;
	const byBaseUrl = new Map(endpoints.map((endpoint) => [endpoint.baseUrl, endpoint]));
	const wanted = new Set(byBaseUrl.keys());
	const closed = [];
	for (const [baseUrl, forwarder] of [...runtime.forwarders]) {
		if (wanted.has(baseUrl)) continue;
		runtime.forwarders.delete(baseUrl);
		runtime.wslUrls.delete(baseUrl);
		closed.push(forwarder.close().catch((error) => {
			runtime.logger.error(`workbuddy-bridge: could not close the WSL forwarder for ${baseUrl}`, error);
		}));
	}
	await Promise.all(closed);
	const bindings = [];
	for (const [baseUrl, endpoint] of byBaseUrl) {
		if (runtime.forwarders.has(baseUrl)) continue;
		const key = wslPortKey(endpoint.provider);
		const preferred = runtime.ports?.preferredPortFor(key);
		const forwarder = createWslForwarder({
			target: baseUrl,
			host: runtime.wslHost,
			logger: runtime.logger,
			...preferred === void 0 ? {} : { port: preferred }
		});
		runtime.forwarders.set(baseUrl, forwarder);
		bindings.push(forwarder.ready.then(() => {
			runtime.wslUrls.set(baseUrl, `${forwarder.url()}/v1`);
			runtime.ports?.rememberPortFor(key, forwarder.url());
			return true;
		}).catch((error) => {
			runtime.forwarders.delete(baseUrl);
			runtime.wslUrls.delete(baseUrl);
			runtime.providerWarning.value = PROVIDER_WARNING_PUBLISH_FAILED;
			runtime.logger.error(`workbuddy-bridge: could not expose ${baseUrl} on the WSL switch`, error);
			return false;
		}));
	}
	return (await Promise.all(bindings)).every(Boolean);
}
/** Render the endpoints for a human reader. */
function render(descriptor, showTokens) {
	const lines = [`${PROGRAM} ${WORKBUDDY_CONNECT_VERSION} — ${descriptor.endpoints.length} endpoint(s)`];
	const indent = " ".repeat(17);
	for (const endpoint of descriptor.endpoints) {
		const customPool = endpoint.provider === "custom-pool";
		const state = endpoint.signedIn ? `configured · ${endpoint.modelCount} models (failover pool)` : customPool ? "unavailable · no usable provider key" : "unavailable · no signed-in account";
		const token = showTokens && endpoint.token !== "" ? `  token: ${endpoint.token}` : "";
		lines.push(`  ${endpoint.displayName.padEnd(14)} ${endpoint.baseUrl}  ${state}${token}`);
		if (endpoint.wslBaseUrl !== void 0) lines.push(`${indent}wsl: ${endpoint.wslBaseUrl}`);
		if (endpoint.error !== void 0) lines.push(`${indent}reason: ${endpoint.error}`);
	}
	return lines.join("\n");
}
/** Print the copy-paste block an OpenAI-compatible client needs. */
function renderClientHint(descriptor) {
	const endpoint = descriptor.endpoints.find((candidate) => candidate.signedIn) ?? descriptor.endpoints[0];
	if (endpoint === void 0) return "";
	return [
		"",
		"Point any OpenAI-compatible client at:",
		`  base URL : ${endpoint.baseUrl}`,
		`  api key  : ${endpoint.token === "" ? "<see console output>" : endpoint.token}`
	].join("\n");
}
/** `serve` — start the bridge and hold the process open. */
async function serve(args) {
	const configured = await loadProviders(args.config);
	const { variants, providers } = resolveProviders(args.providerIds, configured);
	const authFiles = /* @__PURE__ */ new Map();
	if (args.authFileCN.length > 0) authFiles.set("workbuddy", args.authFileCN);
	if (args.authFileAI.length > 0) authFiles.set("workbuddy-ai", args.authFileAI);
	const logger = {
		warn: (...parts) => {
			console.warn(...parts);
		},
		error: (...parts) => {
			console.error(...parts);
		}
	};
	const bridge = new WorkBuddyBridge({
		variants,
		...providers.length === 0 ? {} : { providers },
		logger,
		...args.allAccounts ? { discoverAccounts: true } : {},
		...args.noCoalesceReasoning ? { coalesceReasoning: false } : {},
		...authFiles.size === 0 ? {} : { authFiles },
		manageProviders: true,
		persistEndpointIdentity: args.stableEndpoints,
		reuseEndpointTokens: args.stableEndpoints && args.descriptor
	});
	const wslUrls = /* @__PURE__ */ new Map();
	const forwarders = /* @__PURE__ */ new Map();
	let ui;
	let uiWslUrl;
	let uiWslForwarder;
	const providerWarning = { value: void 0 };
	const runtime = {
		forwarders,
		wslUrls,
		wslHost: void 0,
		/** Filled in once the bridge exists, so forwarders can ask for old ports. */
		ports: void 0,
		descriptor: args.descriptor,
		redactToken: args.redactToken,
		providerWarning,
		lastMutationWasSave: true,
		logger
	};
	try {
		const descriptor = await bridge.start();
		if (descriptor.endpoints.length === 0 && !args.ui) throw new Error("no provider could start a loopback endpoint");
		if (args.ui) {
			const preferredUiPort = bridge.preferredUiPort();
			ui = createWorkBuddyUiServer({
				state: async () => {
					const state = await bridge.uiState();
					return {
						...state,
						...providerWarning.value === void 0 ? {} : { providerWarning: providerWarning.value },
						endpoints: state.endpoints.map((endpoint) => {
							const wsl = wslUrls.get(endpoint.baseUrl);
							return wsl === void 0 ? endpoint : {
								...endpoint,
								wslBaseUrl: wsl
							};
						})
					};
				},
				probe: (request) => bridge.probePoolMember(request),
				providers: {
					list: () => bridge.listManagedProviders(),
					save: (input) => bridge.saveManagedProvider(input).then((snapshot) => {
						runtime.lastMutationWasSave = true;
						return publishAfterMutation(bridge, runtime).then(() => snapshot);
					}),
					remove: (input) => bridge.removeManagedProvider(input).then((snapshot) => {
						runtime.lastMutationWasSave = false;
						return publishAfterMutation(bridge, runtime).then(() => snapshot);
					})
				},
				allowedUiOrigins: () => [ui?.url(), uiWslUrl].filter((value) => value !== void 0),
				...preferredUiPort === void 0 ? {} : { port: preferredUiPort },
				logger
			});
			await ui.ready;
			await bridge.rememberUiPort(ui.url());
		}
		const wslHosts = wslHostAddresses();
		if (args.wsl && wslHosts[0] === void 0) console.warn("workbuddy-bridge: --wsl was given but no WSL virtual switch was found; nothing extra to expose");
		const wslHost = args.wsl ? wslHosts[0] : void 0;
		runtime.wslHost = wslHost;
		if (wslHost !== void 0) {
			runtime.ports = bridge;
			await reconcileWslForwarders(descriptor.endpoints, runtime);
			if (ui !== void 0) {
				const preferred = bridge.preferredPortFor(UI_WSL_PORT_KEY);
				const forwarder = createWslForwarder({
					target: ui.url(),
					host: wslHost,
					logger,
					...preferred === void 0 ? {} : { port: preferred }
				});
				await forwarder.ready;
				uiWslForwarder = forwarder;
				uiWslUrl = forwarder.url();
				await bridge.rememberPortFor(UI_WSL_PORT_KEY, uiWslUrl);
			}
		}
		const published = {
			...descriptor,
			endpoints: descriptor.endpoints.map((endpoint) => {
				const wsl = wslUrls.get(endpoint.baseUrl);
				return wsl === void 0 ? endpoint : {
					...endpoint,
					wslBaseUrl: wsl
				};
			})
		};
		if (args.descriptor) await writeBridgeDescriptor(args.redactToken ? redacted(published) : published);
		if (args.json) console.log(JSON.stringify({
			...args.redactToken ? redacted(published) : published,
			...ui === void 0 ? {} : { uiUrl: ui.url() },
			...uiWslUrl === void 0 ? {} : { uiWslUrl }
		}, null, 2));
		else {
			console.log(render(published, true));
			console.log(renderClientHint(published));
			if (ui !== void 0) console.log(`\nweb UI: ${ui.url()}`);
			if (uiWslUrl !== void 0) console.log(`web UI (WSL): ${uiWslUrl}`);
			if (wslUrls.size > 0) console.log("\nFrom inside WSL use the wsl: address above, or run `workbuddy-bridge env` from WSL.");
			else if (wslHosts[0] !== void 0) console.log(`\nhint: WSL switch detected at ${wslHosts[0]} — pass --wsl to also serve agents inside WSL.`);
			if (args.descriptor) console.log(`descriptor: ${bridgeDescriptorPath()}`);
		}
		await new Promise((resolve) => {
			const shutdown = () => {
				process.removeListener("SIGINT", shutdown);
				process.removeListener("SIGTERM", shutdown);
				resolve();
			};
			process.once("SIGINT", shutdown);
			process.once("SIGTERM", shutdown);
		});
	} finally {
		await Promise.all([...[...forwarders.values()].map((forwarder) => forwarder.close()), ...uiWslForwarder === void 0 ? [] : [uiWslForwarder.close()]]);
		await ui?.close();
		await bridge.close();
		if (args.descriptor) await removeBridgeDescriptor();
	}
}
/** Compact message text for a thrown value. */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
/** Ask one running endpoint for its model list. */
async function fetchModels(endpoint) {
	const response = await fetch(`${endpoint.baseUrl}/models`, { headers: { Authorization: `Bearer ${endpoint.token}` } });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return (await response.json()).data ?? [];
}
/**
* `models` — list what the running bridge serves.
*
* Reads the descriptor rather than starting anything, so it reports on the
* bridge that is actually running. An endpoint with no models is not an
* error: it means that product has no usable credential, which the upstream
* shim deliberately renders as an empty list rather than a roster that could
* only fail.
*/
async function models(args) {
	const descriptor = await readBridgeDescriptor();
	if (descriptor === void 0) {
		console.error(`no running ${PROGRAM} (no descriptor at ${bridgeDescriptorPath()})`);
		process.exitCode = 1;
		return;
	}
	const collected = await Promise.all(descriptor.endpoints.map(async (endpoint) => {
		try {
			return {
				endpoint,
				list: await fetchModels(endpoint),
				error: void 0
			};
		} catch (error) {
			return {
				endpoint,
				list: [],
				error: messageOf(error)
			};
		}
	}));
	if (args.json) {
		console.log(JSON.stringify(collected.map((entry) => ({
			provider: entry.endpoint.provider,
			displayName: entry.endpoint.displayName,
			baseUrl: entry.endpoint.baseUrl,
			signedIn: entry.endpoint.signedIn,
			models: entry.list.map((model) => model.id),
			...entry.endpoint.error === void 0 ? {} : { credentialError: entry.endpoint.error },
			...entry.error === void 0 ? {} : { error: entry.error }
		})), null, 2));
		return;
	}
	for (const { endpoint, list, error } of collected) {
		console.log(`\n${endpoint.displayName}  ${endpoint.baseUrl}`);
		if (error !== void 0) {
			console.log(`  error: ${error}`);
			continue;
		}
		if (list.length === 0) {
			console.log(endpoint.error === void 0 ? "  (no models — this product has no usable credential)" : `  (no models — ${endpoint.error})`);
			continue;
		}
		console.log(`  ${list.length} model(s):`);
		for (const model of list) console.log(`    ${model.id}`);
	}
}
/** How long one `test` chat turn may take before it is abandoned. */
const CHAT_PROBE_TIMEOUT_MS = 6e4;
/**
* Send one minimal streaming chat turn to a running endpoint.
*
* Deliberately end-to-end: it uses the same base URL, bearer token and
* `/chat/completions` path an agent would, so a pass is evidence the whole
* chain works — shim gates, credential resolution, upstream acceptance — and a
* failure carries the upstream's own words instead of a classification of them.
*
* The request itself lives in `account-probe.ts`, shared with the web UI's
* per-account test button: the two ask the same question of the same endpoint,
* and two copies of the SSE parse would eventually disagree about what a pass
* looks like.
*/
async function chatProbe(route, baseUrl, token, model) {
	const result = await probeChatTurn({
		baseUrl,
		token,
		model,
		timeoutMs: CHAT_PROBE_TIMEOUT_MS
	});
	return {
		route,
		baseUrl,
		ok: result.ok,
		detail: result.detail
	};
}
/**
* `test` — prove whether a real chat turn works, and over which route.
*
* "I cannot use it" has several causes that look identical from an agent's
* side: a dead bridge, a stale port, a missing credential, an upstream refusal,
* or a broken WSL hop. Probing both routes separates them, and printing the
* upstream's own text keeps the answer factual.
*/
async function test(args) {
	const descriptor = await readBridgeDescriptor();
	if (descriptor === void 0) {
		console.error(`no running ${PROGRAM} (no descriptor at ${bridgeDescriptorPath()})`);
		process.exitCode = 1;
		return;
	}
	const selected = new Set(args.providerIds.flatMap((selection) => {
		const byId = descriptor.endpoints.filter((candidate) => candidate.provider === selection);
		if (byId.length > 0) return byId;
		const byName = descriptor.endpoints.filter((candidate) => candidate.displayName === selection);
		if (byName.length > 0) return byName;
		return selectedIds([selection]).flatMap((id) => {
			const byAlias = descriptor.endpoints.filter((candidate) => candidate.provider === id || candidate.provider === `${id}-pool`);
			if (byAlias.length === 0) throw new Error(`unknown provider: ${selection}`);
			return byAlias;
		});
	}));
	const eligible = args.providerIds.length === 0 ? descriptor.endpoints : descriptor.endpoints.filter((candidate) => selected.has(candidate));
	const endpoint = eligible.find((candidate) => candidate.signedIn) ?? eligible[0];
	if (endpoint === void 0) {
		console.error("the running bridge serves no endpoints");
		process.exitCode = 1;
		return;
	}
	let model = args.model;
	if (model === void 0) try {
		model = (await fetchModels(endpoint))[0]?.id;
	} catch {}
	if (model === void 0) {
		console.error(`${endpoint.displayName} serves no model to test against` + (endpoint.error === void 0 ? " (no usable credential)" : ` (${endpoint.error})`));
		process.exitCode = 1;
		return;
	}
	const routes = [{
		route: "loopback",
		baseUrl: endpoint.baseUrl
	}];
	if (endpoint.wslBaseUrl !== void 0 && endpoint.wslBaseUrl !== "") routes.push({
		route: "wsl",
		baseUrl: endpoint.wslBaseUrl
	});
	const results = [];
	for (const route of routes) results.push(await chatProbe(route.route, route.baseUrl, endpoint.token, model));
	if (args.json) console.log(JSON.stringify({
		provider: endpoint.provider,
		model,
		results
	}, null, 2));
	else {
		console.log(`${endpoint.displayName}  model: ${model}`);
		for (const result of results) {
			console.log(`  ${result.route.padEnd(9)} ${result.baseUrl}`);
			console.log(`  ${" ".repeat(9)} ${result.ok ? "OK" : "FAILED"} — ${result.detail}`);
		}
		if (routes.length === 1) console.log("\n(no WSL route to test: the bridge was started without --wsl)");
		if (variantFor(endpoint.provider.replace(/-pool$/u, "")) !== void 0 && results.some((result) => !result.ok) && existsSync(channelFailurePath())) console.log(`\nfailing exchange captured at: ${channelFailurePath()}`);
	}
	if (results.some((result) => !result.ok)) process.exitCode = 1;
}
/** `status` — report the running bridge from its descriptor. */
async function status(args) {
	const descriptor = await readBridgeDescriptor();
	if (descriptor === void 0) {
		console.log(args.json ? "{}" : `no running ${PROGRAM} (no descriptor at ${bridgeDescriptorPath()})`);
		return;
	}
	const alive = isProcessAlive(descriptor.pid);
	if (args.json) {
		console.log(JSON.stringify({
			...descriptor,
			alive
		}, null, 2));
		return;
	}
	console.log(render(descriptor, true));
	console.log(`\npid ${descriptor.pid} (${alive ? "running" : "not running"})`);
	console.log(`descriptor: ${bridgeDescriptorPath()}`);
}
/** `env` — print shell exports for the running bridge. */
async function env() {
	const descriptor = await readBridgeDescriptor();
	if (descriptor === void 0) {
		console.error(`no running ${PROGRAM} (no descriptor at ${bridgeDescriptorPath()})`);
		process.exitCode = 1;
		return;
	}
	const endpoint = descriptor.endpoints.find((candidate) => candidate.signedIn) ?? descriptor.endpoints[0];
	if (endpoint === void 0) {
		console.error("the running bridge serves no endpoints");
		process.exitCode = 1;
		return;
	}
	const inWsl = isRunningInWsl();
	const baseUrl = inWsl && endpoint.wslBaseUrl !== void 0 ? endpoint.wslBaseUrl : endpoint.baseUrl;
	if (inWsl && endpoint.wslBaseUrl === void 0) console.error(`warning: running inside WSL but the bridge was started without --wsl, so ${endpoint.baseUrl} is unreachable from here; restart it with --wsl`);
	console.log(`export OPENAI_BASE_URL=${baseUrl}`);
	console.log(`export OPENAI_API_KEY=${endpoint.token}`);
}
/** Whether a pid is currently alive; used only to annotate `status`. */
function isProcessAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
/** Entry point. */
async function main(argv = process.argv.slice(2)) {
	const args = parseArgs(argv);
	if (args.home !== void 0 && args.home !== "") process.env["WORKBUDDY_BRIDGE_HOME"] = args.home;
	switch (args.command) {
		case "help":
			console.log(USAGE);
			return;
		case "status":
			await status(args);
			return;
		case "models":
			await models(args);
			return;
		case "test":
			await test(args);
			return;
		case "env":
			await env();
			return;
		case "serve":
			await serve(args);
			return;
	}
}
//#endregion
export { portOfBaseUrl as A, attemptRecord as B, writeUpstreamTurn as C, UI_IDENTITY_KEY as D, ENDPOINT_IDENTITY_FILENAME as E, probeChatTurn as F, readBridgeDescriptor as G, BRIDGE_DESCRIPTOR_FILENAME as H, coalesceReasoning as I, createWslForwarder as J, removeBridgeDescriptor as K, REQUEST_LOG_LIMIT as L, POOL_FAILOVER_KINDS as M, WorkBuddyFailoverPool as N, endpointIdentityPath as O, CHAT_PROBE_TIMEOUT_MS$1 as P, REQUEST_ROWS_PER_CARD as R, upstreamStatusRetryable as S, parseProviderConfig as T, bridgeDescriptorCandidates as U, modelOfBody as V, bridgeDescriptorPath as W, wslHostAddresses as X, isRunningInWsl as Y, poolMemberAvailable as _, redactForBrowser as a, createOpenAICompatibleShim as b, MANAGED_PROVIDERS_VERSION as c, CUSTOM_POOL_ID as d, CustomPoolRequestError as f, errorKindForStatus as g, createCustomProviderPoolShim as h, createWorkBuddyUiServer as i, rememberEndpointIdentity as j, loadEndpointIdentities as k, ProviderManagementError as l, capturePoolMembers as m, WorkBuddyBridge as n, MANAGED_PROVIDERS_DIRNAME as o, CustomProviderFailoverPool as p, writeBridgeDescriptor as q, UiRequestError as r, MANAGED_PROVIDERS_FILENAME as s, main as t, WorkBuddyManagedProviderStore as u, poolModelList as v, PROVIDER_CONFIG_VERSION as w, startUpstreamTurn as x, UPSTREAM_ERROR_BODY_LIMIT as y, WorkBuddyRequestLog as z };
