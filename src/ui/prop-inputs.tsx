import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { CatalogProp, PropInput } from '../core/catalog.ts';
import { DURATION_UNITS, SIZE_UNITS, type PropValue } from '../core/intents.ts';
import { editableAs, type WrittenValue } from '../core/panel.ts';
import { literalText } from './panel-format.ts';

/** How long typing pauses before a text field stages what it holds (it also stages when it loses focus). */
export const STAGE_AFTER_PAUSE_MS = 700;

/** What staging an edit answers: whether the Draft took it. A field that is not sure it was taken goes back to what the code says. */
type Staged = Promise<boolean>;

/**
 * A field that keeps what is being typed in itself, and stages it when typing pauses or the field is left
 * (ADR 0006). `commit` returns undefined for text that isn't a value yet (an empty number), which goes back
 * to what the code says when the field is left.
 */
function useTypedText(shown: string, commit: (text: string) => Staged | undefined) {
  const [text, setText] = useState(shown);
  const field = useRef<HTMLInputElement>(null);
  const pending = useRef<ReturnType<typeof setTimeout>>(undefined);
  const latest = useRef({ text, shown, commit });
  latest.current = { text, shown, commit };

  // The code is the truth: follow it, unless the user is in the middle of typing.
  useEffect(() => {
    if (document.activeElement !== field.current) setText(shown);
  }, [shown]);
  useEffect(
    () => () => {
      clearTimeout(pending.current);
    },
    [],
  );

  const flush = (): boolean => {
    clearTimeout(pending.current);
    const { text: typed, shown: was, commit: send } = latest.current;
    if (typed === was) return true;
    const staged = send(typed);
    // Refused: the code has not changed, so neither does what is shown.
    void staged?.then((taken) => taken || setText(latest.current.shown));
    return staged !== undefined;
  };
  return {
    ref: field,
    value: text,
    onChange: (next: string) => {
      setText(next);
      latest.current.text = next;
      clearTimeout(pending.current);
      pending.current = setTimeout(flush, STAGE_AFTER_PAUSE_MS);
    },
    onBlur: () => {
      // A value that was not staged (an empty or invalid number) goes back to what the code has.
      if (!flush()) setText(latest.current.shown);
    },
  };
}

function TextInput({
  label,
  shown,
  numeric,
  onValue,
}: {
  label: string;
  shown: string;
  numeric: boolean;
  onValue: (v: PropValue) => Staged;
}) {
  const typed = useTypedText(shown, (text) => {
    if (!numeric) return onValue({ kind: 'string', value: text });
    const n = Number(text);
    return text.trim() !== '' && Number.isFinite(n) ? onValue({ kind: 'number', value: n }) : undefined;
  });
  return (
    <input
      ref={typed.ref}
      className="prop-input"
      type={numeric ? 'number' : 'text'}
      aria-label={label}
      value={typed.value}
      onChange={(e) => {
        typed.onChange(e.target.value);
      }}
      onBlur={typed.onBlur}
    />
  );
}

function Quantity({
  label,
  kind,
  written,
  onValue,
}: {
  label: string;
  kind: 'duration' | 'size';
  written: WrittenValue | undefined;
  onValue: (v: PropValue) => Staged;
}) {
  const units: readonly string[] = kind === 'duration' ? DURATION_UNITS : SIZE_UNITS;
  const quantity = written?.kind === 'expression' ? written.quantity : undefined;
  const [unit, setUnit] = useState(quantity?.unit ?? units[1]!);
  useEffect(() => {
    if (quantity) setUnit(quantity.unit);
  }, [quantity?.unit]);
  const stage = (amount: number, next: string) => onValue({ kind, unit: next, amount } as PropValue);
  const typed = useTypedText(quantity ? String(quantity.amount) : '', (text) => {
    const n = Number(text);
    return text.trim() !== '' && Number.isFinite(n) && n >= 0 ? stage(n, unit) : undefined;
  });
  return (
    <span className="prop-quantity">
      <input
        ref={typed.ref}
        className="prop-input"
        type="number"
        min={0}
        aria-label={`${label} amount`}
        value={typed.value}
        onChange={(e) => {
          typed.onChange(e.target.value);
        }}
        onBlur={typed.onBlur}
      />
      <select
        className="prop-input"
        aria-label={`${label} unit`}
        value={unit}
        onChange={(e) => {
          const next = e.target.value;
          setUnit(next);
          const n = Number(typed.value);
          if (typed.value.trim() !== '' && Number.isFinite(n) && n >= 0)
            void stage(n, next).then((taken) => taken || setUnit(quantity?.unit ?? next));
        }}
      >
        {units.map((u) => (
          <option key={u} value={u}>
            {u}
          </option>
        ))}
      </select>
    </span>
  );
}

