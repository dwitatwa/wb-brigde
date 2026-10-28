import { A as normalizeCredits, B as CN_APP_VERSION_FILENAME, E as classifyUpstreamError, F as regionOf, G as resolveChatIdentity, H as chatUserAgent, J as appUserAgent, K as validCliVersion, L as PROBE_EFFORT_CANDIDATES, M as prepareChatBody, N as prepareCnChatBody, P as prepareInternationalChatBody, Q as validAppVersion, R as probeModel, T as WorkBuddyUpstreamClient, U as fallbackChatIdentity, V as FALLBACK_CN_APP_VERSION, W as readCliVersion, X as readBundleVersion, Y as installedAppVersion, Z as resolveAppVersion, _ as AI_VARIANT, a as WORKBUDDY_AUTH_FILENAME, c as defaultDesktopAuthCandidates, d as parseWorkBuddyAuth, f as workbuddyOwnAuthPath, i as WorkBuddyCatalog, j as parseModelCatalog, k as modelWithCurrentPromotion, l as defaultDesktopAuthPath, m as atRestKeyProviderFor, n as FALLBACK_WORKBUDDY_AI_MODELS, o as WORKBUDDY_AUTH_FILE_ENV, q as WORKBUDDY_APP_VERSION_FILENAME, r as FALLBACK_WORKBUDDY_MODELS, s as WorkBuddyCredentialStore, t as WORKBUDDY_CONNECT_VERSION, u as desktopAuthCandidatesFor, v as CN_VARIANT, w as WORKBUDDY_UPDATE_PATH, x as variantFor, y as WORKBUDDY_VARIANTS, z as randomSentinel } from "./version-Vl7XsvYM.js";
import { c as hostIsLoopback, f as WORKBUDDY_CATALOG_FILENAME, m as workbuddyCatalogPath, n as createWorkBuddyShim, p as WorkBuddyCatalogStore, u as originIsLoopback } from "./shim-Cuukpug_.js";
import { a as newestFirst, c as WorkBuddyVisibilityStore, i as fingerprintModel, l as workbuddyVisibilityPath, n as WORKBUDDY_PROBE_FILENAME, o as workbuddyProbePath, r as WorkBuddyProbeStore, s as WORKBUDDY_VISIBILITY_FILENAME, t as WorkBuddyProbeService } from "./probe-service-BL0F9_ln.js";
import { a as readHostHeartbeat, i as processStartTimeMs, n as clearHostHeartbeat, o as workbuddyHostHeartbeatPath, r as isHeartbeatProcessAlive, s as writeHostHeartbeat, t as WORKBUDDY_HOST_HEARTBEAT_FILENAME } from "./host-heartbeat-DM4bxCMW.js";
import z from "@deepseek-ai/schemastery";
import { resolveImageAttachmentAccess, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { dirname, join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { fileURLToPath } from "node:url";
//#region src/dsh/adapter.ts
/**
* The `workbuddy` pi-ai provider: one loopback-backed adapter registered
* into the Harness LLM seam, assembled from public `dsh-llm-pi-ai`
* extension points the way `dsh-codex-connect` assembles its Codex route.
*
* @module dsh-workbuddy-connect/adapter
*/
/** Provider route this bundle owns. */
const WORKBUDDY_PROVIDER = "workbuddy";
/** Provider idle ceiling while one stream read is outstanding. */
const WORKBUDDY_STREAM_IDLE_TIMEOUT_MS = 3e5;
/**
* Image-request budgets at the dsh-llm-pi-ai defaults; the profile type made
* them required in 0.1.1-rc.2. They bound requests to models whose catalog
* entry declares `supportsImages`; text-only models never receive images.
*/
const REQUEST_IMAGE_BUDGETS = {
	maxRequestImageBytes: 20971520,
	requestImagePixelBudget: 4194304,
	requestImageMaxBytes: 1048576
};
/**
* Inert pi-ai auth plane. The workbuddy route authenticates only through the
* shim shared secret resolved per request by `resolveApiKey`, so pi-ai's own
* credential lifecycle and ambient discovery must never manufacture a
* credential for it. `PiAiAdapterOptions.auth` is required since 0.1.1-rc.2;
* every ambient question here answers "nothing stored, nothing set".
*/
const INERT_AUTH = {
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {
			throw new Error("dsh-workbuddy-connect: the workbuddy route has no pi-ai credential lifecycle");
		},
		async delete() {}
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		}
	}
};
/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
/**
* Translate the request-image contract across the two attachment-service
* generations a link-installed plugin can straddle.
*
* A `link:` install resolves its platform imports from the *repository's*
* node_modules (Node follows the symlink's real path), so this adapter always
* runs against the pi-ai it was built with — while the attachment service
* comes from the host. Those two generations disagree on what
* `readImageRequest(ref, policyOrTarget)` receives:
*
* - dsh-attachment-local ≤0.1.5: a route policy `{ maxPixels, maxBytes }`,
*   and `validatePolicy` throws `Image request maxPixels must be a positive
*   integer.` when `maxPixels` is missing.
* - 0.1.6+: a per-image target `{ width, height, maxBytes }` with no
*   `maxPixels` at all, validated by `validateTarget`.
*
* A 0.1.6-built pi-ai on a 0.1.5 host therefore hands the old store a target
* the old store rejects, and every image-bearing request fails before it is
* sent. The wrapper below fills the route's own pixel budget into a target
* that lacks it: the 0.1.5 store then computes the same dimensions pi-ai's
* budget already chose, and a 0.1.6 store ignores the extra key.
*/
function withLegacyImageBudget(store) {
	return new Proxy(store, { get(target, property, receiver) {
		if (property === "imageHostPath") return target.imageHostPath.bind(target);
		if (property !== "readImageRequest") return Reflect.get(target, property, receiver);
		return (...args) => {
			const [ref, policy, signal] = args;
			const present = policy?.maxPixels;
			const withPixels = Number.isSafeInteger(present) && present > 0 ? policy : {
				...policy,
				maxPixels: REQUEST_IMAGE_BUDGETS.requestImagePixelBudget
			};
			return target.readImageRequest(ref, withPixels, signal);
		};
	} });
}
/**
* The suffix appended to a model's display name so its billing rate is visible
* wherever the name is shown.
*
* The separator is a middle dot rather than a hyphen or colon: model names
* already contain hyphens (`GLM-5.3-Flash`, `Deepseek-V4-Flash`), so a hyphen
* separator would be ambiguous about where the name ends and the rate begins.
*/
const RATE_SEPARATOR = " · ";
/**
* Append the billing rate to one model's display name.
*
* The rate AND the declared promo badges ride the *name* alone: since DSH
* 0.1.2 the composer's model seat (`ModelSelect`) renders `model.name` only —
* `description` is no longer read there at all (the 0.1.1-era client rendered
* it, which is why the badges used to be visible in the seat). The `/model`
* popup renders the name too, so a separate `description` copy would either
* duplicate (rate) or vanish (badges) depending on client generation.
*
* This is display-only and cannot affect routing: the wire request is built
* from `model.id` (pi-ai's completions API sets `model: model.id`), the
* selection a picker submits is `{provider, model: id, reasoningEffort}`, and
* `dsh-llm` validates `name` as a non-empty string without comparing its
* contents. Nothing in the host resolves a model *by* name.
*/
/**
* The catalog display suffix: the billing rate followed by the declared promo
* badges (`限时免费`, `夜间折扣`), or undefined when the row carries neither.
* The badge labels are the upstream's own spellings and the host seam has no
* locale service, so non-Chinese UIs see them verbatim — accepted until the
* picker grows a localized badge slot.
*/
function displaySuffix(info) {
	const parts = [normalizeCredits(info.billing?.credits), ...info.billing?.badges ?? []].filter((part) => part !== void 0 && part !== "");
	return parts.length === 0 ? void 0 : parts.join(" · ");
}
/** Append the catalog display suffix to one model's display name. */
function withCatalogDisplay(name, info) {
	const suffix = displaySuffix(info);
	return suffix === void 0 ? name : `${name}${RATE_SEPARATOR}${suffix}`;
}
/**
* Resolve a WorkBuddy model's reasoning capability into pi-ai's
* `thinkingLevelMap` (every level pinned to its wire spelling or `null` for
* unsupported), mirroring `dsh-llm-pi-ai`'s own `resolveModelReasoning`.
*
* Two sources, strictly ordered (`docs/reasoning-effort-probe-plan.md` §5):
*
* 1. **The declared set.** When the upstream declares a non-empty
*    `supportedEfforts`, exactly those values are offered and nothing else.
*    This always wins: an observation never widens or narrows a declared set.
* 2. **A local observation.** Rows without a declared set (the older
*    `{effort, summary}` shape) normally get no control at all — their
*    selectable set is client-side knowledge the catalog does not carry, and
*    the desktop app differs per model there. If the user authorized a probe
*    and it established that the upstream *validates* the parameter, the
*    verified spellings are offered.
*
* A `non-validating` observation deliberately yields no control: the upstream
* accepts values that cannot exist (measured on `glm-5.2`), so every per-level
* acceptance it produced would be a false positive.
*
* `off` is offered only when the upstream declares `canDisableThinking: true`.
* It is never probed — disabling thinking is a separate capability, and the
* per-model acceptance of `off` cannot be inferred from the row's shape.
*
* The CN endpoint vetoes `off` further, on models declaring `onlyReasoning`
* (#87) — see {@link region} below. That rule is deliberately region-scoped:
* the contradiction it resolves was measured on the CN catalog, and applying
* it everywhere would have changed which levels the international picker
* offers, which is outside this issue.
*
* The offered set is described internally as "verified accepted", never as
* "verified effective": acceptance proves the upstream did not reject the
* spelling, not that it changes what the model does.
*
* @param region - the endpoint this descriptor is for. Decides only whether
* the `onlyReasoning` veto applies; every other rule is shared. Passed from
* the variant descriptor, never inferred from a model id or a name.
*/
function reasoningFields(info, observed, region = "cn") {
	const reasoning = info.reasoning;
	if (reasoning === void 0 || reasoning.supports !== true) return { reasoning: false };
	const declared = reasoning.supportedEfforts;
	const efforts = declared !== void 0 && declared.length > 0 ? declared : observed?.validation === "validating" && observed.efforts.length > 0 ? observed.efforts : void 0;
	if (efforts === void 0) return { reasoning: false };
	return {
		reasoning: true,
		thinkingLevelMap: {
			off: reasoning.canDisableThinking === true && (region !== "cn" || reasoning.onlyReasoning !== true) && declared !== void 0 && declared.length > 0 ? "off" : null,
			minimal: null,
			low: efforts.includes("low") ? "low" : null,
			medium: efforts.includes("medium") ? "medium" : null,
			high: efforts.includes("high") ? "high" : null,
			xhigh: efforts.includes("xhigh") ? "xhigh" : null,
			max: efforts.includes("max") ? "max" : null
		}
	};
}
/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(info, baseUrl, observed, providerId, region) {
	return {
		id: info.id,
		name: info.name,
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		input: info.supportsImages === true ? ["text", "image"] : ["text"],
		...reasoningFields(info, observed, region),
		cost: NO_COST,
		contextWindow: info.contextWindow,
		maxTokens: info.maxTokens,
		compat: { maxTokensField: "max_tokens" }
	};
}
/**
* Assemble the adapter. The provider's `getModels` reads the live catalog,
* and every model's `baseUrl` is re-resolved per read so the shim's
* ephemeral port applies from the first snapshot after startup.
*
* The profile is constructed by hand rather than through dsh-llm-pi-ai's
* internal `resolveProfiles()`: that helper is not part of the package's
* public export surface (root entry, `lib/` deep imports blocked by the
* exports map, `src/` not shipped), so hand-assembly is the only supported
* path and every newly required field must be adopted here explicitly —
* `modelErrors` since 0.1.5-alpha.2 (#12).
*/
function createWorkBuddyAdapter(options) {
	const { shim, store, catalog, resolveAttachments, resolveImageAccess, observe, hidden } = options;
	const providerId = options.providerId ?? "workbuddy";
	const displayName = options.displayName ?? "WorkBuddy";
	const region = options.region ?? "cn";
	const buildModels = () => {
		const baseUrl = `${shim.baseUrl()}/v1`;
		return catalog.current().map((info) => toPiModel(info, baseUrl, observe?.(info.id), providerId, region));
	};
	const provider = {
		...createProvider({
			id: providerId,
			name: displayName,
			auth: { apiKey: {
				name: "WorkBuddy OAuth bearer token",
				async resolve({ credential }) {
					const apiKey = credential?.key;
					return apiKey === void 0 || apiKey.length === 0 ? void 0 : {
						auth: { apiKey },
						source: "WorkBuddy"
					};
				}
			} },
			models: buildModels(),
			api: openAICompletionsApi()
		}),
		getModels: () => buildModels()
	};
	const profile = {
		provider: providerId,
		displayName,
		streamIdleTimeoutMs: WORKBUDDY_STREAM_IDLE_TIMEOUT_MS,
		retryPolicy: resolveRetryPolicy(void 0, "dsh-workbuddy-connect retryPolicy"),
		configuredMaxTokens: /* @__PURE__ */ new Map(),
		modelErrors: /* @__PURE__ */ new Map(),
		...REQUEST_IMAGE_BUDGETS,
		piProvider: provider
	};
	let profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
	return {
		adapter: new WorkBuddyPiAiAdapter(catalog, hidden ?? (() => []), {
			profiles: () => profiles,
			auth: INERT_AUTH,
			resolveApiKey: async () => shim.token(),
			...resolveAttachments === void 0 ? {} : { resolveAttachments: () => {
				const store = resolveAttachments();
				return store === void 0 ? void 0 : withLegacyImageBudget(store);
			} },
			...resolveImageAccess === void 0 ? {} : { resolveImageAccess }
		}),
		invalidate: () => {
			profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
		}
	};
}
/**
* The WorkBuddy route's adapter: `PiAiAdapter` with the billing rate folded
* into the catalog answers it returns to the DSH model pickers.
*
* `PiAiAdapter.listModels()` and `.resolveModel()` build their answers straight
* from the pi-ai descriptors, which carry no billing fact, so the rate is
* layered on here by looking the model up in the live catalog. Both overrides
* delegate to `super` and then rewrite only the display fields, so streaming,
* capability resolution, and effort mapping stay exactly as `dsh-llm-pi-ai`
* implements them.
*
* A model missing from the catalog (an id the shim would serve but the last
* upstream refresh did not list) falls through with its name untouched rather
* than being dropped: catalog membership is advisory, and the seam tolerates
* serving an unlisted id.
*/
var WorkBuddyPiAiAdapter = class extends PiAiAdapter {
	catalog;
	hidden;
	constructor(catalog, hidden, options) {
		super(options);
		this.catalog = catalog;
		this.hidden = hidden;
	}
	/** Catalog entry for one model id, or undefined when the catalog omits it. */
	infoFor(model) {
		return this.catalog.current().find((entry) => entry.id === model);
	}
	async listModels(provider) {
		const models = await super.listModels(provider);
		const hidden = new Set(this.hidden());
		return models.flatMap((model) => {
			if (hidden.has(model.id)) return [];
			const info = this.infoFor(model.id);
			if (info === void 0) return [model];
			return [{
				...model,
				name: withCatalogDisplay(model.name, info)
			}];
		});
	}
	async resolveModel(provider, model, signal) {
		const resolved = await super.resolveModel(provider, model, signal);
		const info = this.infoFor(model);
		if (info === void 0) return resolved;
		return {
			...resolved,
			name: withCatalogDisplay(resolved.name, info)
		};
	}
};
//#endregion
//#region src/dsh/pi-ai-guard.ts
/**
* Confirm the pi-ai copy this plugin actually loaded is the generation the DSH
* 0.2.0-rc.2 host was built against.
*
* #92's failure mode: a pnpm profile with `nodeLinker: hoisted` and
* `autoInstallPeers: false` installs no peer for us, so a co-installed
* plugin's older pi-ai sits at the profile root and wins bare-specifier
* resolution. The host then adds a system message (pi-ai 0.87's
* `collapseSystemMessages`) and the older copy answers `estimateMessageTokens`
* by reading `.length` off a block it does not model — every request dies at
* `PI_AI_ERROR` before any upstream HTTP. Declaring pi-ai as a regular
* dependency (package.json) is the fix; this module exists so a future
* regression reports *what* it loaded instead of that opaque crash.
*
* It is deliberately a warning, not a throw. The plugin is mid-load at this
* point, and a hard failure here would take down a host that may still be able
* to serve other providers. The message is the product; the operator decides.
*
* @module dsh-workbuddy-connect/pi-ai-guard
*/
/** The pi-ai generation this plugin is built and tested against. */
const REQUIRED_PI_AI_VERSION = "0.87.1";
/**
* Read the version of the pi-ai copy Node resolves for *this* module.
*
* The package's exports map does not open `./package.json`, so the manifest
* cannot be imported. Instead the module's own specifier is resolved and the
* resulting file is walked up to the directory whose `package.json` names
* `@earendil-works/pi-ai`. That reads the copy actually loaded rather than a
* guess from the install tree.
*
* @returns The resolved version, or undefined when it cannot be determined.
*/
function resolvedPiAiVersion() {
	let entry;
	try {
		entry = import.meta.resolve("@earendil-works/pi-ai");
	} catch {
		return;
	}
	let dir = dirname(fileURLToPath(entry));
	for (let step = 0; step < 5; step += 1) {
		try {
			const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
			if (manifest.name === "@earendil-works/pi-ai" && typeof manifest.version === "string") return manifest.version;
		} catch {}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
}
/**
* One line describing a pi-ai copy that is not the required generation, or
* undefined when the resolved version matches or cannot be read.
*
* The cause is left open on purpose. A hoisted profile root is the case #92
* measured, but an updater or installer can just as easily leave the wrong copy
* in place, and this diagnostic cannot tell them apart from a version string.
* Naming both versions and the remedy is what the reader can act on; naming only
* versions and the fix also keeps any filesystem path out of logs and reports.
*
* Carries no plugin prefix: callers log it under their own.
*
* @param resolved - Version to report on. Read from the live module graph when
* omitted; pass it explicitly to describe a hypothetical copy.
*/
function piAiVersionWarning(resolved) {
	const version = arguments.length === 0 ? resolvedPiAiVersion() : resolved;
	if (version === void 0 || version === "0.87.1") return void 0;
	return `loaded @earendil-works/pi-ai ${version}, but this plugin is built for ${REQUIRED_PI_AI_VERSION}. The wrong copy is being resolved — check the profile's pi-ai install (a pnpm profile with nodeLinker "hoisted" and autoInstallPeers false can expose another package's older copy). Reinstalling the plugin so it installs its own ${REQUIRED_PI_AI_VERSION} copy resolves it`;
}
//#endregion
//#region src/dsh/web-status.ts
/** Redact token-like content before it crosses to the browser. */
function safeMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]").slice(0, 500);
}
function json$2(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/**
* The request must be addressed to the loopback interface, and a
* browser-attached Origin must be loopback too. The Host check drops
* DNS-rebinding pages (their Host is the attacker's domain, not loopback);
* the card's same-origin fetches carry no Origin and pass on Host alone.
*/
function loopbackRequest(req) {
	return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin);
}
/**
* Assemble the card's status document. Sign-in state is read-only; credit is
* a live billing answer whose failure degrades to `creditsError` rather than
* failing the whole document.
*/
async function workBuddyWebStatus(deps) {
	const authStatus = await deps.store.status();
	if (authStatus.state !== "signed-in") return {
		status: "signed-out",
		...authStatus.reason === void 0 ? {} : { reason: authStatus.reason },
		...authStatus.reasonCode === void 0 ? {} : { reasonCode: authStatus.reasonCode }
	};
	const status = {
		status: "signed-in",
		...authStatus.nickname === void 0 ? {} : { nickname: authStatus.nickname },
		...authStatus.domain === void 0 || authStatus.domain === "" ? {} : { domain: authStatus.domain },
		...authStatus.source === void 0 ? {} : { source: authStatus.source },
		...authStatus.expiresAtMs === void 0 ? {} : { expiresAt: authStatus.expiresAtMs }
	};
	const modelsField = deps.models().map((model) => {
		const rate = normalizeCredits(model.billing?.credits);
		const supported = model.supportedContextWindows ?? [];
		const maxContextWindow = supported.length > 0 ? Math.max(...supported) : void 0;
		const defaultContextWindow = model.defaultContextWindow ?? model.contextWindow;
		return {
			id: model.id,
			name: model.name,
			...model.billing?.free === true ? { free: true } : {},
			...model.billing?.badges !== void 0 && model.billing.badges.length > 0 ? { badges: model.billing.badges } : {},
			...rate === void 0 ? {} : { credits: rate },
			...model.billing?.rateUnknown === true ? { rateUnknown: true } : {},
			...typeof model.contextWindow === "number" && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {},
			...typeof defaultContextWindow === "number" && defaultContextWindow > 0 && defaultContextWindow < model.contextWindow ? { defaultContextWindow } : {},
			...maxContextWindow === void 0 || maxContextWindow <= defaultContextWindow ? {} : { maxContextWindow },
			...typeof model.maxInputTokens === "number" && model.maxInputTokens > 0 ? { maxInputTokens: model.maxInputTokens } : {}
		};
	});
	const catalog = deps.catalog?.();
	const withCatalog = catalog === void 0 ? status : {
		...status,
		catalog
	};
	const visibility = deps.visibility?.();
	const withVisibility = visibility === void 0 ? withCatalog : {
		...withCatalog,
		visibility
	};
	const statusWithModels = modelsField.length > 0 ? {
		...withVisibility,
		models: modelsField
	} : withVisibility;
	let probed = statusWithModels;
	if (deps.probe !== void 0) {
		const maximumContextWindow = deps.useMaximumContextWindow?.();
		probed = {
			...statusWithModels,
			probe: deps.probe(),
			...deps.probeKey === void 0 ? {} : { probeKey: deps.probeKey },
			...maximumContextWindow === void 0 ? {} : { useMaximumContextWindow: maximumContextWindow }
		};
	}
	try {
		const credential = await deps.store.current();
		if (credential !== void 0) {
			const credits = await deps.client.fetchCredits(credential);
			return {
				...probed,
				credits
			};
		}
	} catch (error) {
		return {
			...probed,
			creditsError: safeMessage(error)
		};
	}
	return probed;
}
/** The status route's request handler, extracted so tests can mount it on a bare server. */
function workBuddyStatusHandler(deps) {
	return async (req, res) => {
		if (req.method !== "GET") {
			json$2(res, 405, { error: "method not allowed" });
			return;
		}
		if (!loopbackRequest(req)) {
			json$2(res, 403, { error: "request-not-trusted" });
			return;
		}
		try {
			json$2(res, 200, await workBuddyWebStatus(deps));
		} catch (error) {
			json$2(res, 500, { error: safeMessage(error) });
		}
	};
}
/** Mount the GET status route on an optional webServer context. */
function registerWorkBuddyStatusRoute(ctx, deps) {
	const path = deps.path ?? "/plugins/dsh-workbuddy-connect/status";
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path,
			handler: workBuddyStatusHandler(deps)
		});
		return () => {
			dispose();
		};
	}, "dsh-workbuddy-connect: Web status route");
}
//#endregion
//#region src/dsh/update.ts
/**
* Public update metadata and bounded version checking for WorkBuddy Connect.
*
* Two upstreams, strictly layered so the judgement never depends on the
* enrichment: npm's dist-tags decide whether a newer release exists, and only
* then is GitHub's release list consulted — one request that feeds both the
* "versions behind" count and the per-release notes. Every upstream answer is
* treated as untrusted input: bodies are size-capped while streaming, releases
* are re-validated on the browser side by {@link parseWorkBuddyUpdateResult}
* before anything renders.
*
* This module is host/browser shared and dependency-free by design (the client
* bundle's runtime imports stay React + local modules only).
*
* @module dsh-workbuddy-connect/update
*/
const WORKBUDDY_REPOSITORY_URL = "https://github.com/corrinehu/dsh-workbuddy-connect";
const WORKBUDDY_UPDATE_NPM_METADATA_URL = `https://registry.npmjs.org/-/package/dsh-workbuddy-connect/dist-tags`;
const WORKBUDDY_UPDATE_RELEASES_API_URL = `${WORKBUDDY_REPOSITORY_URL.replace("https://github.com", "https://api.github.com/repos")}/releases?per_page=100`;
const WORKBUDDY_RELEASE_PAGE_BASE = `${WORKBUDDY_REPOSITORY_URL}/releases/tag/`;
const WORKBUDDY_UPDATE_MAX_METADATA_BYTES = 65536;
const WORKBUDDY_UPDATE_MAX_RELEASES_BYTES = 1048576;
/** GitHub caps one page at 100 releases; ours is far below that today. */
const RELEASES_LIST_MAX = 100;
const RELEASE_NAME_MAX_CHARS = 200;
const RELEASE_NOTES_MAX_CHARS = 16e3;
/** Parse one exact SemVer version, accepting the conventional leading `v`. */
function parseWorkBuddyVersion(raw) {
	if (typeof raw !== "string") return void 0;
	const normalized = raw.startsWith("v") ? raw.slice(1) : raw;
	const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(normalized);
	if (match === null) return void 0;
	const rawPrerelease = match[4] === void 0 ? [] : match[4].split(".");
	if (rawPrerelease.some((identifier) => /^\d+$/u.test(identifier) && !/^(0|[1-9]\d*)$/u.test(identifier))) return void 0;
	const prerelease = rawPrerelease.map((identifier) => /^(0|[1-9]\d*)$/u.test(identifier) ? Number(identifier) : identifier);
	if (prerelease.some((identifier) => typeof identifier === "number" && !Number.isSafeInteger(identifier))) return void 0;
	const parsed = {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease
	};
	return [
		parsed.major,
		parsed.minor,
		parsed.patch
	].every(Number.isSafeInteger) ? parsed : void 0;
}
/**
* One canonical spelling per SemVer value: leading `v` and build metadata
* fold away, so `v0.6.4`, `0.6.4`, and `0.6.4+build` dedupe as one release.
* Returns `undefined` for unparseable input; callers drop those first.
*/
function canonicalWorkBuddyVersion(version) {
	const parsed = parseWorkBuddyVersion(version);
	if (parsed === void 0) return void 0;
	return `${String(parsed.major)}.${String(parsed.minor)}.${String(parsed.patch)}` + (parsed.prerelease.length === 0 ? "" : `-${parsed.prerelease.join(".")}`);
}
function compareIdentifiers(left, right) {
	if (typeof left === "number" && typeof right === "number") return left < right ? -1 : left > right ? 1 : 0;
	if (typeof left === "number") return -1;
	if (typeof right === "number") return 1;
	return left < right ? -1 : left > right ? 1 : 0;
}
/** Compare two versions using SemVer precedence (build metadata ignored). */
function compareWorkBuddyVersions(left, right) {
	const a = parseWorkBuddyVersion(left);
	const b = parseWorkBuddyVersion(right);
	if (a === void 0 || b === void 0) throw new TypeError("invalid WorkBuddy Connect version");
	for (const [aPart, bPart] of [
		[a.major, b.major],
		[a.minor, b.minor],
		[a.patch, b.patch]
	]) if (aPart !== bPart) return aPart < bPart ? -1 : 1;
	if (a.prerelease.length === 0 && b.prerelease.length !== 0) return 1;
	if (a.prerelease.length !== 0 && b.prerelease.length === 0) return -1;
	for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
		const aPart = a.prerelease[index];
		const bPart = b.prerelease[index];
		if (aPart === void 0) return -1;
		if (bPart === void 0) return 1;
		const comparison = compareIdentifiers(aPart, bPart);
		if (comparison !== 0) return comparison;
	}
	return 0;
}
function boundedText(value, maxBytes) {
	if (new TextEncoder().encode(value).byteLength > maxBytes) throw new RangeError("update response is too large");
	return value;
}
async function readBoundedText(response, maxBytes) {
	if (response.body === null) return boundedText(await response.text(), maxBytes);
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const chunks = [];
	let total = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			total += next.value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				throw new RangeError("update response is too large");
			}
			chunks.push(decoder.decode(next.value, { stream: true }));
		}
		chunks.push(decoder.decode());
		return chunks.join("");
	} finally {
		reader.releaseLock();
	}
}
async function fetchBounded(fetchImpl, url, maxBytes, timeoutMs, headers) {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort(/* @__PURE__ */ new Error("update request timed out"));
	}, timeoutMs);
	try {
		const response = await fetchImpl(url, {
			headers,
			signal: controller.signal
		});
		return {
			response,
			text: await readBoundedText(response, maxBytes)
		};
	} finally {
		clearTimeout(timer);
	}
}
/** Strip control characters, normalize newlines, and cap the length. */
function cleanReleaseText(value, maxLength) {
	if (typeof value !== "string" || value.length === 0) return void 0;
	const clean = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "").replace(/\r\n?/gu, "\n").trim().slice(0, maxLength);
	return clean.length === 0 ? void 0 : clean;
}
function cleanPublishedAt(value) {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/iu.test(value) ? value.slice(0, 64) : void 0;
}
/**
* The `latest` dist-tag only. Pre-release channels are not this plugin's
* release line, so recommending one would be wrong even when newer.
*/
function latestDistTag(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const tags = value["dist-tags"] ?? value;
	if (typeof tags !== "object" || tags === null || Array.isArray(tags)) return void 0;
	const candidate = tags["latest"];
	return typeof candidate === "string" && parseWorkBuddyVersion(candidate) !== void 0 ? candidate : void 0;
}
function releasePageUrl(version) {
	return `${WORKBUDDY_RELEASE_PAGE_BASE}v${version}`;
}
/**
* Parse GitHub's release-list page into the in-range releases, newest first.
* Unknown entry shapes are skipped, never fatal: the count and the notes both
* degrade per-entry rather than dropping the whole judgement.
*/
function releasesInRange(currentVersion, latestVersion, value) {
	if (!Array.isArray(value) || value.length > RELEASES_LIST_MAX) return void 0;
	const releases = [];
	const seen = /* @__PURE__ */ new Set();
	for (const raw of value) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
		const entry = raw;
		const tag = entry["tag_name"];
		if (typeof tag !== "string") continue;
		if (parseWorkBuddyVersion(tag) === void 0) continue;
		if (compareWorkBuddyVersions(tag, currentVersion) <= 0 || compareWorkBuddyVersions(tag, latestVersion) > 0) continue;
		const canonical = canonicalWorkBuddyVersion(tag);
		if (canonical === void 0 || seen.has(canonical)) continue;
		seen.add(canonical);
		const name = cleanReleaseText(entry["name"], RELEASE_NAME_MAX_CHARS);
		const notes = cleanReleaseText(entry["body"], RELEASE_NOTES_MAX_CHARS);
		const publishedAt = cleanPublishedAt(entry["published_at"]);
		releases.push({
			version: tag,
			...name === void 0 ? {} : { name },
			...notes === void 0 ? {} : { notes },
			...publishedAt === void 0 ? {} : { publishedAt }
		});
	}
	releases.sort((left, right) => compareWorkBuddyVersions(right.version, left.version));
	return releases;
}
/** Enrich an available update from GitHub's release list; degrade on failure. */
async function releaseList(currentVersion, latestVersion, fetchImpl, timeoutMs) {
	try {
		const { response, text } = await fetchBounded(fetchImpl, WORKBUDDY_UPDATE_RELEASES_API_URL, WORKBUDDY_UPDATE_MAX_RELEASES_BYTES, timeoutMs, { accept: "application/vnd.github+json" });
		if (!response.ok) return void 0;
		return releasesInRange(currentVersion, latestVersion, JSON.parse(text));
	} catch {
		return;
	}
}
/** Check npm's public dist-tags and enrich an available update with release notes. */
async function checkWorkBuddyUpdate(options) {
	const { currentVersion } = options;
	if (parseWorkBuddyVersion(currentVersion) === void 0) return {
		status: "unavailable",
		currentVersion,
		reason: "invalid-current-version"
	};
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? 8e3;
	let metadata;
	try {
		const { response, text } = await fetchBounded(fetchImpl, WORKBUDDY_UPDATE_NPM_METADATA_URL, WORKBUDDY_UPDATE_MAX_METADATA_BYTES, timeoutMs, { accept: "application/json" });
		if (!response.ok) return {
			status: "unavailable",
			currentVersion,
			reason: "registry-unavailable"
		};
		metadata = JSON.parse(text);
	} catch (error) {
		return {
			status: "unavailable",
			currentVersion,
			reason: error instanceof SyntaxError || error instanceof RangeError ? "invalid-registry-response" : "registry-unavailable"
		};
	}
	const latestVersion = latestDistTag(metadata);
	if (latestVersion === void 0) return {
		status: "unavailable",
		currentVersion,
		reason: "invalid-registry-response"
	};
	if (compareWorkBuddyVersions(latestVersion, currentVersion) <= 0) return {
		status: "up-to-date",
		currentVersion,
		latestVersion: currentVersion
	};
	const releases = await releaseList(currentVersion, latestVersion, fetchImpl, timeoutMs);
	return {
		status: "update-available",
		currentVersion,
		latestVersion,
		releaseUrl: releasePageUrl(latestVersion),
		releases: releases ?? [],
		...releases === void 0 ? {} : { versionsBehind: releases.length }
	};
}
//#endregion
//#region src/dsh/update-route.ts
function json$1(res, status, value) {
	const payload = JSON.stringify(value);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(payload),
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff"
	});
	res.end(payload);
}
/** The same browser-origin gate the status route uses: DNS-rebinding pages die here. */
function browserRequestAllowed(req) {
	return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin);
}
/** Build the route handler; the caller owns registration and disposal. */
function workBuddyUpdateHandler(options) {
	return async (req, res) => {
		if (req.method !== "GET") {
			json$1(res, 405, { error: "method not allowed" });
			return;
		}
		if (!browserRequestAllowed(req)) {
			json$1(res, 403, { error: "forbidden" });
			return;
		}
		let result;
		try {
			result = await checkWorkBuddyUpdate({
				currentVersion: options.currentVersion,
				...options.fetchImpl === void 0 ? {} : { fetchImpl: options.fetchImpl },
				timeoutMs: options.timeoutMs ?? 8e3
			});
		} catch {
			result = {
				status: "unavailable",
				currentVersion: options.currentVersion,
				reason: "registry-unavailable"
			};
		}
		json$1(res, 200, result);
	};
}
/** Register the update route on the optional host web server. */
function registerWorkBuddyUpdateRoute(ctx, options) {
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path: WORKBUDDY_UPDATE_PATH,
			handler: workBuddyUpdateHandler(options)
		});
		return () => {
			dispose();
		};
	}, "dsh-workbuddy-connect: update route");
}
//#endregion
//#region src/dsh/probe-route.ts
/**
* Probe control route: the only state-changing endpoint the plugin exposes.
*
* Two guards, because they stop different things (see `docs/reasoning-effort-probe-plan.md`
* §6.4 and the v0.3.1 note in AGENTS.md about their exact scope):
*
* 1. **Loopback Host + Origin**, shared with the status route. This drops
*    DNS-rebinding pages, whose requests arrive addressed to the attacker's
*    domain.
* 2. **An in-process random key**, minted per process and handed only to the
*    same-origin card. Loopback alone is *not* authentication — any local
*    process can write `Host: 127.0.0.1` — so a route that spends the user's
*    credit must prove the caller was told the key.
*
* A probe request is never accepted with a prompt, a model id outside the
* live catalog, or a sentinel from the browser: it is assembled entirely
* host-side. (Scope: the `probe` action only — `set-model-visibility`
* deliberately accepts a model id the current catalog no longer lists, since
* a hidden id is kept for when the model returns.)
*
* @module dsh-workbuddy-connect/probe-route
*/
/** Largest control body accepted; these payloads are a few dozen bytes. */
const MAX_BODY_BYTES = 4096;
/** Mint the per-process control key. */
function createProbeKey() {
	return randomBytes(24).toString("hex");
}
/**
* Constant-time key comparison; a length mismatch is a failure, not a crash.
*/
function keyMatches(expected, presented) {
	if (presented === void 0 || presented.length !== expected.length) return false;
	const a = Buffer.from(expected);
	const b = Buffer.from(presented);
	return a.length === b.length && timingSafeEqual(a, b);
}
function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/** Read the request body with a hard ceiling. */
async function readBody(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > MAX_BODY_BYTES) return void 0;
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}
/** Parse and shape-check an action; unknown fields are ignored, not trusted. */
function parseAction(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const wrapped = parsed;
	const action = wrapped["action"];
	if (action === "clear") return { action: "clear" };
	if (action === "refresh") return { action: "refresh" };
	if (action === "set-maximum-context-window") return typeof wrapped["enabled"] === "boolean" ? {
		action: "set-maximum-context-window",
		enabled: wrapped["enabled"]
	} : void 0;
	if (action === "set-model-visibility") {
		const model = wrapped["model"];
		const account = wrapped["account"];
		if (typeof model !== "string" || model.trim() === "") return void 0;
		if (typeof wrapped["visible"] !== "boolean") return void 0;
		if (typeof account !== "string" || account === "") return void 0;
		return {
			action: "set-model-visibility",
			model: model.trim(),
			visible: wrapped["visible"],
			account
		};
	}
	if (action === "probe") {
		const model = wrapped["model"];
		if (typeof model !== "string" || model.trim() === "") return void 0;
		return {
			action: "probe",
			model: model.trim()
		};
	}
}
/**
* The control route's handler, extracted so tests can mount it on a bare
* server with a known key.
*/
function workBuddyProbeHandler(deps, key) {
	return async (req, res) => {
		if (req.method !== "POST") {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
			json(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (!keyMatches(key, req.headers["x-workbuddy-probe-key"])) {
			json(res, 403, { error: "invalid-probe-key" });
			return;
		}
		const body = await readBody(req);
		if (body === void 0) {
			json(res, 413, { error: "body too large" });
			return;
		}
		const action = parseAction(body);
		if (action === void 0) {
			json(res, 400, { error: "invalid action" });
			return;
		}
		try {
			if (action.action === "clear") {
				deps.clear();
				json(res, 200, { state: "cleared" });
				return;
			}
			if (action.action === "refresh") {
				if (deps.refresh === void 0) {
					json(res, 404, { error: "refresh-not-supported" });
					return;
				}
				json(res, 200, await deps.refresh());
				return;
			}
			if (action.action === "set-maximum-context-window") {
				if (deps.setMaximumContextWindow === void 0) {
					json(res, 404, { error: "context-window-setting-not-supported" });
					return;
				}
				json(res, 200, await deps.setMaximumContextWindow(action.enabled === true));
				return;
			}
			if (action.action === "set-model-visibility") {
				if (deps.setModelVisibility === void 0) {
					json(res, 404, { error: "visibility-setting-not-supported" });
					return;
				}
				json(res, 200, await deps.setModelVisibility(action.model, action.visible === true, action.account));
				return;
			}
			json(res, 200, await deps.probe(action.model));
		} catch (error) {
			json(res, 500, { error: error instanceof Error ? error.message : String(error) });
		}
	};
}
/** Mount the POST probe-control route on an optional webServer context. */
function registerWorkBuddyProbeRoute(ctx, deps, key) {
	const path = deps.path ?? "/plugins/dsh-workbuddy-connect/probe";
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path,
			handler: workBuddyProbeHandler(deps, key)
		});
		return () => {
			dispose();
		};
	}, "dsh-workbuddy-connect: probe control route");
}
//#endregion
//#region src/dsh/legacy-settings.ts
/**
* Narrow one host settings service to the legacy section API, or `undefined`
* when this host's generation does not carry it.
*
* Both members are required: a service with only `installSection` would let
* this plugin install a section whose edits it could never persist, and the
* maximum-context preference is written through `update`. A host that ships
* neither is reported as `undefined` so the caller degrades in one place.
*
* @param settings - the host settings service, whose shape is generation-dependent.
* @returns the legacy API when present, otherwise `undefined`.
*/
function legacySettingsOf(settings) {
	if (typeof settings !== "object" || settings === null) return void 0;
	const candidate = settings;
	if (typeof candidate.installSection !== "function") return void 0;
	if (typeof candidate.update !== "function") return void 0;
	return settings;
}
//#endregion
//#region src/dsh/index.ts
/** Stable Cordis plugin name. */
const name = "llm-workbuddy";
/** The model registry required before the provider can register. */
const inject = ["llm"];
/**
* Settings namespace owning the CN card's section.
*
* DSH 0.1.2 dropped the `settingsNamespace()` branding function: a namespace is
* now a nominal string, validated by the type system where it is used rather
* than at runtime by a function call. The brand is compile-time only, so this
* stays the plain string it always was — every comparison, descriptor lookup,
* and `dsh` config file still sees `'workbuddy'`. It is cast once here so the
* public constant carries the seam's type without pulling the brand helper
* into this package (upstream DSH plugins, `dsh-llm-pi-ai` included, pass
* their namespaces as plain string literals).
*/
const WORKBUDDY_SETTINGS_NS = "workbuddy";
/**
* Settings namespace owning the international section.
*
* One namespace per variant, not one shared: each section owns only its own
* fields (`authFile` vs `authFileAI` and `useMaximumContextWindow`), and the
* sections are what `settings.yaml` and the TUI `/settings` read. On DSH 0.1.5
* they carry one more duty — the settings Plugins tab dispatches a card by
* rendering `settings.plugin.item` with `entryKey = ns` for each namespace the
* Host serves, so each variant's card needs a served section whose namespace
* equals its id. DSH 0.1.6+ ignores that pairing (its Plugins page renders the
* bundle's single `plugins.bundle.config` entry, keyed by package name), which
* costs nothing: a section that names no card renders no duplicate.
*/
const WORKBUDDY_AI_SETTINGS_NS = "workbuddy-ai";
/**
* How often the credential files are re-checked, in milliseconds.
*
* A startup-only catalog fetch cannot notice a sign-in that happens while DSH
* is already running, so the model group would not appear until a restart. This
* poll is a cheap existence/parse read of at most a few local files: it never
* contacts the network and never runs a reasoning probe.
*
* `DSH_WORKBUDDY_POLL_MS` overrides it. That exists so the sweep can be
* exercised end to end in tests and shortened while diagnosing a slow sign-in
* on a real machine; it is not a product setting and no UI exposes it. The
* value is clamped to a sane range so a mistaken override cannot turn the poll
* into a busy loop.
*/
const CREDENTIAL_POLL_MS = 3e4;
/** Floor and ceiling for the overridable poll interval. */
const MIN_POLL_MS = 100;
const MAX_POLL_MS = 864e5;
/** Resolve the sweep interval, honoring the override when it is usable. */
function credentialPollMs() {
	const override = Number(process.env["DSH_WORKBUDDY_POLL_MS"]);
	if (!Number.isFinite(override) || override < MIN_POLL_MS) return CREDENTIAL_POLL_MS;
	return Math.min(override, MAX_POLL_MS);
}
/**
* How long to wait before retrying a catalog fetch that failed.
*
* The credential sweep deliberately does not re-fetch a catalog it already has
* (a same-identity token rotation carries no new model information). But a
* *failed* fetch must not be treated the same way: without a retry, one
* transient network blip at startup would leave the group on the built-in
* fallback roster until the user noticed and pressed refresh. This bound keeps
* that recovery automatic while still honoring the "not every round" rule — at
* most one attempt per interval, and none at all once a live catalog lands.
*
* Expressed as a multiple of the sweep rather than a fixed duration so the two
* stay in proportion under the `DSH_WORKBUDDY_POLL_MS` override.
*/
const CATALOG_RETRY_SWEEPS = 10;
/** Explicit CN desktop auth-file path (shared by the plugin schema and its section). */
const AUTH_FILE_FIELD = z.string().description("WorkBuddy desktop auth file (defaults to the app's own location)");
/** Explicit international desktop auth-file path (shared by the plugin schema and its section). */
const AUTH_FILE_AI_FIELD = z.string().description("WorkBuddy AI desktop auth file (defaults to the app's own location)");
/** Probe authorization (shared by the plugin schema and the CN section). */
const PROBE_CONSENT_FIELD = z.boolean().default(false).description("Authorize reasoning-effort probes (each probe sends real requests that may consume credit)");
const MAXIMUM_CONTEXT_WINDOW_FIELD = z.boolean().default(true).description("Use the largest context window declared by WorkBuddy AI when alternatives are available (on by default)");
const Config = z.object({
	authFile: AUTH_FILE_FIELD,
	authFileAI: AUTH_FILE_AI_FIELD,
	probeConsent: PROBE_CONSENT_FIELD,
	useMaximumContextWindow: MAXIMUM_CONTEXT_WINDOW_FIELD
});
/**
* The CN side's settings section: only the fields that side edits.
*
* The section's namespace is what serves these fields to `settings.yaml` and
* the TUI `/settings`, and it keeps them apart from the international side's.
* `probeConsent` lives here because it predates the second variant; it gates no
* current code path (only manual, per-click-confirmed probes run), so it is left
* where existing users set it rather than moved and re-asked.
*/
const CN_SECTION = z.object({
	authFile: AUTH_FILE_FIELD,
	probeConsent: PROBE_CONSENT_FIELD
});
/** The international card's settings section and its context-window preference. */
const AI_SECTION = z.object({
	authFileAI: AUTH_FILE_AI_FIELD,
	useMaximumContextWindow: MAXIMUM_CONTEXT_WINDOW_FIELD
});
/** Stable identity key used by credentials, probe records, and catalog entries. */
function credentialIdentity(credential) {
	return `${credential.uid}:${credential.enterpriseId ?? ""}`;
}
/**
* The account key model-visibility preferences are stored under: the stable
* identity, but only when it carries a uid.
*
* A credential whose desktop document carried no `account.uid` normalizes to
* an empty string; keying preferences on the resulting `":enterpriseId"` would
* silently share one bucket between every such account. Those accounts get no
* per-account preferences at all — everything stays visible and the control
* route explains the refusal — which is the only honest degradation: it never
* applies one account's hidden list to another.
*/
function visibilityAccountOf(credential) {
	return credential.uid === "" ? void 0 : credentialIdentity(credential);
}
/** Read the configured explicit auth-file path for one variant. */
function configuredAuthFile(config, variant) {
	return variant.id === CN_VARIANT.id ? config.authFile : config.authFileAI;
}
/**
* The static catalog a variant serves before its first successful fetch.
*
* Each variant has its own roster: the two endpoints share several model ids
* but not their billing, context windows, or reasoning sets, so one shared
* fallback would misdescribe whichever variant it was not captured from.
*/
function fallbackFor(variant) {
	return variant.id === CN_VARIANT.id ? FALLBACK_WORKBUDDY_MODELS : FALLBACK_WORKBUDDY_AI_MODELS;
}
/** Build one variant's stores and probe state. */
function createVariantRuntime(config, variant, current, identityOf, accountOf, keyProvider) {
	const client = new WorkBuddyUpstreamClient();
	const configured = configuredAuthFile(config, variant);
	const store = new WorkBuddyCredentialStore({
		variant,
		...configured === void 0 ? {} : { desktopPath: configured },
		...keyProvider === void 0 ? {} : { keyProvider },
		refresh: (credential) => client.refreshToken(credential)
	});
	const fallback = fallbackFor(variant);
	const catalog = new WorkBuddyCatalog(fallback);
	if (variant.id !== CN_VARIANT.id) catalog.setUseMaximumContextWindow(config.useMaximumContextWindow === true);
	catalog.setVisible(false);
	const probeStore = new WorkBuddyProbeStore({
		pluginVersion: WORKBUDDY_CONNECT_VERSION,
		path: workbuddyProbePath(variant.probeFilename)
	});
	const savedCatalogs = new WorkBuddyCatalogStore(workbuddyCatalogPath(variant.catalogFilename));
	const visibilityStore = new WorkBuddyVisibilityStore(workbuddyVisibilityPath(variant.visibilityFilename));
	return {
		variant,
		store,
		client,
		catalog,
		probeStore,
		probeService: new WorkBuddyProbeService({
			store: probeStore,
			catalog,
			credentials: store,
			client,
			region: variant.id === CN_VARIANT.id ? "cn" : "global",
			consent: () => current().probeConsent === true,
			account: () => identityOf(variant.id)
		}),
		savedCatalogs,
		visibilityStore,
		account: () => accountOf(variant.id),
		fallback,
		catalogSource: "fallback",
		catalogFetchedAtMs: void 0,
		catalogError: void 0,
		lastFetchAtMs: 0,
		catalogGeneration: 0,
		inflightFetch: void 0,
		invalidate: () => {},
		registered: false
	};
}
/** The catalog provenance the card displays. */
function catalogSection(runtime) {
	const fetch = runtime.client.lastCatalog;
	return {
		source: runtime.catalogSource,
		...runtime.catalogFetchedAtMs === void 0 ? {} : { fetchedAt: runtime.catalogFetchedAtMs },
		...fetch?.appVersion === void 0 ? {} : { appVersion: fetch.appVersion.version },
		...runtime.catalogError === void 0 ? {} : { error: runtime.catalogError }
	};
}
/**
* Whether a model can be probed by hand: it reasons and the upstream declares
* no effort set for it.
*
* Deliberately *not* filtered by whether a result already exists. Dropping a
* model once it has been detected made the list shrink with use, so
* re-detecting one model — after an upstream change, say — meant clearing every
* other result first. The list stays stable and the card marks which entries
* already have an answer.
*/
function isProbeCandidate(info) {
	if (info.reasoning?.supports !== true) return false;
	return (info.reasoning.supportedEfforts?.length ?? 0) === 0;
}
/** Compact probe state for one card: consent, candidates, observations. */
function probeSection(runtime, consent) {
	const models = runtime.catalog.current();
	const results = models.flatMap((info) => {
		const record = runtime.probeService.recordFor(info.id);
		if (record === void 0) return [];
		return [{
			id: info.id,
			name: info.name,
			validation: record.validation,
			efforts: record.efforts,
			probedAt: record.probedAtMs
		}];
	});
	return {
		consent,
		running: runtime.probeService.isRunning(),
		candidates: models.filter(isProbeCandidate).map((info) => info.id),
		results: newestFirst(results)
	};
}
/**
* Start one variant: its loopback endpoint, provider registration, and
* configuration-card wiring.
*
* Registration waits for the shim to hold a port, because the provider's
* models read the shim origin at construction time. A failure here is
* contained to this variant: the caller logs it and the other keeps working.
*
* @returns whether the provider registered.
*/
async function startVariant(ctx, runtime) {
	const { variant, store, client, catalog, probeService } = runtime;
	const shim = createWorkBuddyShim({
		store,
		client,
		catalog,
		logger: ctx.logger
	});
	try {
		await shim.ready;
	} catch (error) {
		ctx.logger.error(`dsh-workbuddy-connect: ${variant.displayName} loopback endpoint failed to start`, error);
		return false;
	}
	try {
		const workbuddy = createWorkBuddyAdapter({
			providerId: variant.id,
			displayName: variant.displayName,
			region: variant.region,
			shim,
			store,
			catalog,
			resolveAttachments: () => ctx.get("attachments"),
			resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, (hostPath) => ctx.get("fs")?.processPathFromHostPath(hostPath), ref),
			observe: (modelId) => probeService.recordFor(modelId),
			hidden: () => {
				const account = runtime.account();
				return account === void 0 ? [] : runtime.visibilityStore.disabled(account);
			}
		});
		runtime.invalidate = () => {
			workbuddy.invalidate();
			ctx.emit("llm/adapters-updated");
		};
		const releaseAdapter = ctx.llm.registerAdapter([variant.id], workbuddy.adapter);
		try {
			ctx.effect(() => () => {
				releaseAdapter();
				shim.close();
			});
		} catch {
			releaseAdapter();
			shim.close();
		}
		runtime.registered = true;
		return true;
	} catch (error) {
		ctx.logger.error(`dsh-workbuddy-connect: ${variant.displayName} provider registration failed`, error);
		shim.close();
		return false;
	}
}
/**
* Start both variants: their loopback endpoints, the `workbuddy` and
* `workbuddy-ai` providers, their configuration cards, and their
* credential-driven catalog lifecycles.
*
* Each variant registers unconditionally; what varies is whether its catalog is
* *visible*. An empty catalog is how DSH hides a model group (the host filters
* out groups with no models), which keeps a sign-in that happens after startup
* working without re-registering the provider.
*/
function apply(ctx, config) {
	const piAiWarning = piAiVersionWarning();
	if (piAiWarning !== void 0) ctx.logger.warn(`dsh-workbuddy-connect: ${piAiWarning}`);
	let current = () => config;
	/** Timers and in-flight work belonging to this plugin instance. */
	let stopped = false;
	const timers = [];
	/**
	* The account identity each variant last published a catalog for. Keeps a
	* same-identity token rotation from re-fetching, and lets a late response
	* from a previous identity be discarded instead of overwriting a newer one.
	*/
	const lastIdentities = /* @__PURE__ */ new Map();
	/**
	* The visibility account key each variant last adopted, parallel to
	* {@link lastIdentities}: same credential, second key — undefined both when
	* signed out and when the credential carried no uid, which is exactly the
	* case that must not fall back to a shared preference bucket.
	*/
	const lastAccounts = /* @__PURE__ */ new Map();
	const atRestKeysFor = (variant) => atRestKeyProviderFor(variant);
	const runtimes = WORKBUDDY_VARIANTS.map((variant) => createVariantRuntime(config, variant, () => current(), (id) => lastIdentities.get(id), (id) => lastAccounts.get(id), atRestKeysFor(variant)));
	const probeKey = createProbeKey();
	let setMaximumContextWindow;
	/**
	* Whether this host's settings service carries the 0.1.2-era section API.
	* Decided once, inside the `settings` inject: DSH 0.1.7 removed
	* `installSection` (and `update`) with no replacement this plugin can drive.
	* The maximum-context getter answers `undefined` while this is false, and a
	* status document without the field is what keeps the card from rendering a
	* checkbox that could not be saved.
	*/
	let legacySettingsAvailable = false;
	/**
	* Point a variant at an account identity, invalidating whatever the previous
	* one left behind.
	*
	* One helper for all four transitions (sweep sign-in, sweep sign-out, manual
	* refresh, manual refresh sign-out) because each of them used to do its own
	* partial version, and the manual path forgot pieces the sweep did. Every
	* transition bumps {@link VariantRuntime.catalogGeneration}, which is what
	* makes an in-flight request from before the change refuse to write back.
	*
	* Probe observations are kept across an account change: the store nests them
	* per account, so the departing account's records simply stop being served
	* (every read is account-scoped) and are found intact if that account
	* returns. The "signed out, then in as someone else" sequence that used to
	* look like a first sighting is still safe — a record only ever answers for
	* the account stamped on it, so the new account inherits nothing. Visibility
	* preferences are kept for the same reason, and read through the new
	* account's key immediately: the picker re-lists after the invalidate below
	* and a returning account finds its own hidden list back in force.
	*
	* @param identity - the account now in effect, or `undefined` when signed out.
	* @param account - the visibility key for that same credential (`undefined`
	* also when the credential carries no uid); stored alongside the identity so
	* preference reads never guess it from the identity string.
	*/
	const adoptIdentity = (runtime, identity, account) => {
		const id = runtime.variant.id;
		const known = lastIdentities.get(id);
		if (known === identity) return;
		const hadCredential = known !== void 0;
		if (identity === void 0) lastIdentities.delete(id);
		else lastIdentities.set(id, identity);
		if (account === void 0) lastAccounts.delete(id);
		else lastAccounts.set(id, account);
		runtime.catalogGeneration += 1;
		runtime.inflightFetch?.controller.abort();
		runtime.inflightFetch = void 0;
		if (hadCredential && known !== identity) runtime.invalidate();
		if (identity === void 0) {
			if (known !== void 0) runtime.savedCatalogs.delete(known);
			runtime.catalog.set(runtime.fallback);
			runtime.catalogSource = "fallback";
			runtime.catalogFetchedAtMs = void 0;
			runtime.catalogError = void 0;
			if (runtime.catalog.setVisible(false)) runtime.invalidate();
			return;
		}
		const saved = runtime.savedCatalogs.get(identity);
		if (saved !== void 0) {
			runtime.catalog.set([...saved.models]);
			runtime.catalogSource = "saved";
			runtime.catalogFetchedAtMs = saved.fetchedAtMs;
		} else {
			runtime.catalog.set(runtime.fallback);
			runtime.catalogSource = "fallback";
			runtime.catalogFetchedAtMs = void 0;
		}
		runtime.catalogError = void 0;
		runtime.catalog.setVisible(true);
		runtime.invalidate();
	};
	ctx.inject(["webServer"], (webCtx) => {
		registerWorkBuddyUpdateRoute(webCtx, { currentVersion: WORKBUDDY_CONNECT_VERSION });
		for (const runtime of runtimes) {
			registerWorkBuddyStatusRoute(webCtx, {
				path: runtime.variant.statusPath,
				store: runtime.store,
				client: runtime.client,
				models: () => runtime.catalog.current(),
				catalog: () => catalogSection(runtime),
				probe: () => probeSection(runtime, current().probeConsent === true),
				probeKey,
				visibility: () => {
					const account = runtime.account();
					return account === void 0 ? void 0 : {
						account,
						disabled: runtime.visibilityStore.disabled(account)
					};
				},
				...runtime.variant.id === CN_VARIANT.id ? {} : { useMaximumContextWindow: () => legacySettingsAvailable ? current().useMaximumContextWindow === true : void 0 }
			});
			registerWorkBuddyProbeRoute(webCtx, {
				path: runtime.variant.probePath,
				probe: async (modelId) => {
					const result = await runtime.probeService.probe(modelId, true);
					if (result.state === "ok") runtime.invalidate();
					return result;
				},
				clear: () => {
					runtime.probeStore.clear();
					runtime.invalidate();
				},
				refresh: async () => {
					if (stopped) return {
						state: "failed",
						reason: "plugin is stopping"
					};
					let credential;
					try {
						credential = await runtime.store.current();
					} catch (error) {
						return {
							state: "failed",
							reason: error instanceof Error ? error.message.slice(0, 300) : String(error)
						};
					}
					if (credential === void 0) {
						adoptIdentity(runtime, void 0, void 0);
						return { state: "signed-out" };
					}
					const identity = credentialIdentity(credential);
					adoptIdentity(runtime, identity, visibilityAccountOf(credential));
					await fetchCatalog(runtime, identity);
					return runtime.catalogError === void 0 ? {
						state: "refreshed",
						reason: `${runtime.catalog.current().length} models`
					} : {
						state: "failed",
						reason: runtime.catalogError
					};
				},
				...runtime.variant.id === CN_VARIANT.id ? {} : { setMaximumContextWindow: async (enabled) => {
					if (setMaximumContextWindow === void 0) return {
						state: "failed",
						reason: "settings are unavailable"
					};
					return setMaximumContextWindow(enabled);
				} },
				setModelVisibility: async (modelId, visible, expectedAccount) => {
					const account = runtime.account();
					if (account === void 0) return {
						state: "failed",
						reason: "model visibility needs a signed-in account with a stable user id"
					};
					if (expectedAccount !== account) return {
						state: "stale-account",
						reason: "the signed-in account changed"
					};
					try {
						runtime.visibilityStore.setVisible(account, modelId, visible);
					} catch (error) {
						return {
							state: "failed",
							reason: error instanceof Error ? error.message.slice(0, 300) : String(error)
						};
					}
					runtime.invalidate();
					return { state: "updated" };
				}
			}, probeKey);
		}
	});
	ctx.inject(["settings"], (settingsCtx) => {
		const legacy = legacySettingsOf(settingsCtx.settings);
		if (legacy === void 0) {
			ctx.logger.warn("dsh-workbuddy-connect: host settings service has no installSection API; per-variant settings and the maximum-context preference are unavailable");
			return;
		}
		legacySettingsAvailable = true;
		/** Section sources; each falls back to its own slice when its side unloads. */
		const sources = {
			cn: () => config,
			ai: () => config
		};
		/** Merge both sections into the whole config the rest of the plugin reads. */
		const merged = () => ({
			...sources.cn().authFile === void 0 ? {} : { authFile: sources.cn().authFile },
			...sources.cn().probeConsent === void 0 ? {} : { probeConsent: sources.cn().probeConsent },
			...sources.ai().authFileAI === void 0 ? {} : { authFileAI: sources.ai().authFileAI },
			...sources.ai().useMaximumContextWindow === void 0 ? {} : { useMaximumContextWindow: sources.ai().useMaximumContextWindow }
		});
		const applyMaximumContextWindow = (next) => {
			const runtime = runtimes.find((candidate) => candidate.variant.id !== CN_VARIANT.id);
			if (runtime?.catalog.setUseMaximumContextWindow(next.useMaximumContextWindow === true)) runtime.invalidate();
		};
		const repointStores = () => {
			const next = merged();
			applyMaximumContextWindow(next);
			for (const runtime of runtimes) runtime.store.setDesktopPath(configuredAuthFile(next, runtime.variant));
		};
		legacy.installSection(ctx, WORKBUDDY_SETTINGS_NS, CN_SECTION, config, {
			setSource(source) {
				sources.cn = source;
				current = merged;
			},
			onChange: repointStores
		});
		legacy.installSection(ctx, WORKBUDDY_AI_SETTINGS_NS, AI_SECTION, config, {
			setSource(source) {
				sources.ai = source;
				current = merged;
			},
			onChange: repointStores
		});
		setMaximumContextWindow = async (enabled) => {
			await legacy.update(WORKBUDDY_AI_SETTINGS_NS, { useMaximumContextWindow: enabled });
			return { state: "updated" };
		};
	});
	ctx.effect(() => () => {
		stopped = true;
		for (const timer of timers) clearInterval(timer);
		timers.length = 0;
		clearHostHeartbeat();
	});
	/**
	* Fetch one variant's catalog for the current credential.
	*
	* Shared by the credential sweep and the card's manual refresh, and written
	* so that concurrent callers cost one request and cannot interleave badly:
	*
	* - **One request at a time.** A second caller joins the in-flight fetch
	*   instead of starting its own (spec §5: one catalog request per variant at
	*   a time).
	* - **Generation-checked write-back.** The request records the generation it
	*   started under and writes nothing if the generation moved on — which is
	*   what a slow answer from a superseded account must not do. Checking only
	*   the *identity* was not enough: two refreshes for the same account can
	*   still finish out of order, and the older one would win.
	* - **`resolve()`, not `current()`.** Only `resolve()` performs the locked,
	*   single-flight token renewal. Reading `current()` meant an expired token
	*   made every catalog request fail until something else happened to refresh
	*   it, leaving the group on the fallback roster.
	*/
	const fetchCatalog = async (runtime, identity) => {
		const inflight = runtime.inflightFetch;
		const generation = runtime.catalogGeneration;
		if (inflight !== void 0 && inflight.identity === identity && inflight.generation === generation) return inflight.promise;
		inflight?.controller.abort();
		const controller = new AbortController();
		let run;
		run = (async () => {
			let models;
			try {
				const credential = await runtime.store.resolve();
				const resolvedIdentity = credentialIdentity(credential);
				if (resolvedIdentity !== identity) {
					adoptIdentity(runtime, resolvedIdentity, visibilityAccountOf(credential));
					await fetchCatalog(runtime, resolvedIdentity);
					return;
				}
				models = await runtime.client.fetchModels(credential, controller.signal);
				const latest = await runtime.store.current();
				const latestIdentity = latest === void 0 ? void 0 : credentialIdentity(latest);
				if (latestIdentity !== identity) {
					adoptIdentity(runtime, latestIdentity, latest === void 0 ? void 0 : visibilityAccountOf(latest));
					if (latestIdentity !== void 0) await fetchCatalog(runtime, latestIdentity);
					return;
				}
			} catch (error) {
				if (stopped || runtime.catalogGeneration !== generation) return;
				runtime.lastFetchAtMs = Date.now();
				runtime.catalogError = error instanceof Error ? error.message.slice(0, 300) : String(error);
				ctx.logger.warn(`dsh-workbuddy-connect: ${runtime.variant.displayName} catalog unavailable; serving the fallback list`, error);
				runtime.invalidate();
				return;
			}
			if (stopped || runtime.catalogGeneration !== generation) return;
			runtime.lastFetchAtMs = Date.now();
			runtime.catalog.set([...models]);
			runtime.catalogSource = "live";
			runtime.catalogFetchedAtMs = runtime.client.lastCatalog?.fetchedAtMs ?? Date.now();
			runtime.catalogError = void 0;
			if (lastIdentities.get(runtime.variant.id) === identity) runtime.savedCatalogs.set(identity, {
				source: runtime.client.lastCatalog?.source ?? "unknown",
				fetchedAtMs: runtime.client.lastCatalog?.fetchedAtMs ?? Date.now(),
				models: [...models],
				...runtime.client.lastCatalog?.appVersion === void 0 ? {} : { appVersion: runtime.client.lastCatalog.appVersion.version }
			});
			runtime.invalidate();
		})().finally(() => {
			if (runtime.inflightFetch?.promise === run) runtime.inflightFetch = void 0;
		});
		runtime.inflightFetch = {
			identity,
			generation,
			controller,
			promise: run
		};
		return run;
	};
	/**
	* Reconcile one variant with its credentials.
	*
	* Four transitions matter, and each is a different action:
	*
	* - **none → some** (first sighting): reveal the group and fetch a catalog.
	* - **none → some, identity changed**: additionally drop the previous
	*   account's observations, so another user's probe answers cannot be read as
	*   the new account's.
	* - **some → none**: hide the group and stop serving its models.
	* - **same identity**: nothing to do — the store refreshes tokens on demand,
	*   and re-fetching on every rotation would hit the catalog endpoint for no
	*   new information.
	*/
	const syncVariant = async (runtime) => {
		if (stopped || !runtime.registered) return;
		const credential = await runtime.store.current().catch((error) => {
			ctx.logger.warn(`dsh-workbuddy-connect: ${runtime.variant.displayName} credential read failed`, error);
		});
		if (stopped) return;
		if (credential === void 0) {
			adoptIdentity(runtime, void 0, void 0);
			return;
		}
		const identity = credentialIdentity(credential);
		if (lastIdentities.get(runtime.variant.id) === identity && runtime.catalog.isVisible()) {
			const stale = runtime.catalogSource !== "live";
			const due = Date.now() - runtime.lastFetchAtMs >= credentialPollMs() * CATALOG_RETRY_SWEEPS;
			if (stale && due) await fetchCatalog(runtime, identity);
			return;
		}
		adoptIdentity(runtime, identity, visibilityAccountOf(credential));
		await fetchCatalog(runtime, identity);
	};
	/** Run one reconcile sweep across both variants. */
	const syncAll = async () => {
		for (const runtime of runtimes) await syncVariant(runtime);
	};
	Promise.all(runtimes.map(async (runtime) => startVariant(ctx, runtime))).then(() => {
		if (stopped) return;
		if (runtimes.some((runtime) => runtime.registered)) writeHostHeartbeat();
		syncAll();
		const timer = setInterval(() => {
			syncAll();
		}, credentialPollMs());
		timer.unref?.();
		timers.push(timer);
	});
}
//#endregion
export { AI_VARIANT, CN_APP_VERSION_FILENAME, CN_VARIANT, Config, FALLBACK_CN_APP_VERSION, FALLBACK_WORKBUDDY_AI_MODELS, FALLBACK_WORKBUDDY_MODELS, PROBE_EFFORT_CANDIDATES, WORKBUDDY_AI_SETTINGS_NS, WORKBUDDY_APP_VERSION_FILENAME, WORKBUDDY_AUTH_FILENAME, WORKBUDDY_AUTH_FILE_ENV, WORKBUDDY_CATALOG_FILENAME, WORKBUDDY_HOST_HEARTBEAT_FILENAME, WORKBUDDY_PROBE_FILENAME, WORKBUDDY_PROVIDER, WORKBUDDY_SETTINGS_NS, WORKBUDDY_STREAM_IDLE_TIMEOUT_MS, WORKBUDDY_VARIANTS, WORKBUDDY_VISIBILITY_FILENAME, WorkBuddyCatalog, WorkBuddyCatalogStore, WorkBuddyCredentialStore, WorkBuddyProbeService, WorkBuddyProbeStore, WorkBuddyUpstreamClient, WorkBuddyVisibilityStore, appUserAgent, apply, chatUserAgent, classifyUpstreamError, clearHostHeartbeat, createWorkBuddyAdapter, createWorkBuddyShim, defaultDesktopAuthCandidates, defaultDesktopAuthPath, desktopAuthCandidatesFor, fallbackChatIdentity, fingerprintModel, inject, installedAppVersion, isHeartbeatProcessAlive, modelWithCurrentPromotion, name, normalizeCredits, parseModelCatalog, parseWorkBuddyAuth, prepareChatBody, prepareCnChatBody, prepareInternationalChatBody, probeModel, processStartTimeMs, randomSentinel, readBundleVersion, readCliVersion, readHostHeartbeat, regionOf, resolveAppVersion, resolveChatIdentity, validAppVersion, validCliVersion, variantFor, visibilityAccountOf, workbuddyCatalogPath, workbuddyHostHeartbeatPath, workbuddyOwnAuthPath, workbuddyProbePath, workbuddyVisibilityPath };
