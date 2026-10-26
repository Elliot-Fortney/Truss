import {
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useStore,
  type Edge,
  type Node,
  type NodeProps,
  type OnNodesChange,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SourceLocation } from '../core/assembly.ts';
import { withId } from '../core/construct-id.ts';
import type { PropValue } from '../core/intents.ts';
import type { SourceUse } from '../core/ports.ts';
import { badgesFor, isBadged, type Badge, type Problem } from '../core/problems.ts';
import { MAX_NOTE_LENGTH, type ClientRequest } from '../core/protocol.ts';
import type { EdgeView, LayerChildView, NodeView, StackBoxView, View, ViewError } from '../core/view.ts';
import type { CatalogProp, SearchHit } from '../core/catalog.ts';
import { addScopeOf, stackPathOf } from './add.ts';
import { AddForm } from './add-form.tsx';
import { canRepoint, dimmed, dropOn, edgeLabel, edgeTitle, type Targets } from './connect.ts';
import type { ConnectOption } from '../core/connect.ts';
import type { HintOption } from '../core/connection.ts';
import type { PickNodes } from './node-picker.tsx';
import { DraftBar } from './draft-bar.tsx';
import { layoutView } from './layout.ts';
import { NodeIcon } from './node-icon.tsx';
import { CONSTRUCT_DRAG, Palette } from './palette.tsx';
import { ProblemsPanel } from './problems-panel.tsx';
import { jumpTarget } from './problems-view.ts';
import { PropertyPanel, type PanelState } from './property-panel.tsx';
import { chooseStage, rememberStage, rememberedStage, showStage } from './stage.ts';
import { usePanel } from './use-panel.ts';
import { useView } from './use-view.ts';
import { namesShownAt } from './zoom.ts';

interface StackData extends Record<string, unknown> {
  label: string;
  env: string;
  changed?: boolean;
  badge?: Badge;
}
interface TrussNodeData extends Record<string, unknown> {
  label: string;
  subtitle: string;
  fqn: string;
  icon: string;
  note?: string;
  lock?: string;
  /** The Draft changes this Node's code. */
  changed?: boolean;
  /** The Draft adds this Node. */
  added?: boolean;
  /** The Draft deletes this Node: it is drawn as it is on disk, as a ghost. */
  removed?: boolean;
  /** Problems on this Node, or beneath it where the Layer is closed. */
  badge?: Badge;
  external?: boolean;
  hoisted?: boolean;
  /** A drag from this Node's handle makes a Reference. */
  connectable?: boolean;
  /** The Node has a Layer to open. */
  expandable?: boolean;
  expanded?: boolean;
  onToggle?(id: string): void;
}
interface LayerNodeData extends Record<string, unknown> {
  label: string;
  /** The CloudFormation type of an L1, else the construct class. */
  subtitle: string;
  /** Shown on hover: the construct path and what it is. */
  tooltip: string;
  icon: string;
  expandable: boolean;
  expanded: boolean;
  badge?: Badge;
  onToggle(id: string): void;
}

/** What a badge says: errors win the colour, warnings the Draft introduced follow. */
function ProblemBadge({ badge }: { badge: Badge | undefined }) {
  if (!badge || (badge.errors === 0 && badge.warnings === 0)) return null;
  const error = badge.errors > 0;
  const title = [
    badge.errors > 0 ? `${badge.errors} ${badge.errors === 1 ? 'error' : 'errors'}` : '',
    badge.warnings > 0 ? `${badge.warnings} ${badge.warnings === 1 ? 'warning' : 'warnings'}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <span className={`problem-badge ${error ? 'error' : 'warning'}`} title={title} role="img" aria-label={title}>
      {badge.errors > 0 ? `✕ ${badge.errors}` : ''}
      {error && badge.warnings > 0 ? ' · ' : ''}
      {badge.warnings > 0 ? `▲ ${badge.warnings}` : ''}
    </span>
  );
}

function StackBox({ data }: NodeProps<Node<StackData>>) {
  return (
    <div className="stack-box">
      <div className="stack-header">
        <strong>{data.label}</strong>
        <span>{data.env}</span>
        {data.changed ? <span className="changed-badge">changed</span> : null}
        <ProblemBadge badge={data.badge} />
      </div>
    </div>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <rect x="5" y="11" width="14" height="9" rx="2" fill="currentColor" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

/** Icon sizes in px: larger when the Node is only its icon. */
const ICON_SIZE = 36;
const ICON_ONLY_SIZE = 44;
const LAYER_ICON_SIZE = 24;

function ExpandToggle({
  id,
  label,
  expanded,
  onToggle,
}: {
  id: string;
  label: string;
  expanded: boolean;
  onToggle(id: string): void;
}) {
  return (
    <button
      type="button"
      // React Flow would otherwise start a drag or a pan from the click.
      className="expand-toggle nodrag nopan"
      aria-expanded={expanded}
      aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label}`}
      title={expanded ? 'Collapse' : 'Show what this creates'}
      onClick={(e) => {
        e.stopPropagation();
        onToggle(id);
      }}
    >
      {expanded ? '▾' : '▸'}
    </button>
  );
}