/**
 * A choice (a checkbox, a select) that shows what was picked at once, though the code only says so once
 * the Draft has been synthed, and goes back to what the code says if the Draft refuses it.
 */
function Choice<T extends string | boolean>({
  written,
  read,
  initial,
  onValue,
  render,
}: {
  written: WrittenValue | undefined;
  read: (w: WrittenValue) => T;
  initial: T;
  onValue: (v: PropValue) => Staged;
  render(value: T, change: (value: T, staged: PropValue) => void): ReactNode;
}) {
  const code = written ? read(written) : initial;
  const [picked, setPicked] = useState(code);
  useEffect(() => {
    setPicked(code);
  }, [code]);
  return (
    <>
      {render(
        picked,
        (value, staged) => (setPicked(value), void onValue(staged).then((taken) => taken || setPicked(code))),
      )}
    </>
  );
}

/** The input for one prop, or for one field inside an object-literal prop. `onSet` stages the value at `path`. */
export function PropEditor({
  name,
  input,
  written,
  path,
  onSet,
}: {
  name: string;
  input: PropInput;
  written: WrittenValue | undefined;
  path: readonly string[];
  onSet: (prop: string[], value: PropValue) => Staged;
}) {
  const label = path.join('.');
  const set = (value: PropValue): Staged => onSet([...path], value);
  switch (input.kind) {
    case 'string':
    case 'number':
      return (
        <TextInput
          label={label}
          numeric={input.kind === 'number'}
          shown={written?.kind === 'literal' ? String(written.value) : ''}
          onValue={set}
        />
      );
    case 'boolean':
      return (
        <Choice
          written={written}
          read={(w) => w.kind === 'literal' && w.value === true}
          initial={false}
          onValue={set}
          render={(checked, change) => (
            <label className="prop-check">
              <input
                type="checkbox"
                aria-label={label}
                checked={checked}
                onChange={(e) => {
                  change(e.target.checked, { kind: 'boolean', value: e.target.checked });
                }}
              />
              {written ? null : <span className="prop-unset-hint">not set</span>}
            </label>
          )}
        />
      );
    case 'enum':
      return (
        <Choice
          written={written}
          read={(w) => (w.kind === 'expression' ? (w.member?.name ?? '') : '')}
          initial=""
          onValue={set}
          render={(member, change) => (
            <select
              className="prop-input"
              aria-label={label}
              value={member}
              onChange={(e) =>
                e.target.value && change(e.target.value, { kind: 'enum', type: input.fqn, member: e.target.value })
              }
            >
              <option value="">{written ? '' : 'not set'}</option>
              {input.members.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          )}
        />
      );
    case 'duration':
    case 'size':
      return <Quantity label={label} kind={input.kind} written={written} onValue={set} />;
    case 'struct':
      return (
        <fieldset className="prop-struct">
          <legend>{name}</legend>
          {input.fields.map((field) => (
            <FieldRow key={field.name} field={field} parent={written} path={path} onSet={onSet} />
          ))}
        </fieldset>
      );
  }
}

function FieldRow({
  field,
  parent,
  path,
  onSet,
}: {
  field: CatalogProp;
  parent: WrittenValue | undefined;
  path: readonly string[];
  onSet: (prop: string[], value: PropValue) => Staged;
}) {
  const written = parent?.kind === 'object' ? parent.fields.find((f) => f.name === field.name)?.written : undefined;
  const mine = [...path, field.name];
  return (
    <div className="prop-field">
      <div className="prop-head">
        <code className="prop-name">{field.name}</code>
        {field.required ? <span className="prop-badge">required</span> : null}
        <span className="prop-type">{field.type}</span>
      </div>
      {field.input && editableAs(field.input, written) ? (
        <PropEditor name={field.name} input={field.input} written={written} path={mine} onSet={onSet} />
      ) : written?.kind === 'literal' ? (
        <div className="prop-value literal">{literalText(written.value)}</div>
      ) : written ? (
        <code className="prop-value source" title="Written in your code as an expression; Truss leaves it alone">
          {written.text}
        </code>
      ) : null}
    </div>
  );
}
