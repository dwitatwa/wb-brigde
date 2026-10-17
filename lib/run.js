#!/usr/bin/env node
import { t as main } from "./cli-BBLrcyAh.js";
//#region src/standalone/run.ts
/**
* The `workbuddy-bridge` executable.
*
* This file exists purely to *run* the CLI, and is the only place that does
* so. `cli.ts` deliberately has no top-level side effects: it is exported from
* the package as a library, so an import must never start a server.
*
* The split is not stylistic. Detecting "am I the program?" from inside the
* CLI cannot work once the bundle is code-split — the entry the shell runs
* (`cli.js`) is a thin re-export, while the code that would perform the check
* lives in a hashed chunk whose `import.meta.url` ends in `cli-<hash>.js`.
* Any `import.meta.url.endsWith('cli.js')` guard is therefore false at exactly
* the moment it must be true, and the CLI silently exits having done nothing.
* Making the entry point itself unconditional removes the question.
*
* @module workbuddy-bridge/standalone/run
*/
main().catch((error) => {
	console.error(`workbuddy-bridge: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
//#endregion
export {};
