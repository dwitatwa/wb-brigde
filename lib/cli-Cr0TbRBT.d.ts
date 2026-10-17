//#region src/standalone/cli.d.ts
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
/** Entry point. */
declare function main(argv?: readonly string[]): Promise<void>;
//#endregion
export { main as t };