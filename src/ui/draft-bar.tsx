import { useState } from 'react';
import { ISSUE_TRACKER_URL, type Problem } from '../core/problems.ts';
import type { DraftView } from '../core/view.ts';

/** One line of a unified diff, coloured by what it does. */
function DiffLine({ line }: { line: string }) {
  const kind = line.startsWith('+++') || line.startsWith('---') ? 'meta' : line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
  return <div className={`diff-line ${kind}`}>{line === '' ? ' ' : line}</div>;
}

/** Each check that stops Save, linked to the Problems panel. A bug in Truss says so and offers the report to file. */
function Blockers({ blockers, report, onShow }: { blockers: readonly Problem[]; report: string | undefined; onShow(id: string): void }) {
  const [copied, setCopied] = useState(false);
  if (blockers.length === 0) return null;
  return (
    <ul className="draft-problems" role="alert" aria-label="Save is blocked">
      {blockers.map((p) => (
        <li key={p.id}>
          {p.message}{' '}
          <button type="button" className="link" onClick={() => onShow(p.id)}>
            Show in Problems
          </button>
          {p.trussBug ? (
            <div className="truss-bug">
              This is a bug in Truss, not in your code.{' '}
              {report ? (
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(report).then(() => setCopied(true), () => setCopied(false));
                  }}
                >
                  {copied ? 'Copied' : 'Copy report'}
                </button>
              ) : null}{' '}
              <a href={ISSUE_TRACKER_URL} target="_blank" rel="noreferrer">
                Report it
              </a>
              . The report holds only the edits and the lines they change.
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** The exact per-file diff Save will write (ADR 0006). */
function Review({ draft }: { draft: DraftView }) {
  return (
    <section className="review" aria-label="Review changes">
      {draft.diffs.length === 0 ? <p className="lock-reason">The Draft changes no code.</p> : null}
      {draft.diffs.map((d) => (
        <pre key={d.file} className="diff" aria-label={`Changes to ${d.file}`}>
          {d.diff
            .split('\n')
            .slice(0, -1)
            .map((line, i) => (
              <DiffLine key={i} line={line} />
            ))}
        </pre>
      ))}
    </section>
  );
}

/**
 * The Draft's controls: its edits, undo and redo, the review of what Save will write, and Save and Discard.
 * Nothing here reaches the user's files except Save.
 */
export function DraftBar({
  draft,
  busy,
  blockers,
  held,
  onUndo,
  onRedo,
  onSave,
  onDiscard,
  onShowProblem,
}: {
  draft: DraftView;
  /** Truss is synthing the Draft or saving it. */
  busy: boolean;
  /** The Problems that stop Save, if any. */
  blockers: readonly Problem[];
  /** The app doesn't synth, so the Draft is kept as it was and only Discard can change it. */
  held: boolean;
  onUndo(): void;
  onRedo(): void;
  onSave(): void;
  onDiscard(): void;
  onShowProblem(id: string): void;
}) {
  const canSave = blockers.length === 0 && !held;
  const [reviewing, setReviewing] = useState(false);
  const count = draft.items.length;
  return (
    <div className="draft-bar" role="region" aria-label="Draft">
      <div className="draft-controls">
        <strong>{count === 0 ? 'Draft is empty' : `Draft · ${count} ${count === 1 ? 'edit' : 'edits'}`}</strong>
        <button type="button" onClick={onUndo} disabled={!draft.canUndo || held} title="Undo (Ctrl+Z)">
          Undo
        </button>
        <button type="button" onClick={onRedo} disabled={!draft.canRedo || held} title="Redo (Ctrl+Shift+Z)">
          Redo
        </button>
        <button type="button" onClick={() => setReviewing(!reviewing)} aria-expanded={reviewing && count > 0} disabled={count === 0}>
          {reviewing && count > 0 ? 'Hide changes' : 'Review changes'}
        </button>
        <span className="draft-spacer" />
        <button type="button" onClick={onDiscard} disabled={count === 0 && !draft.canRedo}>
          Discard
        </button>
        <button type="button" className="primary" onClick={onSave} disabled={count === 0 || busy || !canSave} title={canSave ? 'Write the Draft to your files' : 'Fix the Problems first'}>
          Save
        </button>
      </div>
      {draft.notices.length > 0 ? (
        <ul className="draft-notices" role="status">
          {draft.notices.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      {count > 0 ? (
        <ul className="draft-items">
          {draft.items.map((item, i) => (
            <li key={`${item.id}:${i}`}>
              <strong>{item.label}</strong> <code>{item.summary}</code>
              {item.suspect ? <span className="suspect" title="Staged since the app last synthed with the Draft"> suspect</span> : null}
              {item.error ? <div className="suspect-error">{item.error}</div> : null}
              {item.undoable ? (
                <button type="button" onClick={onUndo}>
                  Undo this edit
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <Blockers blockers={blockers} report={draft.report} onShow={onShowProblem} />
      {reviewing && count > 0 ? <Review draft={draft} /> : null}
    </div>
  );
}
