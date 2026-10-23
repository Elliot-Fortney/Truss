import { useState } from 'react';
import type { PropValue } from '../core/intents.ts';
import type { PanelView, PropRowView } from '../core/panel.ts';
import { literalText, moreLabel, propsNotice, unsetText } from './panel-format.ts';
import { PropEditor } from './prop-inputs.tsx';

/** What the panel has for a Node or Stack: still asking, the answer, or why there is none. */
export type PanelState = { status: 'loading' } | { status: 'ready'; panel: PanelView } | { status: 'refused'; reason: string };

function PropRow({ row, unset, onSet }: { row: PropRowView; unset: string; onSet(prop: string[], value: PropValue): Promise<boolean> }) {
  return (
    <li className="prop-row">
      <div className="prop-head">
        <code className="prop-name">{row.name}</code>
        {row.required ? <span className="prop-badge">required</span> : null}
        {row.type ? <span className="prop-type">{row.type}</span> : null}
      </div>
      {row.input ? (
        <PropEditor name={row.name} input={row.input} written={row.written} path={[row.name]} onSet={onSet} />
      ) : row.written?.kind === 'literal' ? (
        <div className="prop-value literal">{literalText(row.written.value)}</div>
      ) : row.written ? (
        // Source Truss won't touch: greyed, and shown exactly as the code has it.
        <code className="prop-value source" title="Written in your code as an expression; Truss leaves it alone">
          {row.written.text}
        </code>
      ) : (
        <div className="prop-value unset">{unset}</div>
      )}
      {row.summary ? <p className="prop-doc">{row.summary}</p> : null}
      {row.default ? <p className="prop-doc">Default: {row.default}</p> : null}
    </li>
  );
}

function PropList({ rows, unset, onSet }: { rows: readonly PropRowView[]; unset: string; onSet(prop: string[], value: PropValue): Promise<boolean> }) {
  return (
    <ul className="prop-list">
      {rows.map((row) => (
        <PropRow key={row.name} row={row} unset={unset} onSet={onSet} />
      ))}
    </ul>
  );
}

/** The props of a Node or Stack: required and featured first, the rest one click away. */
export function PropertyPanel({ state, onSet }: { state: PanelState; onSet(prop: string[], value: PropValue): Promise<boolean> }) {
  const [showMore, setShowMore] = useState(false);
  if (state.status === 'loading') return null;
  if (state.status === 'refused') return <p className="lock-reason">{state.reason}</p>;
  const { panel } = state;
  // The panel says why when it can't be edited; the older notice only says why the props are not shown prop by prop.
  const notice = panel.readOnly ?? propsNotice(panel);
  return (
    <section className="props" aria-label="Properties">
      {panel.summary ? <p className="prop-doc">{panel.summary}</p> : null}
      {panel.problems?.length ? (
        <ul className="panel-problems" aria-label="Problems">
          {panel.problems.map((p) => (
            <li key={`${p.severity}:${p.message}`} className={p.severity}>
              {p.message}
            </li>
          ))}
        </ul>
      ) : null}
      {notice ? <p className="lock-reason">{notice}</p> : null}
      {panel.rows.length === 0 && panel.more.length === 0 ? <p className="lock-reason">No props are passed in your code.</p> : null}
      <PropList rows={panel.rows} unset={unsetText(panel)} onSet={onSet} />
      {panel.more.length > 0 ? (
        <>
          <button type="button" className="prop-more" aria-expanded={showMore} onClick={() => setShowMore(!showMore)}>
            {moreLabel(panel.more.length, showMore)}
          </button>
          {showMore ? <PropList rows={panel.more} unset={unsetText(panel)} onSet={onSet} /> : null}
        </>
      ) : null}
    </section>
  );
}
