import { D as isChannelValidationBlock, Q as WORKBUDDY_BRIDGE_HOME_DIRNAME, _ as CN_VARIANT, b as variantFor, d as discoverDesktopAuthFiles, et as resolveBridgeHome, h as atRestKeyProviderFor, i as WorkBuddyCatalog, k as normalizeCredits, n as FALLBACK_WORKBUDDY_AI_MODELS, nt as writeFileAtomic, r as FALLBACK_WORKBUDDY_MODELS, s as WorkBuddyCredentialStore, t as WORKBUDDY_CONNECT_VERSION, v as WORKBUDDY_VARIANTS, w as WorkBuddyUpstreamClient } from "./version-C9bGUHfn.js";
import { a as originIsLoopback, c as workbuddyCatalogPath, i as hostnameOfHost, r as hostIsLoopback, s as WorkBuddyCatalogStore, t as createWorkBuddyShim } from "./shim-0L42PFZY.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer, request } from "node:http";
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
	const ready = new Promise((resolve, reject) => {
		server.once("listening", () => {
			resolve();
		});
		server.once("error", reject);
	});
	server.listen(0, host);
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
				Authorization: `Bearer ${options.token}`
			},
			body: JSON.stringify({
				model: options.model,
				stream: true,
				messages: [{
					role: "user",
					content: "Reply with the single word: ok"
				}],
				max_tokens: 8
			}),
			signal: controller.signal
		});
		const text = await response.text();
		const latencyMs = Date.now() - startedAtMs;
		if (!response.ok) return {
			ok: false,
			status: response.status,
			latencyMs,
			detail: `HTTP ${response.status}: ${text.slice(0, 400)}`
		};
		const delta = /"content"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
		const parts = [`HTTP ${response.status}`, `${text.length} bytes`];
		if (text.includes("[DONE]")) parts.push("terminated");
		parts.push(delta === null ? "no text delta" : `first text: ${(delta[1] ?? "").slice(0, 60)}`);
		return {
			ok: true,
			status: response.status,
			latencyMs,
			detail: parts.join(", ")
		};
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
//#endregion
//#region src/standalone/pool.ts
/**
* Upstream failure classes where a different account could plausibly
* succeed, and are therefore worth failing over on:
*
* - `hard_credit` — this account's quota is gone; another account's is not
* - `soft_rate` — this account is throttled; another is not
* - `session_dead` — this credential cannot be renewed; another may be fine
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
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/** The Host/Origin loopback pair, identical to the upstream status route's gate. */
function loopbackRequest(req) {
	return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin);
}
/** Largest probe body accepted; the page sends a provider name and an index. */
const PROBE_BODY_LIMIT = 8192;
/** Header the page repeats the nonce in. Custom, so it forces a preflight. */
const PROBE_HEADER = "x-bridge-ui";
/** Read a request body with a size cap. */
async function readBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		size += buffer.length;
		if (size > PROBE_BODY_LIMIT) throw new UiRequestError(413, "request body too large");
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
* Start the UI server.
*
* Returns `ready` rather than awaiting the listen, so a caller can hold the
* handle before the port is known — the same shape the shim exposes.
*/
function createWorkBuddyUiServer(options) {
	const { state, probe, logger } = options;
	const nonce = randomUUID();
	const page = PAGE.replace("\"__UI_NONCE__\"", JSON.stringify(nonce));
	const server = createServer((req, res) => {
		handle(req, res);
	});
	const ready = new Promise((resolve, reject) => {
		server.once("listening", () => {
			resolve();
		});
		server.once("error", reject);
	});
	server.listen(0, "127.0.0.1");
	const url = () => {
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("workbuddy UI has no listening address");
		return `http://127.0.0.1:${address.port}`;
	};
	async function handle(req, res) {
		try {
			if (!loopbackRequest(req)) {
				writeJson(res, 403, { error: "request-not-trusted" });
				return;
			}
			const path = (req.url ?? "/").split("?")[0];
			if (req.method === "GET") {
				if (path === "/" || path === "/index.html") {
					res.writeHead(200, {
						"Content-Type": "text/html; charset=utf-8",
						"Content-Length": Buffer.byteLength(page),
						"Cache-Control": "no-store"
					});
					res.end(page);
					return;
				}
				if (path === "/api/state") {
					writeJson(res, 200, redactState(await state()));
					return;
				}
				writeJson(res, 404, { error: `no such route: ${req.method} ${path}` });
				return;
			}
			if (req.method === "POST" && path === "/api/pool/test") {
				if (req.headers[PROBE_HEADER] !== nonce) {
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
				const request = parseProbeRequest(await readBody(req));
				const result = await probe(request);
				writeJson(res, 200, {
					...result,
					detail: redactForBrowser(result.detail)
				});
				return;
			}
			writeJson(res, 405, { error: "method not allowed" });
		} catch (error) {
			if (error instanceof UiRequestError) {
				writeJson(res, error.status, { error: error.message });
				return;
			}
			logger?.warn("workbuddy-bridge: UI request failed", error);
			if (!res.headersSent) writeJson(res, 500, { error: "internal" });
			else res.end();
		}
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
</header>
<main id="app"></main>
<footer><p class="dim">A test sends one real chat turn through that account's own endpoint — it spends a few credits and does not move the pool's head.</p></footer>
<script>
var UI_NONCE = "__UI_NONCE__";
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
function modelsTable(models) {
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
  var html = '<div class="notice">One endpoint over ' + p.members.length + ' accounts. The next request is answered by '
    + '<strong>' + esc(memberLabel(p, p.headIndex)) + '</strong>. A test runs against that account only — '
    + 'it does not move the head.</div>';
  /* The test controls live here rather than in the card head: they act on the
     member table below them, and a header control that does nothing on the
     Models tab would be a dead button. */
  html += '<div class="toolbar">' + modelPicker(ep)
    + '<button class="test-all" data-test-all="' + esc(ep.provider) + '">Test all</button></div>';
  html += '<table class="members"><thead><tr><th>Account</th><th>State</th>'
        + '<th class="num">Credits</th><th>Last routed turn</th><th>Test</th></tr></thead><tbody>';
  for (var i = 0; i < p.members.length; i++) {
    var m = p.members[i];
    var t = testOf(ep.provider, m.index);
    var busy = t !== undefined && t.running;
    var state = '<div class="who">'
      + '<span class="pill ' + (m.signedIn ? 'ok' : 'bad') + '">' + (m.signedIn ? 'signed in' : 'signed out') + '</span>';
    if (m.head) {
      state += m.signedIn
        ? '<span class="pill head">next</span>'
        : '<span class="pill warn">next · signed out</span>';
    }
    if (m.consecutiveFailures > 0) {
      state += '<span class="pill bad">' + m.consecutiveFailures + ' fail in a row</span>';
    }
    state += '<span class="sub">' + fmtNum(m.successes) + ' ok / ' + fmtNum(m.failures) + ' failed</span></div>';
    html += '<tr' + (m.head ? ' class="head"' : '') + '>'
          + '<td><div class="who"><span class="name">' + esc(m.label) + '</span>'
          + (m.uid ? '<span class="sub">' + esc(m.uid) + '</span>' : '')
          + '<span class="sub">' + esc(m.baseUrl) + '</span></div></td>'
          + '<td>' + state + '</td>'
          + '<td class="num">' + creditsCell(m) + '</td>'
          + '<td>' + attemptCell(m) + '</td>'
          + '<td><button class="test" data-test-provider="' + esc(ep.provider) + '" data-test-index="' + m.index + '"'
          + (busy ? ' disabled' : '') + '>' + (busy ? 'testing…' : 'Test') + '</button>'
          + resultCell(ep.provider, m.index) + '</td></tr>';
  }
  return html + '</tbody></table>';
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
var activeTabs = {};
var showAccounts = false;
function tabOf(provider) { return activeTabs[provider] || 'account'; }
function tabStrip(ep) {
  var active = tabOf(ep.provider);
  var tabs = [
    { id: 'account', label: 'Account' },
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
  var html = '';
  var meta = [];
  if (ep.catalogSource) meta.push('catalog: ' + ep.catalogSource);
  if (ep.catalogFetchedAtMs) meta.push('fetched ' + fmtTime(ep.catalogFetchedAtMs));
  if (ep.source) meta.push('credential: ' + ep.source);
  if (ep.expiresAtMs) meta.push('expires ' + fmtTime(ep.expiresAtMs));
  if (meta.length) html += '<div class="meta">' + esc(meta.join('  ·  ')) + '</div>';
  if (ep.error) html += noticeOf(ep.error, true);
  html += creditsBlock(ep);
  html += poolBlock(ep);
  return html;
}
function renderCard(ep) {
  var active = tabOf(ep.provider);
  var html = '<section class="card" data-provider="' + esc(ep.provider) + '">';
  html += '<div class="card-head"><div class="card-title">';
  html += '<h2>' + esc(ep.displayName) + '</h2>';
  html += '<span class="pill ' + (ep.signedIn ? 'ok' : 'bad') + '">' + (ep.signedIn ? 'signed in' : 'signed out') + '</span>';
  if (ep.nickname) html += '<span class="pill">' + esc(ep.nickname) + '</span>';
  if (ep.domain) html += '<span class="pill">' + esc(ep.domain) + '</span>';
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
      html += '<label><span class="conn-label">API Key</span>'
        + '<input readonly value="' + esc(ep.token) + '" onclick="this.select()"></label>';
    }
    html += '</div>';
  }
  html += tabStrip(ep);
  html += '</div>';
  html += panel('account', active, accountPanel(ep));
  html += panel('models', active, modelsTable(ep.models || []));
  html += panel('logs', active, requestsTable(ep));
  html += '</section>';
  return html;
}
function render(state) {
  lastState = state;
  document.getElementById('version').textContent = 'v' + (state.version === 1 ? '1' : '?');
  document.getElementById('updated').textContent = 'updated ' + new Date(state.nowMs).toLocaleTimeString();
  var app = document.getElementById('app');
  if (!state.endpoints || !state.endpoints.length) {
    app.innerHTML = '<div class="notice">No endpoints are being served.</div>';
    return;
  }
  var pools = [];
  var accounts = [];
  for (var i = 0; i < state.endpoints.length; i++) {
    var ep = state.endpoints[i];
    if (ep.pool !== undefined) pools.push(ep);
    else accounts.push(ep);
  }
  var html = '';
  for (var p = 0; p < pools.length; p++) html += renderCard(pools[p]);
  /* A global toggle is cleaner than one per card: the question is "do I want
     to see the individual accounts at all?" not "do I want to see alice?". */
  if (accounts.length) {
    html += '<div class="account-toggle-bar">'
      + '<button class="account-toggle" data-toggle-accounts="1">'
      + (showAccounts ? 'Hide accounts' : 'Show ' + accounts.length + ' account' + (accounts.length > 1 ? 's' : ''))
      + '</button></div>';
    if (showAccounts) {
      for (var a = 0; a < accounts.length; a++) html += renderCard(accounts[a]);
    }
  }
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
  /* Global show/hide for individual account cards. Pools are always visible. */
  if (button.dataset.toggleAccounts !== undefined) {
    showAccounts = !showAccounts;
    if (lastState) render(lastState);
    return;
  }
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
});
document.getElementById('app').addEventListener('change', function (event) {
  var target = event.target;
  if (target && target.dataset && target.dataset.modelProvider !== undefined) {
    chosenModels[target.dataset.modelProvider] = target.value;
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
timer = setInterval(load, 5000);
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
* One variant's endpoint display name, including its account when the variant
* serves several. A single-account runtime keeps the bare product name, so
* nothing changes for the common case; with multiple accounts each endpoint
* must say whose credentials it speaks for, preferring the account's own
* nickname and falling back to its position while the sweep has not yet seen
* a credential.
*/
function endpointDisplayName(runtime) {
	if (runtime.accountTotal <= 1) return runtime.variant.displayName;
	const who = runtime.nickname ?? runtime.uid ?? `account ${runtime.accountIndex}`;
	return `${runtime.variant.displayName} · ${who}`;
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
	options;
	/** Probe keys (`provider#index`) currently in flight, so a double click cannot double-spend. */
	probes = /* @__PURE__ */ new Set();
	/** The turns agents have sent, for the UI. Metadata only, in memory, bounded. */
	requests = new WorkBuddyRequestLog();
	timer;
	stopped = false;
	startedAtMs = 0;
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
			...input.account === void 0 ? {} : { account: input.account },
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
		this.startedAtMs = Date.now();
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
		if (this.options.pool === "failover") await this.startPools(variants);
		await this.syncAll();
		const descriptor = await this.publish();
		this.timer = setInterval(() => {
			this.syncAll().then(() => this.publish());
		}, credentialPollMs());
		this.timer.unref?.();
		return descriptor;
	}
	/**
	* One pool endpoint per product that serves two or more accounts.
	*
	* The pool rides on the same shim the accounts use — same gates, same
	* per-process secret — but its store and client are the failover router,
	* so the shim never learns the difference. Only products with several
	* accounts get one: a single-member pool would just duplicate that
	* account's own endpoint with a second port to configure.
	*/
	async startPools(variants) {
		const logger = this.options.logger;
		for (const variant of variants) {
			const members = this.runtimes.filter((runtime) => runtime.variant.id === variant.id);
			if (members.length < 2) continue;
			const catalog = new WorkBuddyCatalog(fallbackFor(variant));
			if (variant.id !== CN_VARIANT.id) catalog.setUseMaximumContextWindow(true);
			catalog.setVisible(false);
			const pool = new WorkBuddyFailoverPool(members.map((runtime) => ({
				store: runtime.store,
				client: { chatStream: async (credential, bodyJson, signal) => {
					const result = await runtime.client.chatStream(credential, bodyJson, signal);
					captureChannelFailure(variant.id, bodyJson, result);
					return this.finishChat(result);
				} }
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
				...logger === void 0 ? {} : { logger }
			});
			try {
				await shim.ready;
			} catch (error) {
				logger?.error(`workbuddy-bridge: ${variant.displayName} pool endpoint failed to start`, error);
				continue;
			}
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
			endpoints: [...this.runtimes.map((runtime) => this.endpointOf(runtime)), ...this.pools.map((pool) => this.poolEndpointOf(pool))]
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
		return [...this.runtimes.map((runtime) => this.endpointOf(runtime)), ...this.pools.map((pool) => this.poolEndpointOf(pool))];
	}
	/**
	* Build the web UI's state document. Carries the bearer token so the user
	* can copy it from the pool card. The page itself is still unauthenticated —
	* it relies on the Host/Origin loopback gate — but the token is now part of
	* the rendered state.
	*/
	async uiState() {
		const endpoints = [];
		const rows = /* @__PURE__ */ new Map();
		for (const runtime of this.runtimes) {
			const row = await this.uiEndpointOf(runtime);
			rows.set(runtime, row);
			endpoints.push(row);
		}
		for (const pool of this.pools) endpoints.push(this.uiPoolOf(pool, rows));
		return {
			version: 1,
			startedAtMs: this.startedAtMs,
			nowMs: Date.now(),
			endpoints
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
	uiPoolOf(pool, rows) {
		const health = pool.pool.memberHealth();
		const headIndex = pool.pool.headIndex();
		return {
			provider: `${pool.variant.id}-pool`,
			displayName: `${pool.variant.displayName} · pool (failover)`,
			baseUrl: `${pool.shim.baseUrl()}/v1`,
			token: pool.shim.token(),
			signedIn: pool.members.some((runtime) => runtime.identity !== void 0),
			models: pool.catalog.current().map(uiModelOf),
			requests: this.uiRequestsOf(`${pool.variant.id}-pool`),
			pool: {
				headIndex,
				members: pool.members.map((runtime, index) => this.uiPoolMemberOf(runtime, index, headIndex, health[index], rows.get(runtime)))
			},
			...pool.members.every((runtime) => runtime.identity === void 0) ? { error: "no account in the pool is signed in" } : {}
		};
	}
	/** One pool member row, assembled from the runtime, its health, and its account card. */
	uiPoolMemberOf(runtime, index, headIndex, health, row) {
		return {
			index,
			accountIndex: runtime.accountIndex,
			label: runtime.nickname ?? runtime.uid ?? `account ${runtime.accountIndex}`,
			...runtime.uid === void 0 ? {} : { uid: runtime.uid },
			signedIn: runtime.identity !== void 0,
			baseUrl: `${runtime.shim.baseUrl()}/v1`,
			head: index === headIndex,
			successes: health?.successes ?? 0,
			failures: health?.failures ?? 0,
			consecutiveFailures: health?.consecutiveFailures ?? 0,
			...health === void 0 || health.lastAttemptAtMs <= 0 ? {} : { lastAttemptAtMs: health.lastAttemptAtMs },
			...attemptText(health?.lastOutcome),
			...row?.credits === void 0 ? {} : { credits: row.credits },
			...row?.creditsError === void 0 ? {} : { creditsError: row.creditsError }
		};
	}
	/**
	* Send one real chat turn through one pool member, for the page's test button.
	*
	* Routed through the account's **own** shim, not the pool: the claim being
	* tested is "this account can answer", which means the same gates, the same
	* credential resolution and the same upstream call an agent pointed at that
	* account would get. The pool is deliberately untouched — a manual test must
	* not move the head, or checking a spare account would silently redirect
	* live traffic onto it.
	*/
	async probePoolMember(request) {
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
			const result = await (this.options.probe ?? probeChatTurn)({
				baseUrl: `${member.shim.baseUrl()}/v1`,
				token: member.shim.token(),
				model
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
	/** One endpoint's UI row, including a live credit read. */
	async uiEndpointOf(runtime) {
		const base = {
			provider: runtime.variant.id,
			displayName: endpointDisplayName(runtime),
			baseUrl: `${runtime.shim.baseUrl()}/v1`,
			token: runtime.shim.token(),
			signedIn: runtime.identity !== void 0,
			models: runtime.catalog.current().map(uiModelOf),
			requests: this.uiRequestsOf(`${runtime.variant.id}#${runtime.accountIndex}`),
			...runtime.error === void 0 ? {} : { error: runtime.error },
			...runtime.uid === void 0 ? {} : { uid: runtime.uid }
		};
		let credential;
		try {
			credential = await runtime.store.current();
		} catch {
			return base;
		}
		if (credential === void 0) return base;
		const last = runtime.client.lastCatalog;
		const withIdentity = {
			...base,
			...credential.nickname === void 0 ? {} : { nickname: credential.nickname },
			...credential.domain === "" ? {} : { domain: credential.domain },
			...credential.expiresAtMs <= 0 ? {} : { expiresAtMs: credential.expiresAtMs },
			source: credential.source,
			...last === void 0 ? {} : {
				catalogSource: last.source,
				catalogFetchedAtMs: last.fetchedAtMs
			}
		};
		try {
			return {
				...withIdentity,
				credits: uiCreditsOf(await runtime.client.fetchCredits(credential))
			};
		} catch (error) {
			return {
				...withIdentity,
				creditsError: messageOf$1(error)
			};
		}
	}
	/** Stop serving and destroy open connections. */
	async close() {
		this.stopped = true;
		if (this.timer !== void 0) clearInterval(this.timer);
		this.timer = void 0;
		await Promise.all([...this.runtimes.map((runtime) => runtime.shim.close()), ...this.pools.map((pool) => pool.shim.close())]);
		this.runtimes.length = 0;
		this.pools.length = 0;
	}
	endpointOf(runtime) {
		return {
			provider: runtime.variant.id,
			displayName: endpointDisplayName(runtime),
			baseUrl: `${runtime.shim.baseUrl()}/v1`,
			token: runtime.shim.token(),
			modelCount: runtime.catalog.current().length,
			signedIn: runtime.identity !== void 0,
			...runtime.error === void 0 ? {} : { error: runtime.error }
		};
	}
	/** The pool's descriptor row. Provider id gets a `-pool` suffix so tooling that filters by product id does not match it. */
	poolEndpointOf(pool) {
		return {
			provider: `${pool.variant.id}-pool`,
			displayName: `${pool.variant.displayName} · pool (failover)`,
			baseUrl: `${pool.shim.baseUrl()}/v1`,
			token: pool.shim.token(),
			modelCount: pool.catalog.current().length,
			signedIn: pool.members.some((runtime) => runtime.identity !== void 0)
		};
	}
	async startVariant(variant, account) {
		const logger = this.options.logger;
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
		const savedCatalogs = account.savedCatalogs;
		let runtime;
		const shim = createWorkBuddyShim({
			store,
			client: { chatStream: async (credential, bodyJson, signal) => {
				const startedAtMs = Date.now();
				const result = await client.chatStream(credential, bodyJson, signal);
				if (runtime !== void 0) this.noteTurn({
					endpoint: `${variant.id}#${runtime.accountIndex}`,
					account: runtime.nickname ?? `account ${runtime.accountIndex}`,
					bodyJson,
					result,
					latencyMs: Date.now() - startedAtMs
				});
				captureChannelFailure(variant.id, bodyJson, result);
				return this.finishChat(result);
			} },
			catalog,
			...logger === void 0 ? {} : { logger }
		});
		try {
			await shim.ready;
		} catch (error) {
			logger?.error(`workbuddy-bridge: ${variant.displayName} loopback endpoint failed to start`, error);
			return;
		}
		runtime = {
			variant,
			store,
			client,
			catalog,
			savedCatalogs,
			shim,
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
		return runtime;
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
                                 shows each pool account and can test it
  ${PROGRAM} test [options]      send one real chat turn through the running
                                 bridge, over both the loopback and WSL routes
  ${PROGRAM} models [--json]     list the models the running bridge serves
  ${PROGRAM} status [--json]     show the running bridge, if any
  ${PROGRAM} env                 print shell exports for the running bridge
  ${PROGRAM} help                show this text

Options:
  --provider <cn|ai|both>   which product(s) to serve (default: both)
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
  --pool failover           also serve one pool endpoint per product with 2+
                            accounts; a request another account could survive
                            (out of credits, rate limit, dead session, 5xx)
                            is retried on the next account
  --no-coalesce-reasoning   forward reasoning deltas exactly as the upstream
                            sends them (by default tiny per-word deltas are
                            regrouped, so clients show paragraphs rather than
                            one thinking block per word)
  --home <dir>              override the bridge home directory
  --no-descriptor           do not write the endpoint descriptor file
  --redact-token            write the descriptor without the bearer token
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

The port and bearer token are chosen per process, exactly as the upstream
shim does. Re-read the descriptor (or \`${PROGRAM} env\`) after each restart.
`;
/** Parse argv into the shape the commands consume. */
function parseArgs(argv) {
	const args = {
		command: "serve",
		ui: false,
		wsl: false,
		allAccounts: false,
		pool: void 0,
		noCoalesceReasoning: false,
		providerIds: [],
		model: void 0,
		descriptor: true,
		redactToken: false,
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
			case "--pool": {
				const value = argv[index += 1];
				if (value !== "failover") throw new Error(`--pool must be "failover", got: ${value ?? "(missing)"}`);
				args.pool = value;
				break;
			}
			case "--no-coalesce-reasoning":
				args.noCoalesceReasoning = true;
				break;
			case "help":
			case "--help":
			case "-h":
				args.command = "help";
				break;
			case "--provider": {
				const value = argv[index += 1];
				if (value === void 0) throw new Error("--provider needs a value");
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
/**
* Resolve the requested providers to variant descriptors.
*
* `cn` and `ai` are accepted as the friendly spellings of the two provider
* ids, so a user does not have to know that the international one is called
* `workbuddy-ai` on the wire.
*/
function resolveVariants(providerIds) {
	if (providerIds.length === 0) return WORKBUDDY_VARIANTS;
	const aliases = {
		cn: "workbuddy",
		ai: "workbuddy-ai"
	};
	return providerIds.flatMap((id) => {
		if (id === "both") return WORKBUDDY_VARIANTS.map((variant) => variant.id);
		return [aliases[id] ?? id];
	}).flatMap((id) => {
		const variant = variantFor(id);
		if (variant === void 0) throw new Error(`unknown provider: ${id}`);
		return [variant];
	});
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
/** Render the endpoints for a human reader. */
function render(descriptor, showTokens) {
	const lines = [`${PROGRAM} ${WORKBUDDY_CONNECT_VERSION} — ${descriptor.endpoints.length} endpoint(s)`];
	const indent = " ".repeat(17);
	for (const endpoint of descriptor.endpoints) {
		const state = endpoint.signedIn ? `${endpoint.modelCount} models` : "signed out";
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
	const variants = resolveVariants(args.providerIds);
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
		logger,
		...args.allAccounts ? { discoverAccounts: true } : {},
		...args.pool === void 0 ? {} : { pool: args.pool },
		...args.noCoalesceReasoning ? { coalesceReasoning: false } : {},
		...authFiles.size === 0 ? {} : { authFiles }
	});
	const descriptor = await bridge.start();
	if (descriptor.endpoints.length === 0) throw new Error("no WorkBuddy variant could start a loopback endpoint");
	const wslUrls = /* @__PURE__ */ new Map();
	let ui;
	if (args.ui) {
		ui = createWorkBuddyUiServer({
			state: async () => {
				const state = await bridge.uiState();
				return {
					...state,
					endpoints: state.endpoints.map((endpoint) => {
						const wsl = wslUrls.get(endpoint.provider);
						return wsl === void 0 ? endpoint : {
							...endpoint,
							wslBaseUrl: wsl
						};
					})
				};
			},
			probe: (request) => bridge.probePoolMember(request),
			logger
		});
		await ui.ready;
	}
	const wslHosts = wslHostAddresses();
	const forwarders = [];
	let uiWslUrl;
	if (args.wsl && wslHosts[0] === void 0) console.warn("workbuddy-bridge: --wsl was given but no WSL virtual switch was found; nothing extra to expose");
	const wslHost = args.wsl ? wslHosts[0] : void 0;
	if (wslHost !== void 0) {
		for (const endpoint of descriptor.endpoints) {
			const forwarder = createWslForwarder({
				target: endpoint.baseUrl,
				host: wslHost,
				logger
			});
			await forwarder.ready;
			forwarders.push(forwarder);
			wslUrls.set(endpoint.provider, `${forwarder.url()}/v1`);
		}
		if (ui !== void 0) {
			const forwarder = createWslForwarder({
				target: ui.url(),
				host: wslHost,
				logger
			});
			await forwarder.ready;
			forwarders.push(forwarder);
			uiWslUrl = forwarder.url();
		}
	}
	const published = {
		...descriptor,
		endpoints: descriptor.endpoints.map((endpoint) => {
			const wsl = wslUrls.get(endpoint.provider);
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
			resolve();
		};
		process.once("SIGINT", shutdown);
		process.once("SIGTERM", shutdown);
	});
	await Promise.all(forwarders.map((forwarder) => forwarder.close()));
	await ui?.close();
	await bridge.close();
	if (args.descriptor) await removeBridgeDescriptor();
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
	const wanted = args.providerIds[0];
	const endpoint = (wanted === void 0 ? void 0 : descriptor.endpoints.find((candidate) => candidate.provider === wanted || candidate.displayName === wanted)) ?? descriptor.endpoints.find((candidate) => candidate.signedIn) ?? descriptor.endpoints[0];
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
		if (results.some((result) => !result.ok) && existsSync(channelFailurePath())) console.log(`\nfailing exchange captured at: ${channelFailurePath()}`);
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
export { isRunningInWsl as C, createWslForwarder as S, bridgeDescriptorCandidates as _, redactForBrowser as a, removeBridgeDescriptor as b, CHAT_PROBE_TIMEOUT_MS$1 as c, REQUEST_LOG_LIMIT as d, REQUEST_ROWS_PER_CARD as f, BRIDGE_DESCRIPTOR_FILENAME as g, modelOfBody as h, createWorkBuddyUiServer as i, probeChatTurn as l, attemptRecord as m, WorkBuddyBridge as n, POOL_FAILOVER_KINDS as o, WorkBuddyRequestLog as p, UiRequestError as r, WorkBuddyFailoverPool as s, main as t, coalesceReasoning as u, bridgeDescriptorPath as v, wslHostAddresses as w, writeBridgeDescriptor as x, readBridgeDescriptor as y };
