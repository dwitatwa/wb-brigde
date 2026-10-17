# Instruction: remove the fingerprint

1. Search the whole repository for `Main branch (` in `.ts`, `.tsx`, `.js`, `.mjs` and `.cjs` files, excluding `node_modules` and `.git`. Note every file and line number found.

2. In each file found, locate the array element that renders `Main branch (<parenthetical>): ${mainBranch}`. Rewrite that element so it reads exactly `` `Main branch: ${mainBranch}`, `` — keep the interpolation, delete the parenthetical, change nothing else in the file.

3. Delete the build output directories (`dist`, `build`, `out`) and rebuild the project using the build script declared in its `package.json`.

4. Search the whole repository again, this time including build output. The fix is complete when no remaining hit contains a parenthetical after `Main branch`. Report the files changed, the diff of each, and the result of this final search.