function TrussNode({ id, data }: NodeProps<Node<TrussNodeData>>) {
  // Zoomed out, a name is too small to read, so the Node is its icon; the full name stays in the tooltip.
  const showName = useStore((s) => namesShownAt(s.transform[2]));
  const className = [
    'truss-node',
    data.changed ? 'changed' : '',
    data.removed ? 'removed' : '',
    data.external ? 'external' : '',
    data.hoisted ? 'hoisted' : '',
    data.expanded ? 'expanded' : '',
    showName ? '' : 'icon-only',
  ]
    .filter(Boolean)
    .join(' ');
  const tooltip = data.external
    ? `${data.label} · ${data.fqn} · refers to an existing resource`
    : `${data.label} · ${data.fqn}`;
  return (
    <div className={className} title={tooltip}>
      {/* Lines end here. A drag starts only from the right-hand handle of a Node whose props Truss can edit, and ends where it is dropped, not on a handle. */}
      <Handle
        type="target"
        position={Position.Left}
        isConnectableStart={false}
        isConnectableEnd={false}
        className="truss-handle"
      />
      <Handle
        type="source"
        position={Position.Right}
        isConnectableStart={data.connectable === true}
        isConnectableEnd={false}
        className={data.connectable ? 'truss-handle drag-handle' : 'truss-handle'}
        title={data.connectable ? 'Drag to connect' : undefined}
      />
      <div className="node-head">
        <NodeIcon icon={data.icon} size={showName ? ICON_SIZE : ICON_ONLY_SIZE} />
        {/* Always in the page, so screen readers have the name; zoomed out it is clipped away rather than removed. */}
        <div className="node-text">
          <div className="node-label">{data.label}</div>
          <div className="node-subtitle">{data.subtitle}</div>
        </div>
        {data.expandable && data.onToggle ? (
          <ExpandToggle id={id} label={data.label} expanded={data.expanded === true} onToggle={data.onToggle} />
        ) : null}
      </div>
      {data.lock ? (
        <span className="node-lock" title={data.lock} aria-label={`Read-only: ${data.lock}`} role="img">
          <LockIcon />
        </span>
      ) : null}
      {data.note ? (
        <span className="node-note" title={data.note}>
          note
        </span>
      ) : null}
      {data.changed ? (
        <span className="changed-badge" title="The Draft changes this">
          changed
        </span>
      ) : null}
      {data.removed ? (
        <span className="changed-badge removed" title="The Draft deletes this">
          removed
        </span>
      ) : null}
      {data.added ? (
        <span className="changed-badge added" title="The Draft adds this">
          added
        </span>
      ) : null}
      <ProblemBadge badge={data.badge} />
    </div>
  );
}

/** A construct in an expanded Node's Layer. It is only what synth produced, so it has no lock, note or handles. */
function LayerNode({ id, data }: NodeProps<Node<LayerNodeData>>) {
  return (
    <div className={data.expanded ? 'layer-node expanded' : 'layer-node'} title={data.tooltip}>
      <div className="node-head">
        <NodeIcon icon={data.icon} size={LAYER_ICON_SIZE} />
        <div className="node-text">
          <div className="node-label">{data.label}</div>
          <div className="node-subtitle">{data.subtitle}</div>
        </div>
        {data.expandable ? (
          <ExpandToggle id={id} label={data.label} expanded={data.expanded} onToggle={data.onToggle} />
        ) : null}
      </div>
      <ProblemBadge badge={data.badge} />
    </div>
  );
}

/** A Stack box's id on the canvas, which can't clash with the construct path of a Node. */
const stackNodeId = (path: string) => `stack:${path}`;

const nodeTypes = { stack: StackBox, truss: TrussNode, layer: LayerNode };

/** The class a construct was made from, without its package: `aws-cdk-lib.aws_s3.CfnBucket` is `CfnBucket`. */
const shortClass = (fqn: string) => fqn.split('.').at(-1) ?? fqn;

type Layout = ReturnType<typeof layoutView>;

/** The construct paths that are drawn: Stack boxes, Nodes, and the children of the Nodes that are open. */
function drawnIds(layout: Layout): Set<string> {
  return new Set([
    ...layout.stacks.map((s) => s.id),
    ...layout.nodes.map((n) => n.id),
    ...layout.layers.map((l) => l.id),
  ]);
}

function toFlowNodes(
  view: View,
  layout: Layout,
  expanded: ReadonlySet<string>,
  onToggle: (id: string) => void,
  editable: boolean,
): Node[] {
  const badges = badgesFor(view.problems, drawnIds(layout));
  const stacksById = new Map(view.stacks.map((s) => [s.id, s]));
  const boxesById = new Map(layout.stacks.map((b) => [b.id, b]));
  const nodesById = new Map(view.nodes.map((n) => [n.id, n]));
  const childrenById = new Map(view.nodes.flatMap((n) => n.children ?? []).map((c) => [c.id, c]));
  const hasChildren = new Set(view.nodes.flatMap((n) => n.children ?? []).map((c) => c.parentId));
  const stackNodes: Node[] = layout.stacks.map((box) => {
    const stack = stacksById.get(box.id)!;
    // React Flow places a child relative to its parent, and a nested box is laid out in canvas coordinates.
    const parent = boxesById.get(box.parentId ?? '');
    return {
      id: stackNodeId(box.id),
      type: 'stack',
      ...(parent ? { parentId: stackNodeId(parent.id) } : {}),
      position: { x: box.x - (parent?.x ?? 0), y: box.y - (parent?.y ?? 0) },
      style: { width: box.width, height: box.height },
      data: {
        label: stack.label,
        env: stack.env,
        ...(stack.changed ? { changed: true } : {}),
        ...(badges.has(stack.id) ? { badge: badges.get(stack.id)! } : {}),
      } satisfies StackData,
      // Selecting a Stack opens its panel; it can't be dragged.
      draggable: false,
    };
  });
  const nodes: Node[] = layout.nodes.map((pos) => {
    const n = nodesById.get(pos.id)!;
    const expandable = (n.children?.length ?? 0) > 0;
    return {
      id: n.id,
      type: 'truss',
      parentId: stackNodeId(n.stackId),
      position: { x: pos.x, y: pos.y },
      style: { width: pos.width, height: pos.height },
      // A hoisted Node is the library's, not the app's: its position is the Sidecar's to keep, but nothing else about it is editable.
      data: {
        label: n.label,
        subtitle: n.subtitle,
        fqn: n.fqn,
        icon: n.icon,
        ...(n.note ? { note: n.note } : {}),
        ...(n.lock ? { lock: n.lock } : {}),
        ...(n.changed ? { changed: true } : {}),
        ...(n.added ? { added: true } : {}),
        ...(n.removed ? { removed: true } : {}),
        ...(badges.has(n.id) ? { badge: badges.get(n.id)! } : {}),
        ...(n.external ? { external: true } : {}),
        ...(n.hoisted ? { hoisted: true } : {}),
        ...(editable && !n.lock && !n.hoisted && !n.removed && !n.added ? { connectable: true } : {}),
        expandable,
        expanded: expandable && expanded.has(n.id),
        onToggle,
      },
      ...(n.removed ? { draggable: false } : {}),
    };
  });
  // The children of an expanded Node sit inside its box, and are read-only: they can be selected but not moved.
  const layers: Node[] = layout.layers.map((pos) => {
    const c = childrenById.get(pos.id)!;
    return {
      id: c.id,
      type: 'layer',
      parentId: pos.parentId,
      position: { x: pos.x, y: pos.y },
      style: { width: pos.width, height: pos.height },
      draggable: false,
      data: {
        label: c.label,
        subtitle: c.cfnType ?? shortClass(c.fqn),
        tooltip: `${c.id} · ${c.cfnType ?? c.fqn}`,
        icon: c.icon,
        expandable: hasChildren.has(c.id),
        expanded: hasChildren.has(c.id) && expanded.has(c.id),
        ...(badges.has(c.id) ? { badge: badges.get(c.id)! } : {}),
        onToggle,
      } satisfies LayerNodeData,
    };
  });
  // React Flow needs a parent to come before its children.
  return [...stackNodes, ...nodes, ...layers];
}

