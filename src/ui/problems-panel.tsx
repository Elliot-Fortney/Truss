import { useState } from 'react';
import type { SourceLocation } from '../core/assembly.ts';
import type { Problem } from '../core/problems.ts';
import { listProblems, type ProblemFilter } from './problems-view.ts';

const MARK = { error: '✕', warning: '▲', info: 'ℹ' } as const;

/**
 * Every Problem Truss found, with a Draft / All filter, a jump to the Node it is on, Open in editor, and
 * the raw synth output when the app failed to synth.
 */
export function ProblemsPanel({
  problems,
  output,
  highlighted,
  onJump,
  locate,
  onOpen,
  onClose,
}: {
  problems: readonly Problem[];
  /** The raw output of the synth that failed, if one did. */
  output: string | undefined;
  /** The Problem a link from the Save button points at. */
  highlighted: string | undefined;
  /** Selects what the Problem is on; the panel doesn't know what is drawn. */
  onJump: (problem: Problem) => void;
  /** Where the code is for the Problem, or nothing. */
  locate: (problem: Problem) => SourceLocation | undefined;
  onOpen: (at: SourceLocation) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState<ProblemFilter>('all');
  const listed = listProblems(problems, filter);
  return (
    <section className="problems-panel" role="region" aria-label="Problems">
      <div className="problems-head">
        <strong>Problems</strong>
        <div role="group" aria-label="Filter">
          {(['draft', 'all'] as const).map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => {
                setFilter(f);
              }}
            >
              {f === 'draft' ? 'Draft' : 'All'}
            </button>
          ))}
        </div>
        <span className="draft-spacer" />
        <button type="button" onClick={onClose} aria-label="Close Problems">
          ×
        </button>
      </div>
      {listed.length === 0 ? (
        <p className="lock-reason">{filter === 'draft' ? 'The Draft introduces no Problems.' : 'No Problems.'}</p>
      ) : null}
      <ul className="problems-list">
        {listed.map((p) => (
          <li
            key={p.id}
            id={`problem-${p.id}`}
            className={`problem ${p.severity}${highlighted === p.id ? ' highlighted' : ''}`}
          >
            <span className="problem-mark" aria-label={p.severity}>
              {MARK[p.severity]}
            </span>
            <div className="problem-body">
              <div>{p.message}</div>
              <div className="problem-meta">
                {p.draft ? <span>Draft</span> : null}
                {p.trussBug ? <span>Bug in Truss</span> : null}
                {p.path ? (
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      onJump(p);
                    }}
                  >
                    {p.path}
                  </button>
                ) : null}
                {locate(p) ? (
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      onOpen(locate(p)!);
                    }}
                  >
                    Open in editor
                  </button>
                ) : null}
              </div>
            </div>
          </li>
        ))}
      </ul>
      {output ? (
        <details>
          <summary>Synth output</summary>
          <pre>{output}</pre>
        </details>
      ) : null}
    </section>
  );
}
