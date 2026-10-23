# TS source rewriting: editing the user's CDK code in place

Research for ticket #20 (resolved; see the Truss v1 map, #8). Done 2026-10-22 against `typescript@6.0.3` (through `@typescript/typescript6@6.0.2`), `typescript@7.1.0-beta` (published 2026-10-20), `ts-morph@28.0.0` (bundles TS 6.0.2), `recast@0.24.0` with `@babel/parser@8.0.7`, `jscodeshift@17.4.0` (read from npm metadata, not run), and `aws-cdk-lib@2.274.0`.

Claims marked **[exp]** were checked by experiment in a scratch directory. One sample CDK stack was written in a deliberately non-default style: 4-space indent, double quotes, no semicolons, trailing commas, line and block comments inside an object literal, and a double blank line. Five canvas-style edits were applied to it with each tool, and each result was diffed against the original:

- **E1**: change a prop's value (`versioned: false` → `true`).
- **E2**: add a prop to an existing props object.
- **E3**: remove a `new` statement.
- **E4**: add a new construct statement plus its import.
- **E5**: add a props object to a `new` call that has none.

A separate experiment synthesized a real CDK app and joined its creation stacks to `NewExpression` nodes (§5).

## TL;DR

- **Use span edits, not reprinting.** Find the node with a TS parser, then splice new text over its exact `[getStart(), end)` range, leaving every other byte alone. For new code, print only the inserted fragment, in the file's detected style. The edits that preserve formatting best all do this: the TS language service's internal `textChanges.ChangeTracker`, Angular schematics' `UpdateRecorder`, and Storybook's new magic-string `SourceEditor`.
- **`ts.textChanges.ChangeTracker` (TS 6) gave the best diffs in every case [exp].** E1 changed 1 line, E2 added 1 line, E3 removed 2 lines, E4 added 2 lines and E5 changed 1 line. It copies the list's separator and trailing-comma style, removes a statement *together with its leading comment*, and follows the configured indent, newline (CRLF kept), and semicolon settings. The catch is that it is **internal**: it is on the runtime `ts` object but not in `typescript.d.ts` [exp], so it has no stability promise and no TS 7 equivalent.
- **ts-morph is close, with sharp edges [exp].** It does the same text splicing and re-parses the whole file after every edit. Its own printers add semicolons regardless of the file's style (`import * as sqs from "…";`), and they skip trailing commas unless `useTrailingCommas` is set. It also ate a blank line next to an added import, and on remove it left the statement's leading comment orphaned.
- **recast and jscodeshift are the wrong fit [exp].** Any change to a list reprints the whole list. Adding one prop moved an existing trailing comment onto its own line and inserted blank lines, which is a 5+/1− diff for a one-line change. It adds semicolons too. recast's bundled `babel-ts` parser also crashes on `@babel/parser` 8 [exp], and jscodeshift still pins `recast ^0.23` and `@babel/parser ^7`.
- **TS 6 vs 7.** Everything above runs on `@typescript/typescript6`, which is a thin re-export of `typescript@^6` [exp]. TS 7.1 beta's new API (`typescript/sync`, `/ast`, `/ast/factory`, `api.printer.printNode`) can already do the core loop: parse, find a span with `getStart`/`end`, print a factory node, splice [exp]. But it has no `ChangeTracker`, list-aware insertion, or formatter. Its `SyntaxKind` numbers also differ from TS 6 (`TrueKeyword` is 111 vs 112) [exp], so no code is shared across the two APIs.
- **The construct path → `NewExpression` join is exact for straight-line code [exp].** A creation stack's first user frame maps through the `.js.map` to the precise start of the `new` token. That held for two constructs on one line and for `new` nested inside another construct's props. It is **ambiguous by design** for loops, helper functions, and constructs created inside user `Construct` subclasses: several construct paths land on one span. Those are exactly the Nodes that must be read-only.
- **No prior art writes GUI edits into hand-written IaC code.** Composer rewrites whole SAM templates and strips comments. Amplify Studio regenerates files and tells users not to edit them. `cdk lsp` only reads (no code actions). Prisma `db pull` keeps comments and `@map` by merging, but in its own DSL. The closest match is Storybook's "save from controls", which writes args back into user story files.
- **Recommendation for Truss.** Put a small **source-edit adapter** behind a port: (1) parse with TS 6, (2) locate by span plus a check (the `NewExpression` at that offset still has the expected class and literal ID, and the file hash matches the last synth), (3) emit `TextChange[]` built by `ChangeTracker`, or by a thin hand-written splicer for the few edit kinds Truss needs, (4) apply, re-parse, and refuse on any syntax error. Detect indent, quotes, semicolons, newline and trailing commas from the file. Never run a formatter over the whole file.