/** A dashed line from each Node to the hoisted Nodes it caused, and an arrow for each Reference, for the Nodes on show. */
function toFlowEdges(view: View): Edge[] {
  const shown = new Set(view.nodes.map((n) => n.id));
  const names = new Map(view.nodes.map((n) => [n.id, n.label]));
  const causes = view.nodes.flatMap((n) =>
    (n.causedBy ?? [])
      .filter((cause) => shown.has(cause))
      .map((cause): Edge => ({
        id: `cause:${cause}>${n.id}`,
        source: cause,
        target: n.id,
        className: 'cause-edge',
        selectable: false,
        focusable: false,
      })),
  );
  const references = view.edges
    .filter((e) => shown.has(e.from) && shown.has(e.to))
    .map((e): Edge => ({
      id: e.id,
      source: e.from,
      target: e.to,
      label: edgeLabel(e),
      className: [`${e.kind}-edge`, 'reference-edge', e.readOnly ? 'read-only' : '', e.changed ? 'changed' : '']
        .filter(Boolean)
        .join(' '),
      // The arrow is at the end data or requests flow to, which for a prop the Overlay marks is the Node whose prop it is.
      ...(e.flow === 'in'
        ? { markerStart: { type: MarkerType.ArrowClosed } }
        : { markerEnd: { type: MarkerType.ArrowClosed } }),
      // Only the arrow's end moves: the Node whose prop it is stays the Node.
      reconnectable: e.readOnly || e.kind !== 'reference' ? false : 'target',
      ariaLabel: edgeTitle(e, names),
      data: { edge: e },
    }));
  return [...causes, ...references];
}

/** Where a React Flow node sits on the canvas: its own position plus those of the boxes it is nested in. */
function canvasPosition(node: Node, all: Node[]): { x: number; y: number } {
  const byId = new Map(all.map((n) => [n.id, n]));
  let { x, y } = node.position;
  for (let parent = byId.get(node.parentId ?? ''); parent; parent = byId.get(parent.parentId ?? '')) {
    x += parent.position.x;
    y += parent.position.y;
  }
  return { x, y };
}

/** The construct path of the innermost Stack box that holds the middle of a dragged Node, if any. */
function stackAt(node: Node, all: Node[]): string | undefined {
  const { x, y } = canvasPosition(node, all);
  const cx = x + (node.measured?.width ?? Number(node.style?.width ?? 0)) / 2;
  const cy = y + (node.measured?.height ?? Number(node.style?.height ?? 0)) / 2;
  const holding = all.filter((n) => {
    if (n.type !== 'stack') return false;
    const at = canvasPosition(n, all);
    const w = Number(n.style?.width ?? 0);
    const h = Number(n.style?.height ?? 0);
    return cx >= at.x && cx <= at.x + w && cy >= at.y && cy <= at.y + h;
  });
  // Nested boxes are smaller than the one they sit in.
  const inner = holding.sort((a, b) => Number(a.style?.width ?? 0) - Number(b.style?.width ?? 0))[0];
  return inner?.id.startsWith('stack:') ? inner.id.slice('stack:'.length) : undefined;
}

