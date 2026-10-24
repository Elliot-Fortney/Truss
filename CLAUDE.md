## Agent skills

### Issue tracker

GitHub Issues in `Elliot-Fortney/Truss`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Code review

When a review (e.g. `/code-review`, or the review step of `/implement`) covers a diff that touches `src/ui/` or any `.tsx` file, also run `/vercel-react-best-practices` on the UI changes. Skip it for diffs that don't touch the UI.

### Ticket walkthrough

When finishing a ticket (the end of `/implement`, or any time work for an issue is complete), spawn a Haiku agent (`model: "haiku"`) to walk the user through the critical code paths the ticket changed. Give it the ticket's diff and tell it to cover only what the user must understand to review safely: new or changed control flow, state transitions, data-model or API changes, error handling, and anything that touches undo/redo or generated code. It should cite `file:line` for each path, say why it matters, and skip trivial edits like renames, formatting, and test boilerplate. Relay the walkthrough to the user in your final message.

### Domain docs

Single-context: `CONTEXT.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.
