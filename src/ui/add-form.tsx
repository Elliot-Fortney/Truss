import { useState } from 'react';
import type { CatalogProp } from '../core/catalog.ts';
import type { PropValue } from '../core/intents.ts';
import { writtenOf } from './add.ts';
import { PropEditor } from './prop-inputs.tsx';

/** Asks for the props a construct needs and has no default for, before anything is staged. */
export function AddForm({
  name,
  props,
  onAdd,
  onCancel,
}: {
  name: string;
  props: readonly CatalogProp[];
  onAdd(values: Record<string, PropValue>): void;
  onCancel(): void;
}) {
  const [values, setValues] = useState<Record<string, PropValue>>({});
  const complete = props.every((p) => values[p.name] !== undefined);
  return (
    <aside className="note-panel add-form" aria-label={`Add ${name}`}>
      <h2>Add {name}</h2>
      <p className="lock-reason">
        {name} needs {props.length === 1 ? 'a value' : 'values'} before it can be added.
      </p>
      {props.map((p) => (
        <div key={p.name} className="prop-field">
          <div className="prop-head">
            <code className="prop-name">{p.name}</code>
            <span className="prop-type">{p.type}</span>
          </div>
          {p.summary ? <div className="prop-summary">{p.summary}</div> : null}
          {p.input ? (
            <PropEditor
              name={p.name}
              input={p.input}
              written={values[p.name] ? writtenOf(values[p.name]!) : undefined}
              path={[p.name]}
              onSet={(_prop, value) => {
                setValues((current) => ({ ...current, [p.name]: value }));
                return Promise.resolve(true);
              }}
            />
          ) : null}
        </div>
      ))}
      <div className="add-form-actions">
        <button type="button" disabled={!complete} onClick={() => onAdd(values)}>
          Add
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </aside>
  );
}