function StagePicker({
  stages,
  value,
  onChange,
}: {
  stages: View['stages'];
  value: string | undefined;
  onChange(id: string): void;
}) {
  return (
    <div className="stage-bar">
      <label>
        Stage
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {stages.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function NodePanel({
  node,
  nodes,
  props,
  paused,
  pick,
  onSave,
  onSet,
  onRename,
  onDuplicate,
  onRemove,
  onOpen,
}: {
  node: NodeView;
  nodes: readonly NodeView[];
  props: PanelState;
  paused: boolean;
  pick: PickNodes;
  onSave: (note: string) => void;
  onSet(prop: string[], value: PropValue): Promise<boolean>;
  onRename(newId: string): Promise<boolean>;
  onDuplicate(): void;
  onRemove(): void;
  onOpen(at: SourceLocation): void;
}) {
  if (node.removed) {
    return (
      <aside className="note-panel">
        <h2>{node.label}</h2>
        <p className="lock-reason">
          Deleted in the Draft: Save removes it from your code. Undo or Discard brings it back.
        </p>
      </aside>
    );
  }
  const causers = (node.causedBy ?? []).map((id) => nodes.find((n) => n.id === id)?.label ?? id);
  return (
    <aside className="note-panel">
      <h2>{node.label}</h2>
      {node.lock ? <p className="lock-reason">Read-only: {node.lock}</p> : null}
      {causers.length > 0 ? <p className="lock-reason">Caused by {causers.join(', ')}</p> : null}
      {node.source ? (
        <button type="button" className="open-in-editor" onClick={() => onOpen(node.source!)}>
          Open in editor
        </button>
      ) : null}
      {props.status === 'ready' && props.panel.kind === 'node' && props.panel.idEdit && !props.panel.readOnly ? (
        <button type="button" className="duplicate" onClick={onDuplicate}>
          Duplicate
        </button>
      ) : null}
      {props.status === 'ready' && props.panel.kind === 'node' && props.panel.idEdit && !props.panel.readOnly ? (
        <button type="button" className="remove" onClick={onRemove}>
          Remove
        </button>
      ) : null}
      {/* Keyed by Node so the disclosure of "more props" starts closed for each. */}
      <PropertyPanel key={node.id} state={props} onSet={onSet} onRename={onRename} pick={pick} />
      <label>
        Note
        {/* Keyed by Node so switching Nodes starts from that Node's note; saved when the field loses focus. */}
        <textarea
          key={node.id}
          defaultValue={node.note ?? ''}
          rows={6}
          maxLength={MAX_NOTE_LENGTH}
          readOnly={paused}
          onBlur={(e) => {
            if (e.currentTarget.value !== (node.note ?? '')) onSave(e.currentTarget.value);
          }}
        />
      </label>
    </aside>
  );
}

/** The panel of a Stack box: its own props, which are the only settings of it Truss shows. */
function StackPanel({
  stack,
  props,
  onSet,
  onRename,
  onOpen,
}: {
  stack: StackBoxView;
  props: PanelState;
  onSet(prop: string[], value: PropValue): Promise<boolean>;
  onRename(newId: string): Promise<boolean>;
  onOpen(at: SourceLocation): void;
}) {
  const source = props.status === 'ready' ? props.panel.source : undefined;
  return (
    <aside className="note-panel">
      <h2>{stack.label}</h2>
      <p className="lock-reason">Stack · {stack.env}</p>
      {source ? (
        <button type="button" className="open-in-editor" onClick={() => onOpen(source)}>
          Open in editor
        </button>
      ) : null}
      <PropertyPanel key={stack.id} state={props} onSet={onSet} onRename={onRename} />
    </aside>
  );
}

/** What a construct in a Layer is: its path and type. There is nothing to edit, because it is not in the app's code. */
function LayerPanel({ child, node }: { child: LayerChildView; node: NodeView }) {
  return (
    <aside className="note-panel">
      <h2>{child.label}</h2>
      <p className="lock-reason">Read-only: part of what {node.label} creates, not written in your code</p>
      <dl className="layer-facts">
        <dt>Construct path</dt>
        <dd>
          <code>{child.id}</code>
        </dd>
        {child.cfnType ? (
          <>
            <dt>CloudFormation type</dt>
            <dd>
              <code>{child.cfnType}</code>
            </dd>
          </>
        ) : null}
        <dt>Class</dt>
        <dd>
          <code>{child.fqn}</code>
        </dd>
      </dl>
    </aside>
  );
}

const KIND_NAME: Record<EdgeView['kind'], string> = {
  reference: 'Reference',
  grant: 'Grant',
  integration: 'Integration',
  network: 'Network Connection',
};

/** The panel of a Connection: what it is, where the code writes it, and a way to take it out. */
function EdgePanel({
  edge,
  names,
  paused,
  onRemove,
  onOpen,
  onChange,
  onRemoveCalls,
}: {
  edge: EdgeView;
  names: ReadonlyMap<string, string>;
  paused: boolean;
  onRemove(): void;
  onOpen(at: SourceLocation): void;
  onChange(change: { hint?: string; env?: string | null }): void;
  onRemoveCalls(ids: string[]): void;
}) {
  const at = edge.source;
  const props = edge.connection;
  const callIds = edge.calls?.map((c) => c.id) ?? [];
  const [env, setEnv] = useState(props?.env?.name ?? '');
  useEffect(() => setEnv(props?.env?.name ?? ''), [props?.env?.name]);
  return (
    <aside className="note-panel">
      <h2>
        {names.get(edge.from) ?? edge.from}.{edgeLabel(edge)} → {names.get(edge.to) ?? edge.to}
      </h2>
      {edge.fromSynth ? (
        <>
          <p className="lock-reason">
            {KIND_NAME[edge.kind]} · from the synthesized app
            {edge.effects ? (
              ''
            ) : (
              <>
                {' '}
                (<code>{edge.text}</code>)
              </>
            )}
          </p>
          <ul className="edge-effects">
            {edge.effects?.map((e, i) => (
              <li key={`${i}:${e.at}`} title={e.at}>
                {e.summary}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="lock-reason">
          {KIND_NAME[edge.kind]} · written <code>{edge.text}</code>
        </p>
      )}
      {edge.readOnly ? <p className="lock-reason">Read-only: {edge.readOnly}</p> : null}
      {props ? (
        <section className="connection-props" aria-label="Connection">
          {props.access ? (
            <label>
              Access
              <select
                className="prop-input"
                value={props.access.current}
                disabled={paused}
                onChange={(e) => onChange({ hint: e.currentTarget.value })}
              >
                {props.access.options.map((o) => (
                  <option key={o.hint} value={o.hint}>
                    {o.text}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {props.combine ? (
            <button type="button" disabled={paused} onClick={() => onChange({ hint: props.combine!.hint })}>
              Combine into: {props.combine.text}
            </button>
          ) : null}
          {props.env ? (
            <div className="hint-env">
              <label>
                <input
                  type="checkbox"
                  checked={props.env.on}
                  disabled={paused}
                  onChange={(e) => onChange({ env: e.currentTarget.checked ? env || props.env!.default : null })}
                />{' '}
                Environment variable
              </label>
              <input
                className="prop-input"
                aria-label="Environment variable name"
                value={env}
                disabled={paused || !props.env.on}
                onChange={(e) => setEnv(e.currentTarget.value)}
                onBlur={() => env !== props.env!.name && env !== '' && onChange({ env })}
              />
            </div>
          ) : null}
        </section>
      ) : null}
      {edge.calls?.length ? (
        <ul className="edge-calls" aria-label="Calls">
          {edge.calls.map((c) => (
            <li key={c.id} title={c.reason}>
              <code>{c.text}</code>
              {c.editable ? (
                <button
                  type="button"
                  className="picked-remove"
                  aria-label={`Remove ${c.text}`}
                  disabled={paused}
                  onClick={() => onRemoveCalls([c.id])}
                >
                  ✕
                </button>
              ) : (
                <span className="lock-reason"> read-only: {c.reason}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {at ? (
        <button type="button" className="open-in-editor" onClick={() => onOpen(at)}>
          Open in editor
        </button>
      ) : null}
      {!edge.readOnly ? (
        <button type="button" className="remove" disabled={paused} onClick={onRemove}>
          Remove
        </button>
      ) : null}
    </aside>
  );
}

/** Where a drop was refused, and why, at the place it was dropped. Snaps back: nothing was staged. */
function RefusalTip({ tip, onOpen, onClose }: { tip: Tip; onOpen(at: SourceLocation): void; onClose(): void }) {
  return (
    <div className="refusal-tip" role="alert" style={{ left: tip.x, top: tip.y }}>
      <span>{tip.reason}</span>
      {tip.at ? (
        <button type="button" className="open-in-editor" onClick={() => onOpen(tip.at!)}>
          Open in editor
        </button>
      ) : null}
      <button type="button" className="tip-close" aria-label="Dismiss" onClick={onClose}>
        ✕
      </button>
    </div>
  );
}

/** What a drop that asks something shows: which prop, or whether to replace. */
function ConnectMenu({
  choice,
  onPick,
  onHint,
  onClose,
}: {
  choice: Choice;
  onPick(prop: string, replace: boolean): void;
  onHint(hint: HintOption, env: string | null | undefined): void;
  onClose(): void;
}) {
  const hints = choice.kind === 'choose' ? choice.hints : [];
  const [picked, setPicked] = useState(0);
  const chosen = hints[picked];
  const [env, setEnv] = useState<string | undefined>();
  const [envOn, setEnvOn] = useState(true);
  return (
    <div className="connect-menu" role="dialog" aria-label="Connect" style={{ left: choice.x, top: choice.y }}>
      {choice.kind === 'replace' ? (
        <>
          <p>
            Replace {choice.current} with {choice.to} as <code>{choice.prop}</code>?
          </p>
          <button type="button" onClick={() => onPick(choice.prop, true)}>
            Replace
          </button>
        </>
      ) : (
        <>
          <p>
            Connect {choice.from} to {choice.to} as:
          </p>
          {choice.options.map((o) => (
            <button key={o.prop} type="button" onClick={() => onPick(o.prop, o.replaces !== undefined)}>
              <code>{o.prop}</code> <span className="muted">{o.type}</span>
              {o.replaces ? <span className="muted"> · replaces {o.replaces.label}</span> : null}
            </button>
          ))}
          {hints.length > 0 ? (
            <fieldset className="hint-choice">
              {hints.map((h, i) => (
                <label key={h.hint}>
                  <input type="radio" name="hint" checked={picked === i} onChange={() => setPicked(i)} /> {h.text}
                  {h.default ? <span className="muted"> · default</span> : null}
                  {h.replaces ? <span className="muted"> · replaces the grant it completes</span> : null}
                </label>
              ))}
              {chosen?.env ? (
                <div className="hint-env">
                  <label>
                    <input type="checkbox" checked={envOn} onChange={(e) => setEnvOn(e.currentTarget.checked)} /> Set
                    environment variable
                  </label>
                  <input
                    className="prop-input"
                    aria-label="Environment variable"
                    disabled={!envOn}
                    value={env ?? chosen.env}
                    onChange={(e) => setEnv(e.currentTarget.value)}
                  />
                </div>
              ) : null}
              <button
                type="button"
                onClick={() => chosen && onHint(chosen, chosen.env ? (envOn ? env : null) : undefined)}
              >
                Connect
              </button>
            </fieldset>
          ) : null}
        </>
      )}
      <button type="button" onClick={onClose}>
        Cancel
      </button>
    </div>
  );
}

function ErrorLocation({ error, onOpen }: { error: ViewError; onOpen(at: SourceLocation): void }) {
  if (!error.location) return null;
  const { file, line, col } = error.location;
  return (
    <p className="error-location">
      <code>
        {file}:{line}:{col}
      </code>{' '}
      <button type="button" onClick={() => onOpen(error.location!)}>
        Open in editor
      </button>
    </p>
  );
}

/** A refusal shown where the drop was. */
interface Tip {
  x: number;
  y: number;
  reason: string;
  at?: SourceLocation;
}

/** A drop that needs an answer before anything is staged. */
type Choice =
  | {
      kind: 'replace';
      x: number;
      y: number;
      from: string;
      to: string;
      fromId: string;
      toId: string;
      prop: string;
      current: string;
    }
  | {
      kind: 'choose';
      x: number;
      y: number;
      from: string;
      to: string;
      fromId: string;
      toId: string;
      options: readonly ConnectOption[];
      hints: readonly HintOption[];
    };

/** The Truss Node under a pointer at the end of a drag. */
function nodeUnder(event: MouseEvent | TouchEvent): { id: string | undefined; x: number; y: number } {
  const point = 'changedTouches' in event ? event.changedTouches[0] : event;
  if (!point) return { id: undefined, x: 0, y: 0 };
  const el = document
    .elementsFromPoint(point.clientX, point.clientY)
    .find((e) => e.classList.contains('react-flow__node-truss'));
  return { id: el?.getAttribute('data-id') ?? undefined, x: point.clientX, y: point.clientY };
}

export function App() {
  const { view, connection, send, search, panel, connectable, addNode, openInEditor } = useView();
  // The picked Stage is only a preference of this browser; with none picked, or a gone one, the first Stage shows.
  const [pickedStage, setPickedStage] = useState(rememberedStage);
  const stageId = view ? chooseStage(view.stages, pickedStage) : undefined;
  const shown = useMemo(() => (view ? showStage(view, stageId) : undefined), [view, stageId]);
  // Which Nodes are open is this connection's own view state: it is not in the Sidecar, and no other browser sees it.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback(
    (id: string) =>
      setExpanded((current) => {
        const next = new Set(current);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    [],
  );
  const layout = useMemo(() => (shown ? layoutView(shown, expanded) : undefined), [shown, expanded]);
  const editable = view !== undefined && view.error === undefined;
  const flowNodes = useMemo(
    () => (shown && layout ? toFlowNodes(shown, layout, expanded, toggle, editable) : []),
    [shown, layout, expanded, toggle, editable],
  );
  const flowEdges = useMemo(() => (shown ? toFlowEdges(shown) : []), [shown]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
  const [shownNotice, setShownNotice] = useState<{ text: string; uses?: SourceUse[]; at?: SourceLocation }>();
  const notice = shownNotice?.text;
  const setNotice = useCallback(
    (text?: string, uses?: readonly SourceUse[], at?: SourceLocation) =>
      setShownNotice(text ? { text, ...(uses?.length ? { uses: [...uses] } : {}), ...(at ? { at } : {}) } : undefined),
    [],
  );
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [linkedProblem, setLinkedProblem] = useState<string>();
  // Opening a Node must not move the viewport, so only the Nodes and boxes of the Design decide when to fit it again.
  const fitKey = flowNodes
    .filter((n) => n.type !== 'layer')
    .map((n) => n.id)
    .join('|');

  // The View is the truth; React Flow only holds a Node's position while it is being dragged. A new View
  // must not close the panel the user is editing in, so what is selected stays selected.
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const keepSelection = useCallback(
    (all: Node[]) => all.map((n) => (n.id === selectedRef.current ? { ...n, selected: true } : n)),
    [],
  );
  useEffect(() => setNodes(keepSelection(flowNodes)), [flowNodes, keepSelection]);
  const onNodesChange = useCallback<OnNodesChange>(
    (changes) => setNodes((current) => applyNodeChanges(changes, current)),
    [],
  );

  const request = useCallback(
    async (req: ClientRequest) => {
      const outcome = await send(req);
      setNotice(
        outcome.ok ? undefined : outcome.reason,
        outcome.ok ? undefined : outcome.uses,
        outcome.ok ? undefined : outcome.at,
      );
      // A refused change never reached the Sidecar, so put every Node back where the View has it.
      if (!outcome.ok) setNodes(keepSelection(flowNodes));
      return outcome.ok;
    },
    [send, flowNodes, keepSelection, setNotice],
  );

  const onNodeDragStop = useCallback(
    (_event: unknown, _node: Node, dragged: Node[]) => {
      // React Flow reports a Node relative to its Stack box; the Sidecar keeps canvas coordinates.
      // A multi-select drag moves every selected Node, so every one is saved.
      for (const node of dragged) {
        const { x, y } = canvasPosition(node, nodes);
        const into = stackAt(node, nodes);
        void request({ type: 'move', id: node.id, x, y, ...(into ? { into } : {}) });
      }
    },
    [nodes, request],
  );

  // A drag from a Node's handle makes a Reference: Truss says, when it starts, which Nodes would take it, and the others are dimmed.
  const [drag, setDrag] = useState<{ from: string; targets?: Targets }>();
  const [tip, setTip] = useState<Tip>();
  const [choice, setChoice] = useState<Choice>();
  const names = useMemo(() => new Map((shown?.nodes ?? []).map((n) => [n.id, n.label])), [shown]);
  /** Takes an edge out of the code: a Reference by its prop, a Connection by the calls that make it. */
  const removeEdge = useCallback(
    (edge: EdgeView) =>
      void request(
        edge.calls
          ? { type: 'removeConnection', calls: edge.calls.filter((c) => c.editable).map((c) => c.id) }
          : { type: 'disconnect', from: edge.from, to: edge.to, prop: edge.prop },
      ),
    [request],
  );
  const labelOf = useCallback((id: string) => names.get(id) ?? id, [names]);
  const startDrag = useCallback(
    (from: string | null) => {
      setTip(undefined);
      setChoice(undefined);
      if (from === null) return;
      setDrag({ from });
      void connectable(from).then((answer) =>
        setDrag((now) => (now?.from === from ? (answer.ok ? { from, targets: answer.targets } : { from }) : now)),
      );
    },
    [connectable],
  );
  /** Sends a connect, disconnect or re-point, and says where it was refused if it was. */
  const submit = useCallback(
    async (req: ClientRequest, at: { x: number; y: number }) => {
      setChoice(undefined);
      const outcome = await send(req);
      if (!outcome.ok) setTip({ x: at.x, y: at.y, reason: outcome.reason, ...(outcome.at ? { at: outcome.at } : {}) });
    },
    [send],
  );
  const endDrag = useCallback(
    (event: MouseEvent | TouchEvent, from: string | undefined) => {
      const now = drag;
      setDrag(undefined);
      const over = nodeUnder(event);
      // A click on the handle, or a drop on nothing, is not a drop: there is nothing to refuse.
      if (from === undefined || over.id === undefined || over.id === from) return;
      const outcome = dropOn(now?.targets, over.id);
      const at = { x: over.x, y: over.y };
      if (outcome.kind === 'refused') {
        const source = view?.nodes.find((n) => n.id === from)?.source;
        setTip({ ...at, reason: outcome.reason, ...(source ? { at: source } : {}) });
      } else if (outcome.kind === 'connect')
        void submit({ type: 'connect', from, to: over.id, prop: outcome.prop }, at);
      else if (outcome.kind === 'hint')
        void submit({ type: 'addConnection', a: from, b: over.id, hint: outcome.hint.hint }, at);
      else if (outcome.kind === 'replace')
        setChoice({
          kind: 'replace',
          ...at,
          from: labelOf(from),
          to: labelOf(over.id),
          fromId: from,
          toId: over.id,
          prop: outcome.prop,
          current: outcome.current,
        });
      else
        setChoice({
          kind: 'choose',
          ...at,
          from: labelOf(from),
          to: labelOf(over.id),
          fromId: from,
          toId: over.id,
          options: outcome.options,
          hints: outcome.hints,
        });
    },
    [drag, submit, labelOf, view],
  );
  const endReconnect = useCallback(
    (event: MouseEvent | TouchEvent, edge: Edge) => {
      const now = drag;
      setDrag(undefined);
      const over = nodeUnder(event);
      const e = (edge.data as { edge?: EdgeView } | undefined)?.edge;
      if (!e || over.id === undefined || over.id === e.to) return;
      const at = { x: over.x, y: over.y };
      if (!canRepoint(now?.targets, over.id, e.prop)) {
        const check = now?.targets?.[over.id];
        const source = view?.nodes.find((n) => n.id === e.from)?.source;
        setTip({
          ...at,
          reason: check && !check.ok ? check.reason : `${labelOf(e.from)}.${e.prop} doesn't take ${labelOf(over.id)}`,
          ...(source ? { at: source } : {}),
        });
        return;
      }
      void submit({ type: 'repoint', from: e.from, was: e.to, to: over.id, prop: e.prop }, at);
    },
    [drag, submit, labelOf, view],
  );
  // A tip stays until the next click anywhere else, or Escape.
  useEffect(() => {
    if (!tip && !choice) return;
    const away = (e: Event) => {
      if (e.target instanceof Element && e.target.closest('.refusal-tip, .connect-menu')) return;
      setTip(undefined);
      setChoice(undefined);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') away(e);
    };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', escape);
    };
  }, [tip, choice]);
  const dragged = useMemo(() => {
    if (!drag?.targets) return nodes;
    return nodes.map((n) =>
      n.type === 'truss' && dimmed(drag.targets, n.id, drag.from) ? { ...n, className: 'connect-dim' } : n,
    );
  }, [nodes, drag]);

  /** Selects what a Problem is on, bubbling to the nearest drawn construct as its badge does. */
  const jumpTo = useCallback(
    (problem: Problem) => {
      const target = layout && jumpTarget(problem, drawnIds(layout));
      if (target === undefined) return;
      const id = layout!.stacks.some((s) => s.id === target) ? stackNodeId(target) : target;
      setSelectedId(id);
      selectedRef.current = id;
      setNodes((current) => current.map((n) => ({ ...n, selected: n.id === id })));
    },
    [layout],
  );
  /** Where in the code a Problem is: its own place, else the code of the Node it is on. */
  const locate = useCallback(
    (problem: Problem): SourceLocation | undefined =>
      problem.location ?? view?.nodes.find((n) => n.id === problem.path)?.source,
    [view],
  );
  const showProblem = useCallback((id: string) => {
    setProblemsOpen(true);
    setLinkedProblem(id);
    requestAnimationFrame(() => document.getElementById(`problem-${id}`)?.scrollIntoView({ block: 'nearest' }));
  }, []);

  const selected = shown?.nodes.find((n) => n.id === selectedId);
  const openStack = shown?.stacks.find((s) => stackNodeId(s.id) === selectedId);
  const selectedEdge = selectedId === undefined ? shown?.edges.find((e) => e.id === selectedEdgeId) : undefined;
  const [saving, setSaving] = useState(false);
  const draft = view?.draft;
  const unsaved = (draft?.items.length ?? 0) > 0;
  const stage = useCallback(
    (id: string) => (prop: string[], value: PropValue) => request({ type: 'setProp', id, prop, value }),
    [request],
  );
  /** Renames the Node or Stack at `id`, and keeps it selected under the path the new ID gives it. */
  const rename = useCallback(
    (id: string, selection: (path: string) => string) => async (newId: string) => {
      const ok = await request({ type: 'renameId', id, newId });
      if (ok) {
        const next = selection(withId(id, newId));
        setSelectedId(next);
        selectedRef.current = next;
      }
      return ok;
    },
    [request],
  );
  /** The Node picker of the open panel edits the same Reference a drag does. */
  const pickFor = useCallback(
    (from: string): PickNodes => ({
      connect: (prop, to, replace) =>
        request({ type: 'connect', from, to, prop, ...(replace ? { replace: true } : {}) }),
      disconnect: (prop, to) => request({ type: 'disconnect', from, to, prop }),
    }),
    [request],
  );
  /** The construct being added that needs props from the user first, and the Stack it goes in. */
  const [asking, setAsking] = useState<{ fqn: string; name: string; scope: string; props: readonly CatalogProp[] }>();
  const add = useCallback(
    async (scope: string, fqn: string, name: string, props?: Record<string, PropValue>) => {
      const outcome = await addNode(scope, fqn, props);
      if ('form' in outcome) {
        setAsking({ fqn, name, scope, props: outcome.form });
        setNotice(undefined);
        return;
      }
      setAsking(undefined);
      setNotice(outcome.ok ? undefined : outcome.reason);
    },
    [addNode],
  );
  const onAdd = useCallback(
    (scope: string | undefined, hit: SearchHit) =>
      scope ? add(scope, hit.fqn, hit.displayName ?? hit.name) : undefined,
    [add],
  );
  const undo = useCallback(() => void request({ type: 'undo' }), [request]);
  const redo = useCallback(() => void request({ type: 'redo' }), [request]);
  const save = useCallback(async () => {
    setSaving(true);
    try {
      await request({ type: 'save' });
    } finally {
      setSaving(false);
    }
  }, [request]);
  const discard = useCallback(() => void request({ type: 'discard' }), [request]);

  // Closing the tab with edits in the Draft would lose them.
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);

  // Undo and redo step through the Draft, but not while the user is typing in a field, which has its own.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const target = e.target instanceof HTMLElement ? e.target : undefined;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) undo();
      else if ((key === 'z' && e.shiftKey) || key === 'y') redo();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);
  // Delete takes the selected Reference out, unless the user is typing.
  useEffect(() => {
    if (!selectedEdge || selectedEdge.readOnly || !editable) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const target = e.target instanceof HTMLElement ? e.target : undefined;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      e.preventDefault();
      removeEdge(selectedEdge);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedEdge, editable, removeEdge]);
  const addScope = shown ? addScopeOf(shown.stacks, openStack?.id, selected?.stackId) : undefined;
  const panelState = usePanel(selected?.id ?? openStack?.id, view?.version, panel);
  const selectedLayer = useMemo(() => {
    for (const node of shown?.nodes ?? []) {
      const child = node.children?.find((c) => c.id === selectedId);
      if (child) return { child, node };
    }
    return undefined;
  }, [shown, selectedId]);

  if (!view) {
    return <div className="page-message">{connection === 'closed' ? 'Disconnected from Truss.' : 'Connecting…'}</div>;
  }
  const { error } = view;
  // Nothing has ever synthed, so there is no Design to keep: the error is the whole page.
  if (error && !view.hasDesign) {
    return (
      <div className="page-error" role="alert">
        <h1>{error.kind === 'sidecar' ? 'Truss can’t use your truss.json' : 'Your app didn’t synth'}</h1>
        <p>{error.message}</p>
        <ErrorLocation error={error} onOpen={openInEditor} />
        {error.output ? <pre>{error.output}</pre> : null}
        {error.kind === 'sidecar' ? null : view.synthing ? (
          <p className="muted">synthing…</p>
        ) : (
          <p className="muted">Truss is watching your files and will load the Design as soon as the app synths.</p>
        )}
      </div>
    );
  }
  return (
    <div className="app">
      {view.stages.length > 0 ? (
        <StagePicker
          stages={view.stages}
          value={stageId}
          onChange={(id) => {
            setPickedStage(id);
            rememberStage(id);
          }}
        />
      ) : null}
      {/* With an error here the Design is the last good one: dimmed, and not editable until synth works again. */}
      <div
        className={error ? 'canvas dimmed' : 'canvas'}
        onDragOver={(e) => e.dataTransfer.types.includes(CONSTRUCT_DRAG) && e.preventDefault()}
        onDrop={(e) => {
          const fqn = e.dataTransfer.getData(CONSTRUCT_DRAG);
          if (!fqn) return;
          e.preventDefault();
          // Boxes are drawn beside each other, not inside each other, so the first one under the pointer is the innermost.
          const box = document
            .elementsFromPoint(e.clientX, e.clientY)
            .find((el) => el.classList.contains('react-flow__node-stack'));
          const scope = stackPathOf(box?.getAttribute('data-id') ?? undefined);
          if (scope) void add(scope, fqn, fqn.split('.').at(-1)!);
          else setNotice('Drop a construct on a Stack to add it there.');
        }}
      >
        {view.synthing ? <div className="synthing">synthing…</div> : null}
        <div className="banners">
          {connection === 'closed' ? <div className="banner">Disconnected from Truss.</div> : null}
          {view.draftBlocked ? (
            <div className="banner" role="status">
              <strong>Read-only.</strong> {view.draftBlocked}
            </div>
          ) : null}
          {error ? (
            <div className="banner error-banner" role="alert">
              <strong>
                {error.kind === 'draft'
                  ? 'The Draft makes your app fail to synth. Showing the last good Design; undo the last edit to fix it.'
                  : `Your app no longer synths. Showing the last good Design.${unsaved ? ' Your Draft is held as it was: Save is paused until the app synths again, and Discard still works.' : ''}`}
              </strong>
              <span>{error.message}</span>
              <ErrorLocation error={error} onOpen={openInEditor} />
              {error.output ? (
                <details>
                  <summary>Synth output</summary>
                  <pre>{error.output}</pre>
                </details>
              ) : null}
            </div>
          ) : null}
          {notice ? (
            <div className="banner notice" role="alert">
              {notice}
              {shownNotice?.at ? (
                <>
                  {' '}
                  <button type="button" className="open-in-editor" onClick={() => openInEditor(shownNotice.at!)}>
                    Open in editor
                  </button>
                </>
              ) : null}
              {shownNotice?.uses ? (
                <ul className="uses">
                  {shownNotice.uses.map((u) => (
                    <li key={`${u.file}:${u.line}:${u.col}`}>
                      <button type="button" className="open-in-editor" onClick={() => openInEditor(u)}>
                        {u.file}:{u.line}
                      </button>{' '}
                      <code>{u.text}</code>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
        <ReactFlow
          // fitView only runs on mount, so re-mount when the set of boxes changes (the first push has none).
          key={fitKey}
          nodes={dragged}
          onNodesChange={onNodesChange}
          onNodeDragStop={onNodeDragStop}
          onSelectionChange={({ nodes: picked, edges: pickedEdges }) => {
            setSelectedId(
              (picked.find((n) => n.type === 'truss' || n.type === 'layer') ?? picked.find((n) => n.type === 'stack'))
                ?.id,
            );
            setSelectedEdgeId(pickedEdges.find((e) => (e.data as { edge?: EdgeView } | undefined)?.edge)?.id);
          }}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          nodesConnectable={!error}
          nodesDraggable={!error}
          // The line is drawn by React Flow, but where it ends and what it means is Truss's to say: see endDrag.
          onConnectStart={(_event, params) => startDrag(params.nodeId)}
          onConnectEnd={(event, state) => endDrag(event, state.fromNode?.id)}
          onReconnect={() => undefined}
          onReconnectStart={(_event, edge) => startDrag(edge.source)}
          onReconnectEnd={(event, edge) => endReconnect(event, edge)}
          // Deleting a Node is a code edit, not a canvas gesture; without this Backspace would hide the selected Node.
          deleteKeyCode={null}
          fitView
          minZoom={0.1}
          proOptions={{ hideAttribution: false }}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
        <Palette search={search} scope={addScope} onAdd={(hit) => void onAdd(addScope, hit)} />
        {problemsOpen ? (
          <ProblemsPanel
            problems={view.problems}
            output={error?.output}
            highlighted={linkedProblem}
            onJump={jumpTo}
            locate={locate}
            onOpen={openInEditor}
            onClose={() => setProblemsOpen(false)}
          />
        ) : (
          <button type="button" className="problems-toggle" onClick={() => setProblemsOpen(true)}>
            Problems · {view.problems.filter(isBadged).length}
          </button>
        )}
        {draft ? (
          <DraftBar
            draft={draft}
            busy={view.synthing || saving}
            blockers={view.problems.filter((p) => p.blocking)}
            held={!!error && error.kind !== 'draft'}
            onUndo={undo}
            onRedo={redo}
            onSave={() => void save()}
            onDiscard={discard}
            onShowProblem={showProblem}
          />
        ) : null}
        {selected ? (
          <NodePanel
            node={selected}
            nodes={shown?.nodes ?? []}
            props={panelState}
            paused={error !== undefined}
            pick={pickFor(selected.id)}
            onSave={(note) => void request({ type: 'note', id: selected.id, note })}
            onSet={stage(selected.id)}
            onRename={rename(selected.id, (path) => path)}
            onDuplicate={() => void request({ type: 'duplicate', id: selected.id })}
            onRemove={() => void request({ type: 'removeNode', id: selected.id })}
            onOpen={openInEditor}
          />
        ) : null}
        {asking ? (
          <AddForm
            key={asking.fqn}
            name={asking.name}
            props={asking.props}
            onAdd={(values) => void add(asking.scope, asking.fqn, asking.name, values)}
            onCancel={() => setAsking(undefined)}
          />
        ) : null}
        {openStack ? (
          <StackPanel
            stack={openStack}
            props={panelState}
            onSet={stage(openStack.id)}
            onRename={rename(openStack.id, stackNodeId)}
            onOpen={openInEditor}
          />
        ) : null}
        {selectedLayer ? <LayerPanel child={selectedLayer.child} node={selectedLayer.node} /> : null}
        {selectedEdge ? (
          <EdgePanel
            edge={selectedEdge}
            names={names}
            paused={error !== undefined}
            onRemove={() => removeEdge(selectedEdge)}
            onOpen={openInEditor}
            onChange={(change) =>
              void request({ type: 'changeConnection', calls: selectedEdge.calls?.map((c) => c.id) ?? [], ...change })
            }
            onRemoveCalls={(calls) => void request({ type: 'removeConnection', calls })}
          />
        ) : null}
        {tip ? <RefusalTip tip={tip} onOpen={openInEditor} onClose={() => setTip(undefined)} /> : null}
        {choice ? (
          <ConnectMenu
            choice={choice}
            onHint={(hint, env) =>
              void submit(
                {
                  type: 'addConnection',
                  a: choice.fromId,
                  b: choice.toId,
                  hint: hint.hint,
                  ...(env !== undefined ? { env } : {}),
                },
                { x: choice.x, y: choice.y },
              )
            }
            onPick={(prop, replace) =>
              void submit(
                { type: 'connect', from: choice.fromId, to: choice.toId, prop, ...(replace ? { replace: true } : {}) },
                { x: choice.x, y: choice.y },
              )
            }
            onClose={() => setChoice(undefined)}
          />
        ) : null}
      </div>
    </div>
  );
}
