# Canvas edits are staged in a Draft and written on Save

ADR 0005 makes the app's code the source of truth and every canvas edit an edit to the user's files. We keep that, but an edit doesn't reach disk on the gesture: canvas edits collect in a **Draft**, held in memory by the local process, and reach the user's files only when the user reviews the diff and clicks Save. Truss is rewriting hand-written code, so users must be able to see that the result looks right, and synths, before anything is overwritten.

## Considered Options

- **Write on every committed gesture, with `git diff` as the review**: rejected. It's simpler and there's no second copy of state, but the first sight of a bad edit would be in the user's own files, and undo would have to refuse whenever a file changed underneath it.
- **An optimistic canvas that patches its own view and synths only after Save**: rejected. Layers and synth errors would be stale exactly when the user is judging whether the Draft looks okay.

## Consequences

- **Shadow synth.** Truss applies the Draft's text changes to a shadow copy of the app (its `node_modules` linked, not copied) and synths that, so the canvas shows the proposed Design with live Computed Layers and synth errors. Save writes the same text changes to the real files.
- **Review before Save.** Draft items carry added/changed/deleted badges on the canvas. Deleted Nodes stay as ghosts. A review panel shows the exact per-file diff Save will write.
- **Save is all-or-nothing.** Every touched file passes its staleness check (hash from the last synth, plus class and literal ID at the span), or nothing is written. Discard drops the whole Draft. There's no per-hunk saving in v1.
- **Undo steps through the Draft**, so it never touches disk. After Save, undo is git's job.
- **Rebasing on outside changes.** When files change on disk (git, editor, formatter), Truss re-derives the base and re-locates each Draft edit by construct path, class and literal ID. Edits that no longer locate are dropped, and the user is told which. While the new code doesn't synth there is no base to rebase on, so the Draft is held as it was: Save, Undo and Redo are paused, Discard still works, and the rebase happens when the app synths again.
- **The Draft is never persisted.** Closing the tab warns, and Ctrl+C asks before discarding an unsaved Draft.
- The source port (ADR 0004's successor) has to cover shadow-copy synth and rebasing the Draft, not just span edits.