## 1. The options

| Option | How it edits | Maturity / status | Formatting preservation |
|---|---|---|---|
| **Raw TS compiler API + text splice** | Parse (`ts.createSourceFile`, `setParentNodes: true`), compute `node.getStart(sf)` / `node.end`, splice. Print new fragments with `ts.createPrinter().printNode`. | Public, stable TS 6 API. | Perfect outside the splice. You own separators, commas, indentation and comment ownership. |
| **`ts.textChanges.ChangeTracker`** | The engine behind every TS quick fix and refactor. You record `replaceNode`, `delete`, `insertNodeAfter`, `insertNodeInListAfter`, …; it returns `FileTextChanges[]`, applied with `textChanges.applyChanges`. New nodes are printed and then formatted by `ts.formatting` with your `FormatCodeSettings`. | Battle-tested through tsserver, but **internal**: present at runtime as `ts.textChanges` / `ts.formatting`, absent from `typescript.d.ts` [exp]. The exported names include `ChangeTracker`, `applyChanges`, `LeadingTriviaOption`, `TrailingTriviaOption` [exp]. | Best measured [exp]. |
| **ts-morph** | Wraps the TS 6 AST. Each manipulation "updates the file text", then "the new text is parsed and a new AST is created", then wrapped nodes are backfilled ([performance docs](https://ts-morph.com/manipulation/performance)). Navigated descendants are "forgotten" after raw text edits ([manipulation docs](https://ts-morph.com/manipulation/)). | v28.0.0, actively released. It bundles its own TS (6.0.2 via `@ts-morph/common`) [exp] and does not use `ChangeTracker` internally (0 references in `dist/ts-morph.js`) [exp]. | Good for edits to existing nodes. Generated code comes from its own `code-block-writer`, configured by `manipulationSettings` (quote kind, indent, trailing commas), with **no semicolon setting** [exp]. |
| **recast** (+ `@babel/parser` TS plugin) | Parses to ESTree/Babel AST with original tokens. On print it "reprints only those parts of the syntax tree that you modify" and otherwise "falls back to using a generic pretty printer" ([README](https://github.com/benjamn/recast)). | v0.24.0. Its bundled `recast/parsers/babel-ts` fails with `@babel/parser@8.0.7` ("pipelineOperator requires proposal") [exp]; a custom parser wrapper works. | Fine for leaf replacement. A modified list (props, args, statements) gets reprinted [exp]. |
| **jscodeshift** | A codemod runner over recast. | v17.4.0 depends on `recast ^0.23.11` and `@babel/parser ^7.24.7` (npm metadata). | Same as recast. |
| **Prettier over the result** | Reformat the whole file after any edit. | Mature. | Rewrites untouched code unless the file was already Prettier-clean with the same config. Ruled out as a default; this is what Storybook does (see §4). |

## 2. Experiment results (diff lines, `+added / −removed`)

| Edit | `ChangeTracker` (TS 6) | ts-morph (default) | ts-morph (tuned¹) | recast |
|---|---|---|---|---|
| E1 change prop value | **+1 −1** | +1 −1 | +1 −1 | +1 −1 |
| E2 add prop | **+1 −0**, trailing comma copied | +1 −0, **no trailing comma** (style break) | +1 −0 | +5 −1: existing `// TODO revisit` moved off its line, blank lines inserted |
| E3 remove statement | +0 −2, leading comment removed with it; leaves a doubled blank line | +0 −2, **leading comment orphaned** | same | **+0 −3**, comment and one blank line removed (cleanest) |
| E4 add statement + import | **+2 −0**, no semicolons as configured | +2 −1: import gets `;`, a blank line deleted | same | +5 −0: both get `;`, extra blank lines |
| E5 add props arg | **+1 −1** | +1 −1 | +1 −1 | +3 −1, expanded to multi-line |

¹ `quoteKind: Double`, `indentationText: FourSpaces`, `useTrailingCommas: true`.

All runs **[exp]**. Things to note:

- **Comment ownership is the hard part, not text splicing.** E3 shows three different policies across the tools. `ChangeTracker` uses `LeadingTriviaOption` / `TrailingTriviaOption` to decide that a comment directly above a statement belongs to it. Truss should adopt that policy explicitly, whichever tool it uses.
- **Inserted code must be printed in the file's style.** `ChangeTracker` takes indent and semicolons from `FormatCodeSettings` (`semicolons: SemicolonPreference.Remove/Insert`, `convertTabsToSpaces`, `indentSize`) and newlines from the host. A CRLF + tab + semicolon + single-quote variant of the sample got CRLF-only output, tab-only indentation and `;` on the new statement [exp]. Quotes are *not* a formatter setting: the printer uses each literal's own flag (`factory.createStringLiteral(text, /*isSingleQuote*/ true)`) [exp]. So Truss has to detect quote style and build literals to match.
- **Re-parse after every write.** All of these tools can produce syntactically wrong text if they are given a bad fragment. A cheap guard is to re-parse the result, compare the diagnostics count with the original's, and refuse to write on any new syntax error.

## 3. TypeScript 6 vs 7

- **TS 6 is the working target.** `@typescript/typescript6@6.0.2` is a three-line package whose `lib/typescript.js` is `module.exports = require("@typescript/old")`, with `@typescript/old` aliased to `npm:typescript@^6` (resolved to 6.0.3) [exp]. The full public API, plus the internal `textChanges` / `formatting` namespaces, works through it [exp]. The 7.0 RC post points API users to this package and says the stable API comes "with TypeScript 7.1" ([Announcing TypeScript 7.0 RC](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0-rc/); see also `docs/research/import-feasibility.md` §3).
- **TS 7.1 beta (2026-10-20).** The [7.1 beta post](https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/) introduces `typescript/sync` and `typescript/async` clients, `typescript/ast` ("Syntax tree node (AST) types and enums"), `typescript/ast/is` and `typescript/ast/factory` ("`create*` and immutable `update*` functions"). It is still asking for feedback, with an RC "in about a month". The package exports also include `./ast/visitor`, `./ast/scanner` and `./ast/clone` [exp]. `API` has `createSourceFile(fileName, text)` and a `printer` with `printNode` / `printFile`, backed by the Go process [exp]. It also has `getImportAdderEdits` / `getImportEditsForSymbols`, which return `TextEdit[]`. That last pair is useful for "add an import for `sqs`".
- **What works on 7.1 beta [exp].** Parsing the sample, finding the `Uploads` `NewExpression`, taking `prop.initializer.getStart(sf)`/`.end` (464–469, `"false"`), printing `createKeywordExpression(SyntaxKind.TrueKeyword)` and splicing it in gave the same 1-line E1 diff. So the span-edit design carries over to 7.x.
- **What doesn't carry over.** There is no `textChanges`, no `formatting`, and no list-aware insertion or trivia policy in the 7.1 surface. Node kinds are renumbered: `TrueKeyword` 112 → 111 and `NewExpression` 215 → 216 [exp]. ts-morph is TS 6 only. **Implication:** keep Truss's edit layer to a small vocabulary of *span operations* that Truss implements itself (replace span, insert after node with a separator, remove a node with its owned trivia, insert into a list). Then `ChangeTracker` is an implementation detail of the TS 6 adapter, and a 7.x adapter only has to supply parse, locate and print.

## 4. Prior art: GUI → source write-back

| Tool | What it writes | How it treats user formatting |
|---|---|---|
| **AWS Infrastructure Composer** (SAM/CFN) | Whole template, live-synced with the canvas | Opening a file strips comments and blank lines and mangles intrinsics. The only mitigation is a backup folder (`docs/research/prior-art.md` §1, refs [9]–[11]). It's a cautionary tale. |
| **Amplify Studio** (UI builder) | Regenerates component files on `amplify pull` | Edits to generated code are overwritten. Users either customise through an `overrides` prop or copy the component out ([Extend with code](https://docs.amplify.aws/react/build-ui/uibuilder/override/)). A generation gap, not in-place editing. |
| **`cdk lsp` / cdk-explorer** | Nothing | Provides hover, go-to-definition, code lenses ("`Creates <Type>`") and diagnostics; "any suggested fix ride[s] in the diagnostic message". There are no code actions ([README](https://github.com/aws/aws-cdk-cli/tree/main/packages/%40aws-cdk/cdk-explorer)). It proves the source join, not the write. |
| **Prisma `db pull`** | Rewrites `schema.prisma` from the DB | "merges manual changes made to the schema" and keeps comments, `@map`/`@@map` and custom `@relation` names on relational DBs ([Introspection](https://www.prisma.io/docs/orm/prisma-schema/introspection)). It shows that preserving user edits is a stated product feature, though in a DSL Prisma fully owns. |
| **Angular schematics** | Edits user TS files | Changes are staged on a virtual `Tree` and "only applied in the real file system once they're confirmed to be valid" ([Authoring schematics](https://angular.dev/tools/cli/schematics-authoring)). File edits go through `UpdateRecorder { insertLeft(index), insertRight(index), remove(index, length) }`, which is pure offset splicing ([`tree/interface.ts`](https://github.com/angular/angular-cli/blob/main/packages/angular_devkit/schematics/src/tree/interface.ts)). The offsets come from the TS AST in `@schematics/angular` utilities. |
| **Storybook "save from controls"** | Writes changed args back into the user's CSF3 story file, or appends a cloned story ([PR #26827](https://github.com/storybookjs/storybook/pull/26827)) | Released versions print the CSF file and then run Prettier if it is installed (`formatFileContent(path, printCsf(csf).code)` in [`save-story.ts`](https://github.com/storybookjs/storybook/blob/next/code/core/src/core-server/utils/save-story/save-story.ts)). On `next` (commit `d9f09280`, 2026-10-16), csf-tools moved to an OXC-parsed ESTree with a magic-string `SourceEditor` (`overwrite`/`remove`/`appendLeft` by offset). `printCsf` is now documented as "Untouched code is kept as written" ([`estree/editor.ts`](https://github.com/storybookjs/storybook/blob/next/code/core/src/csf-tools/estree/editor.ts), [`CsfFile.ts`](https://github.com/storybookjs/storybook/blob/next/code/core/src/csf-tools/CsfFile.ts)). A mature AST-reprinting tool converging on span edits is the strongest signal for Truss's design. |

## 5. Is the creation-stack → `NewExpression` join precise enough?

Experiment **[exp]**: a real `aws-cdk-lib@2.274.0` app was compiled with `tsc` (`sourceMap: true`) and synthesized. For each `aws:cdk:creationStack` entry in `Demo.metadata.json`, the first `dist/app.js` frame was mapped through `app.js.map` with `source-map`. The script then looked for a `NewExpression` whose `getStart()` equals the mapped offset:

```
21:19 new s3.Bucket(this, "A")                <- /Demo/A/Resource
21:49 new s3.Bucket(this, "B")                <- /Demo/B/Resource        (same line, distinct column)
22:22 new iam.Role(this, "Role", {            <- /Demo/Role/Resource
24:31 new iam.ManagedPolicy(this, "MP", { …   <- /Demo/MP/Resource       (nested inside Role's props)
27:13 new s3.Bucket(this, `Loop${n}`)         <- /Demo/LoopL1/Resource, /Demo/LoopL2/Resource
 8:12 new sqs.Queue(scope, id)                <- /Demo/HelperQ1/Resource, /Demo/HelperQ2/Resource
14:9  new s3.Bucket(this, "Left")             <- /Demo/P1/Left/Resource, /Demo/P2/Left/Resource
```

- **Every mapped position hit the start of a `new` token exactly.** No "nearest node" search was needed. The column tells apart several constructs on one line, and nested `new` calls resolve to the inner one. `new iam.ServicePrincipal(...)` is not a construct, so it has no entry, as expected.
- **The L2's location is its L1's.** The creation stack is recorded on the L1 (`…/A/Resource`), and its first user frame is the L2's `new s3.Bucket`. The L2 Node's path is the L1 path's parent.
- **Many paths → one span is the read-only signal.** Loops, helper functions (`makeQueue`) and user `Construct` subclasses (`Pair`) all collapse several construct paths onto one span. Editing that span would change every instance. The rule *"a Node is editable only if exactly one construct path maps to its span, and the span's `NewExpression` has a string-literal ID equal to the path's last segment"* separates the cases cleanly. Deeper frames point at the call sites (`makeQueue(this, "HelperQ1")`, 3 user frames), which Truss could show as "defined via helper" without editing.
- **Staleness.** Spans come from the last synth, but the file may have changed since. Before writing, Truss should check the file's hash against the one at synth time, or at least re-verify the class and literal ID at the offset, and otherwise re-synth or refuse. Keeping this check in the core fits ADR 0004's "don't clobber silently" rule.
- **Preconditions** are the same as in `docs/research/import-feasibility.md`: source maps on (or `tsx`/`ts-node`), creation stacks not disabled, and `--stack-trace-limit` raised for lazily created children.

## 6. Recommendation

1. **The write path is a span-edit adapter behind a port** (a "Source" port beside ADR 0004's Files port, or inside the Files adapter). The core computes *what* to change: Node → `{file, span, expectedClass, expectedId}` plus an edit intent. The adapter turns that into `TextChange[]` and applies it. This keeps the core pure and the TS version swappable.
2. **TS 6 adapter**: `@typescript/typescript6` parse plus `textChanges.ChangeTracker`, pinned to an exact version because the API is internal. Cover it with golden-diff tests like the five edits above, on a style matrix (tabs/spaces, CRLF, semis/no semis, quote styles, trailing commas). If pinning an internal API is unacceptable, the fallback is a hand-written splicer for the four span operations. The splicer is small because Truss's edit vocabulary is small. ts-morph adds weight without better diffs and is TS 6-bound too.
3. **Style detection**: infer indent unit, newline, semicolons, quote style and trailing commas from the file (or the nearest `.editorconfig` / Prettier config) and feed them to the printer and formatter. Never reformat untouched code.
4. **Safety gates**: span verification plus file hash, re-parse after the edit with no new syntax diagnostics, and a dry-run diff the user can see before writing. Nodes that fail the one-path-per-span rule, or whose prop isn't an inline object literal, are read-only.
5. **TS 7**: track the 7.1 API. Parse, `getStart`/`end`, factory and `printNode` already work in the beta, so only the list and trivia helpers would need re-implementing.

## Sources

- TypeScript: [Announcing TypeScript 7.0 RC](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0-rc/), [Announcing TypeScript 7.1 Beta](https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/), [Using the Compiler API (wiki)](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API), [`src/services/textChanges.ts`](https://github.com/microsoft/TypeScript/blob/main/src/services/textChanges.ts); npm packages `typescript@6.0.3`, `typescript@7.1.0-beta`, [`@typescript/typescript6`](https://www.npmjs.com/package/@typescript/typescript6) (inspected locally)
- ts-morph: [Manipulation](https://ts-morph.com/manipulation/), [Performance](https://ts-morph.com/manipulation/performance), npm `ts-morph@28.0.0` / `@ts-morph/common@0.29.0`
- recast: [benjamn/recast README](https://github.com/benjamn/recast); jscodeshift: npm `jscodeshift@17.4.0` metadata
- AWS: [`cdk-explorer` README](https://github.com/aws/aws-cdk-cli/tree/main/packages/%40aws-cdk/cdk-explorer), [Amplify UI builder: Extend with code](https://docs.amplify.aws/react/build-ui/uibuilder/override/); Infrastructure Composer behaviour via `docs/research/prior-art.md`
- Prisma: [Introspection](https://www.prisma.io/docs/orm/prisma-schema/introspection)
- Angular: [Authoring schematics](https://angular.dev/tools/cli/schematics-authoring), [`angular_devkit/schematics/src/tree/interface.ts`](https://github.com/angular/angular-cli/blob/main/packages/angular_devkit/schematics/src/tree/interface.ts)
- Storybook: [PR #26827 "Core: Save from controls"](https://github.com/storybookjs/storybook/pull/26827), [`save-story.ts`](https://github.com/storybookjs/storybook/blob/next/code/core/src/core-server/utils/save-story/save-story.ts), [`csf-tools/estree/editor.ts`](https://github.com/storybookjs/storybook/blob/next/code/core/src/csf-tools/estree/editor.ts), [`csf-tools/CsfFile.ts`](https://github.com/storybookjs/storybook/blob/next/code/core/src/csf-tools/CsfFile.ts)
- Related Truss research: `docs/research/import-feasibility.md`, `docs/research/prior-art.md`, ADR 0004
