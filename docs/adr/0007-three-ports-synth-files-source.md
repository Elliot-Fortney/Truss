# Three ports: Synth, Files and Source

ADR 0004's Instantiation port (`instantiate(design)`) no longer fits: since ADR 0005 there is no Design document to instantiate, only the user's app. This supersedes ADR 0004. What still holds from it: the local process owns the state (now the Draft and its undo), the browser is a thin view over one WebSocket session, code is split into core, session, adapters and ui with dependencies pointing inward, and user code never runs in the main thread.

The core sits behind three ports:

- **Synth** returns the cloud assembly (`tree.json`, templates, metadata) or a synth error. Its adapter calls CDK's own synth through `@aws-cdk/toolkit-lib` (`fromCdkApp` + `synth`), which owns `cdk.json`, the app command, context and the output directory. It runs in a child process that can be killed. The adapter only turns creation stacks on and, for a Draft, builds a shadow copy: source files copied, `node_modules` symlinked, Draft text applied. If the app command runs compiled JS, it runs the app's `build` script first. With no `build` script the app is read-only, and the reason is shown.
- **Files** reads, writes and watches the app's files.
- **Source** is the only module that imports `typescript`. Its interface carries no syntax trees:
  - `analyse(files, assembly)` returns facts for each construct path: file, span, class FQN, literal ID if any, how many paths share the span, binding, and each prop's kind and source text.
  - `plan(code, intents)` returns `TextChange[]` for each file, or a refusal with a reason and the intent it failed on. It owns style detection, comment ownership, imports in the file's alias style, find-references and the re-parse guard.
  - The adapter is TS 6 (`@typescript/typescript6`, `textChanges.ChangeTracker`, both pinned exactly). It keeps a warm `LanguageService` fed with file versions from the watcher and the Draft. Moving to TS 7.1 later replaces only this adapter.

## Decisions within the ports

- **The Draft stores intents, not text.** An intent (`setProp`, `addNode`, `removeNode`, `renameId`, `addConnection`) names its target by construct path plus the expected class and literal ID. Text changes are re-derived from the current code plus the intents whenever the shadow synth, the review diff or Save needs them. Rebasing (ADR 0006) means planning again; an intent that no longer finds its target is dropped with a notice. Undo pops an intent. Intents are planned in sequence, re-parsing between them, so a later intent can target a Node an earlier one added.
- **The core decides editability.** Source reports facts and the core applies the lock rules (one path per span, literal ID, inside a user Construct class, and so on), so the rules are pure code. `plan` refuses anything it can't place, as a second gate.
- **Synth is coalesced.** At most one synth runs and at most one waits; the waiting one always takes the latest state. The canvas never waits on synth: Draft badges, ghosts and prop values come from `analyse` straight away, and Computed Layers and synth errors refresh when synth finishes, with a "synthing…" indicator meanwhile.

## Considered Options

- **Fold source analysis into the synth port, as one "App" port**: rejected. Synth runs user code: it's slow, can hang, and is faked in tests. Source is a deterministic library call that is tested for real. Different failure modes, different test strategies.
- **Read-only synth → diagram, no Source** (the `cdk synth` + graph pattern that cdk-dia uses): rejected for v1. It gives the structure but not where in the code each construct came from, so no edit could be written back. Synth output is still the only source of structure.
- **Running the app command by hand** (spawn it with `CDK_OUTDIR` set): rejected. toolkit-lib already does this, including context.
- **Draft as text patches**: rejected. Rebasing would mean re-anchoring offsets.
- **Source decides editability**: rejected. The lock rules would then be tied to the TS adapter and slower to test.
- **Kill and restart synth on every change**: rejected. On a slow app, synth would never finish while the user is editing.
- **A fresh TS Program per analysis**: rejected. It takes seconds on large apps.

## Consequences

- Source has one adapter and no fake. Its tests use real TS 6 on fixture apps. The seam exists to keep `typescript` out of the core and to make a TS 7 swap local.
- TDD order (replacing ADR 0004's):
  1. `Source.analyse` on fixture CDK apps with recorded synth output: straight-line code, two constructs on one line, nested `new`, loop, helper, user Construct subclass, non-literal ID, props given as a variable.
  2. The core's editability rules and view projection, fed hand-written facts.
  3. `Source.plan` golden diffs for each edit kind over a style matrix (tabs or spaces, CRLF, with or without semicolons, both quote styles, trailing commas).
  4. The session with a fake Synth, in-memory Files and the real Source: intents, undo, rebasing, all-or-nothing Save with staleness checks.
  5. A few tests each for the toolkit-lib Synth adapter (shadow copy, build script) and the Files watcher, plus a few end-to-end tests over the socket.
- Hosting later still means one session per user. Synth is the part to sandbox.
- **`plan` groups intents by the `new` call they edit** rather than re-parsing after each one. For `setProp` that is the same result, because every edit stays inside its own call, and edits to one call are applied together so a later one can land in an object an earlier one created. `plan` takes the `facts` the files were read with, since it locates a target by its span. When `addNode` arrives, planning in sequence with a re-parse between intents is still the way for a later intent to target a Node an earlier one added.
- **Source also type-checks.** `diagnostics(appDir, files, touched)` gives the TypeScript diagnostics of the files an edit touches, so Save can refuse an edit that adds one. It reads the app's own `tsconfig.json` and `node_modules` and overlays `files` for the text the app has on disk or in the Draft.
