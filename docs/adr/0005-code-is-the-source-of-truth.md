# The app's CDK code is the source of truth; Truss keeps only a Sidecar

Truss opens a whole CDK app, the unit `cdk.json` synthesizes, and derives the Design from that app's code every time. Opening uses synth for structure and the TypeScript source for props and spans. Every canvas edit is an edit to the user's own files. A Design started in an empty folder works the same way: Truss writes a minimal app (the Scaffold) and edits it from then on. The only thing Truss stores is a committed Sidecar, `truss.json` next to `cdk.json`, holding what code can't express: Node positions and notes, keyed by construct path. This supersedes ADR 0002 (generation gap) and ADR 0003 (authored-JSON Design file), both written when v1 was Design → code only and reading code back was planned for v2.

## Considered Options

- **A one-time Import, after which Truss owns a Design file and Exports through the generation gap**: rejected. A teammate's hand edit or a `git pull` would land in code Truss no longer reads.
- **A full Design file and the code, synced both ways**: rejected. It's the same as the option above plus a permanent merge problem whenever both sides change.

## Consequences

- **A Node's identity is its construct path.** Truss writes no markers into user code. A Construct ID renamed outside Truss makes the Node look new, and it gets auto-laid out. That's honest, since a rename replaces the deployed resource anyway.
- **Truss watches the app's files**, including `package-lock.json`, and re-synths on any change: git operations, editor saves, formatters and Truss's own writes. Changes are debounced. If synth fails, the canvas keeps the last good Design, dimmed, with the error shown, and canvas editing pauses until the code compiles.
- **The Sidecar tolerates drift.** A Node it doesn't know is auto-laid out. Entries for paths missing from the current code are kept, so switching branches doesn't lose layout. Only Truss's own delete or rename removes or moves an entry. It keeps `formatVersion` and the migration chain from ADR 0003. The Preview is written as `truss.svg` beside it.
- **Export, Construct-only Export, the Generated File, the Extension File and Import are retired** as terms. Scaffold now means only the starter app.
- **Only TypeScript apps can be opened.** A construct library with no `cdk.json` has nothing to synth. In apps written in other CDK languages, creation stacks point into the jsii runtime rather than user code, so nothing could be edited. Both are out of scope for v1. The synth-based read path stays language-agnostic, so read-only viewing of other languages remains cheap to add later.
- **How an edit becomes a text change**, and which Nodes are editable, is decided separately (the write-back ticket, informed by `docs/research/ts-source-rewriting.md` on the research branch).
