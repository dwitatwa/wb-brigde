# Task: remove the client fingerprint from this ZCode fork

Instructions for an agent working inside a **fork of ZCode** (a Claude Code derivative).
Read all of "Constraints" before touching anything — two of them can silently waste
your entire session.

---

## Context: what is being removed and why

The WorkBuddy gateway rejects a chat request when the system prompt contains one
specific parenthetical sentence from Claude Code's git-status block. ZCode inherits
that block verbatim, so every request it sends from inside a git repository is
refused with:

```
HTTP 400  code 11128  "Illegal API invocation from an unapproved channel"
```

This is **deterministic** — it fails on every attempt, on every model, in any git
repository, regardless of branch. It is a literal case-insensitive substring match,
not a semantic content filter and not sampling.

The offending text is one array element inside the git-status builder. It renders as:

```
Main branch (<one parenthetical sentence about PRs>): <branch>
```

The parenthetical is the fingerprint. The `Main branch: <branch>` information itself
is harmless and useful — keep it, drop only the parenthetical.

---

## Constraints

1. **Do not run this task from a ZCode/Claude-Code session that routes through the
   WorkBuddy bridge.** That session's own system prompt still contains the
   fingerprint, so its requests are refused and it cannot edit files. Use an editor,
   a plain shell, or an agent running against a different provider.
2. **Never write the removed sentence into any file in this repository** — not into
   tests, fixtures, snapshots, changelogs, commit messages, or documentation. If it
   lands in a file that a later agent session reads, that session gets blocked too.
   If existing tests or fixtures assert the exact string, delete those assertions
   rather than preserving the string in a comment.
3. **Do not run a test suite whose output prints the string** until step 5 is done.
   Tool output containing the string is as fatal to a session as the source itself.
4. This is a content-level change to the client's prompt, not a wire-format change.
   Do not "fix" it by stripping content from outgoing requests in the HTTP layer
   unless you choose Option B below deliberately.

---

## Step 0 — confirm the fork is affected

```sh
grep -rn "Main branch (" . \
  --include=*.ts --include=*.tsx --include=*.js --include=*.mjs --include=*.cjs \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=build
```

Expect one hit (possibly a few, if the builder is duplicated). Note every file and
line number. If there are zero hits, stop and report — this fork may already be
patched, or the prompt may be generated somewhere unusual (see step 5).

## Step 1 — locate the builder function

The hit sits inside a function that assembles the git context. In Claude Code's
upstream source it is `getGitStatus()` in `context.ts`, memoized and called from
`getSystemContext()`. Names in a fork may differ; search for the structure instead:

```sh
grep -rn "Current branch:" . --include=*.ts --include=*.js --exclude-dir=node_modules
```

The target is the **array element immediately after** the one that renders
`Current branch: ${branch}`. It is a plain unconditional element — there is no
`if (mainBranch !== branch)` guard around it, and the whole block is only skipped
when the directory is not a git repository (`if (!isGit) return null`).

## Step 2 — edit

Change exactly one array element. Keep the interpolation, drop the parenthetical:

```diff
   return [
     `This is the git status at the start of the conversation. …`,
     `Current branch: ${branch}`,
-    `Main branch (<parenthetical>): ${mainBranch}`,
+    `Main branch: ${mainBranch}`,
     ...(userName ? [`Git user: ${userName}`] : []),
     `Status:\n${truncatedStatus || '(clean)'}`,
     `Recent commits:\n${log}`,
   ].join('\n\n')
```

Rules:
- Do **not** delete the whole element — the model uses the main-branch name.
- Do **not** touch the `Current branch:` element or the `isGit` early return.
- Do **not** reformat the surrounding array, and do not reorder elements; the joined
  output is part of the prompt and unrelated diffs make review harder.
- If the same string appears in more than one file, apply the identical edit to each
  and say so in your report.

## Step 3 — rebuild

Detect the build tool from `package.json` rather than assuming:

```sh
node -e "console.log(Object.keys(require('./package.json').scripts||{}).join(' '))"
```

Then run the project's build (`build`, `compile`, or equivalent). Do not skip this —
the shipped artifact is what sends the request, and stale output means the fix is
invisible.

## Step 4 — verify

1. **Source and artifact are clean** — the parenthetical is gone everywhere:

```sh
grep -rn "Main branch (" . --exclude-dir=node_modules --exclude-dir=.git
```

Expect only `Main branch: ${mainBranch}`-shaped hits, or none at all. No hit may
contain a parenthetical.

2. **The rebuilt client is accepted.** Start the WorkBuddy bridge if it is not
   running (`workbuddy-bridge serve --wsl` in the bridge checkout), point the rebuilt
   client at it, open a **git repository** as the working directory, and send one
   message. Expect a normal answer, not a 400.

3. **Pass/fail signal that needs no log reading:** the bridge writes
   `~/.workbuddy-bridge/last-channel-failure.json` only when a channel refusal
   occurs. Note its timestamp before the test; if it did not change, no refusal
   happened:

```sh
ls -l ~/.workbuddy-bridge/last-channel-failure.json 2>/dev/null || echo "no capture file"
```

4. If it still fails, read that capture file. It contains the exact request body the
   client sent; grep it for `Main branch (` to see whether an old copy is still
   being transmitted (a stale build, a vendored duplicate, or a second code path).

## Step 5 — purge other copies

Bundled and generated output can carry the old string independently of source:

```sh
grep -rln "Main branch (" . --exclude-dir=node_modules --exclude-dir=.git
```

Check every hit. Typical leftovers: `dist/`, `build/`, `out/`, minified bundles,
`*.map` files, vendored copies of the prompt, snapshot fixtures, and
`__snapshots__/`. Regenerate or delete build output rather than hand-editing it.

Also search for a second prompt path — some forks keep a fallback or "lite" context
builder that renders the same block:

```sh
grep -rn "Recent commits:" . --include=*.ts --include=*.js --exclude-dir=node_modules
```

Every place that emits the git block must use the patched form.

## Rollback

The change is one line. `git diff` shows it; `git checkout -- <file>` reverts it.
No migration, no state, no config.

---

## Option B — single choke point (only if you want durability)

If you expect the vendor to add further fingerprints, patching the template means
playing catch-up. An alternative is to normalise the outgoing system prompt once, in
the fork's request-building layer, before the body is serialised:

- locate where the request body is assembled (the function that builds
  `messages` for the completion call);
- add one small pure function that rewrites system-message content, applied to
  system messages only;
- keep it narrow and explicit — a named function with a comment explaining why,
  not a silent general-purpose sanitiser.

Trade-off: it survives future prompt changes, but it edits message content on every
request, which is a broader and harder-to-audit behaviour than a one-line template
change. Prefer step 2 unless you have a reason.

---

## Report back with

- files and line numbers changed;
- the diff of each change;
- build command used and its result;
- output of the step 4 grep;
- whether the acceptance turn returned 200, and the capture-file timestamp evidence;
- any additional copies found in step 5 and how they were handled.

---

## Caveats worth knowing

- The gateway's check is content-based, so a fork that removes this one line can be
  broken again by a future server-side addition. Nothing in the client guarantees
  forward compatibility.
- The same numeric code `11128` also covers the separate, **sampled** conversation
  header check, which is why `11128` alone is ambiguous. That one is retried by the
  bridge and usually succeeds; this one never does.
- Whether removing a vendor's client-identification check is acceptable under the
  WorkBuddy terms is a decision for the fork's owner, not something this document
  resolves.
