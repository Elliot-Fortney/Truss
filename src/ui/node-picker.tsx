import type { PropNodesView } from '../core/panel.ts';

/** What the panel can do to the Nodes a prop points at: the same edits a drag on the canvas makes. */
export interface PickNodes {
  connect: (prop: string, to: string, replace: boolean) => Promise<boolean>;
  disconnect: (prop: string, to: string) => Promise<boolean>;
}

/**
 * The Nodes a prop points at, edited the way a drag on the canvas edits them (ADR 0006). A prop that takes one Node
 * is a list to choose from, with "none" to take it out; one that takes several lists them in order, each with a way
 * to remove it, and adds the Node picked last.
 */
export function NodePicker({ name, nodes, pick }: { name: string; nodes: PropNodesView; pick: PickNodes }) {
  const current = nodes.current;
  if (!nodes.many) {
    const now = current[0];
    // A Reference the panel can't change is shown, not offered.
    if (now?.readOnly) {
      return (
        <code className="prop-value source" title={now.readOnly}>
          {now.label}
        </code>
      );
    }
    return (
      <select
        className="prop-input node-picker"
        aria-label={name}
        value={now?.id ?? ''}
        onChange={(e) => {
          const to = e.currentTarget.value;
          if (to === '') {
            if (now) void pick.disconnect(name, now.id);
          } else void pick.connect(name, to, now !== undefined);
        }}
      >
        <option value="">none</option>
        {now ? <option value={now.id}>{now.label}</option> : null}
        {nodes.choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
    );
  }
  return (
    <div className="node-picker">
      {current.length > 0 ? (
        <ol className="picked-nodes">
          {current.map((c, i) => (
            <li key={`${c.id}:${i}`}>
              <span>{c.label}</span>
              {c.readOnly ? (
                <span className="lock-reason" title={c.readOnly}>
                  read-only
                </span>
              ) : (
                <button
                  type="button"
                  className="picked-remove"
                  aria-label={`Remove ${c.label} from ${name}`}
                  onClick={() => void pick.disconnect(name, c.id)}
                >
                  ✕
                </button>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <div className="prop-value unset">none</div>
      )}
      {nodes.choices.length > 0 ? (
        <select
          className="prop-input"
          aria-label={`Add to ${name}`}
          value=""
          onChange={(e) => {
            if (e.currentTarget.value !== '') void pick.connect(name, e.currentTarget.value, false);
          }}
        >
          <option value="">Add a Node…</option>
          {nodes.choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}
