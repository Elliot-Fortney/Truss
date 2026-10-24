import { useState } from 'react';
import { MAX_ID_LENGTH } from '../core/construct-id.ts';
import type { PropValue } from '../core/intents.ts';
import type { PanelView, PropRowView } from '../core/panel.ts';
import { idFieldState, literalText, moreLabel, propsNotice, unsetText } from './panel-format.ts';
import { PropEditor } from './prop-inputs.tsx';
import { NodePicker, type PickNodes } from './node-picker.tsx';

/** What the panel has for a Node or Stack: still asking, the answer, or why there is none. */
export type PanelState = { status: 'loading' } | { status: 'ready'; panel: PanelView } | { status: 'refused'; reason: string };

function PropRow({ row, unset, onSet, pick }: { row: PropRowView; unset: string; onSet(prop: string[], value: PropValue): Promise<boolean>; pick?: PickNodes }) {
  return (
    <li className="prop-row">
      <div className="prop-head">
        <code className="prop-name">{row.name}</code>
        {row.required ? <span className="prop-badge">required</span> : null}
        {row.type ? <span className="prop-type">{row.type}</span> : null}
      </div>
      {row.input ? (
        <PropEditor name={row.name} input={row.input} written={row.written} path={[row.name]} onSet={onSet} />
      ) : row.nodes && pick ? (
        <NodePicker name={row.name} nodes={row.nodes} pick={pick} />
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

function PropList({ rows, unset, onSet, pick }: { rows: readonly PropRowView[]; unset: string; onSet(prop: string[], value: PropValue): Promise<boolean>; pick?: PickNodes }) {
  return (
    <ul className="prop-list">
      {rows.map((row) => (
        <PropRow key={row.name} row={row} unset={unset} onSet={onSet} {...(pick ? { pick } : {})} />
      ))}
    </ul>
  );
}

/** The Construct ID: checked as it is typed, and staged as a rename once it is valid and the field is left or Enter is pressed. */
function ConstructIdField({ panel, onRename }: { panel: PanelView; onRename(newId: string): Promise<boolean> }) {
  const [typed, setTyped] = useState(panel.literalId ?? '');
  const { problem, note, canStage } = idFieldState(typed, panel);
  const stage = () => {
    if (canStage) void onRename(typed);
  };
  return (
    <div className="id-field">
      <label>
        Construct ID
        <input
          className="prop-input"
          type="text"
          value={typed}
          maxLength={MAX_ID_LENGTH}
          spellCheck={false}
          aria-invalid={problem !== undefined}
          aria-describedby="id-field-message"
          onChange={(e) => setTyped(e.currentTarget.value)}
          onBlur={stage}
          onKeyDown={(e) => {
            if (e.key === 'Enter') stage();
          }}
        />
      </label>
      <p id="id-field-message" className={problem ? 'id-problem' : 'lock-reason'} role={problem ? 'alert' : undefined}>
        {problem ?? note}
      </p>
    </div>
  );
}

/** The props of a Node or Stack: required and featured first, the rest one click away. */
export function PropertyPanel({ state, onSet, onRename, pick }: { state: PanelState; onSet(prop: string[], value: PropValue): Promise<boolean>; onRename(newId: string): Promise<boolean>; pick?: PickNodes }) {
  const [showMore, setShowMore] = useState(false);
  if (state.status === 'loading') return null;
  if (state.status === 'refused') return <p className="lock-reason">{state.reason}</p>;
  const { panel } = state;
  // The panel says why when it can't be edited; the older notice only says why the props are not shown prop by prop.
  const notice = panel.readOnly ?? propsNotice(panel);
  return (
    <section className="props" aria-label="Properties">
      {panel.summary ? <p className="prop-doc">{panel.summary}</p> : null}
      {panel.idEdit ? <ConstructIdField panel={panel} onRename={onRename} /> : null}
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
      <PropList rows={panel.rows} unset={unsetText(panel)} onSet={onSet} {...(pick ? { pick } : {})} />
      {panel.more.length > 0 ? (
        <>
          <button type="button" className="prop-more" aria-expanded={showMore} onClick={() => setShowMore(!showMore)}>
            {moreLabel(panel.more.length, showMore)}
          </button>
          {showMore ? <PropList rows={panel.more} unset={unsetText(panel)} onSet={onSet} {...(pick ? { pick } : {})} /> : null}
        </>
      ) : null}
    </section>
  );
}
