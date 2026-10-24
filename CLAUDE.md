## Agent skills

### Issue tracker

GitHub Issues in `Elliot-Fortney/Truss`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Code review

When a review (e.g. `/code-review`, or the review step of `/implement`) covers a diff that touches `src/ui/` or any `.tsx` file, also run `/vercel-react-best-practices` on the UI changes. Skip it for diffs that don't touch the UI.

### Domain docs

Single-context: `CONTEXT.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.
