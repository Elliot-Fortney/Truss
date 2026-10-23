import { applyNodeChanges, Background, Controls, Handle, Position, ReactFlow, useStore, type Edge, type Node, type NodeProps, type OnNodesChange } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SourceLocation } from '../core/assembly.ts';
import type { PropValue } from '../core/intents.ts';
import { MAX_NOTE_LENGTH, type ClientRequest } from '../core/protocol.ts';
import type { LayerChildView, NodeView, StackBoxView, View, ViewError } from '../core/view.ts';
import { DraftBar } from './draft-bar.tsx';
import { layoutView } from './layout.ts';
import { NodeIcon } from './node-icon.tsx';
import { Palette } from './palette.tsx';
import { PropertyPanel, type PanelState } from './property-panel.tsx';
import { chooseStage, rememberStage, rememberedStage, showStage } from './stage.ts';
import { usePanel } from './use-panel.ts';
import { useView } from './use-view.ts';
import { namesShownAt } from './zoom.ts';

interface StackData extends Record<string, unknown> {
  label: string;
  env: string;
  changed?: boolean;
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
  external?: boolean;
  hoisted?: boolean;
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
  onToggle(id: string): void;
}

function StackBox({ data }: NodeProps<Node<StackData>>) {
  return (
    <div className="stack-box">
      <div className="stack-header">
        <strong>{data.label}</strong>
        <span>{data.env}</span>
        {data.changed ? <span className="changed-badge">changed</span> : null}
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

function ExpandToggle({ id, label, expanded, onToggle }: { id: string; label: string; expanded: boolean; onToggle(id: string): void }) {
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
  const className = ['truss-node', data.changed ? 'changed' : '', data.external ? 'external' : '', data.hoisted ? 'hoisted' : '', data.expanded ? 'expanded' : '', showName ? '' : 'icon-only'].filter(Boolean).join(' ');
  const tooltip = data.external ? `${data.label} · ${data.fqn} · refers to an existing resource` : `${data.label} · ${data.fqn}`;
  return (
    <div className={className} title={tooltip}>
      {/* Only a hoisted Node is ever the end of a line, and only to the Node that caused it. */}
      <Handle type="target" position={Position.Left} isConnectable={false} className="truss-handle" />
      <Handle type="source" position={Position.Right} isConnectable={false} className="truss-handle" />
      <div className="node-head">
        <NodeIcon icon={data.icon} size={showName ? ICON_SIZE : ICON_ONLY_SIZE} />
        {/* Always in the page, so screen readers have the name; zoomed out it is clipped away rather than removed. */}
        <div className="node-text">
          <div className="node-label">{data.label}</div>
          <div className="node-subtitle">{data.subtitle}</div>
        </div>
        {data.expandable && data.onToggle ? <ExpandToggle id={id} label={data.label} expanded={data.expanded === true} onToggle={data.onToggle} /> : null}
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
        {data.expandable ? <ExpandToggle id={id} label={data.label} expanded={data.expanded} onToggle={data.onToggle} /> : null}
      </div>
    </div>
  );
}

/** A Stack box's id on the canvas, which can't clash with the construct path of a Node. */
const stackNodeId = (path: string) => `stack:${path}`;

const nodeTypes = { stack: StackBox, truss: TrussNode, layer: LayerNode };

/** The class a construct was made from, without its package: `aws-cdk-lib.aws_s3.CfnBucket` is `CfnBucket`. */
const shortClass = (fqn: string) => fqn.split('.').at(-1) ?? fqn;

function toFlowNodes(view: View, expanded: ReadonlySet<string>, onToggle: (id: string) => void): Node[] {
  const layout = layoutView(view, expanded);
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
      data: { label: stack.label, env: stack.env, ...(stack.changed ? { changed: true } : {}) } satisfies StackData,
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
        ...(n.external ? { external: true } : {}),
        ...(n.hoisted ? { hoisted: true } : {}),
        expandable,
        expanded: expandable && expanded.has(n.id),
        onToggle,
      },
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
        onToggle,
      } satisfies LayerNodeData,
    };
  });
  // React Flow needs a parent to come before its children.
  return [...stackNodes, ...nodes, ...layers];
}

/** A dashed line from each Node to the hoisted Nodes it caused, for the Nodes on show. */
function toFlowEdges(view: View): Edge[] {
  const shown = new Set(view.nodes.map((n) => n.id));
  return view.nodes.flatMap((n) =>
    (n.causedBy ?? [])
      .filter((cause) => shown.has(cause))
      .map((cause) => ({ id: `cause:${cause}>${n.id}`, source: cause, target: n.id, className: 'cause-edge', selectable: false, focusable: false })),
  );
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

function StagePicker({ stages, value, onChange }: { stages: View['stages']; value: string | undefined; onChange(id: string): void }) {
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

function NodePanel({ node, nodes, props, paused, onSave, onSet, onOpen }: { node: NodeView; nodes: readonly NodeView[]; props: PanelState; paused: boolean; onSave: (note: string) => void; onSet(prop: string[], value: PropValue): Promise<boolean>; onOpen(at: SourceLocation): void }) {
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
      {/* Keyed by Node so the disclosure of "more props" starts closed for each. */}
      <PropertyPanel key={node.id} state={props} onSet={onSet} />
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
function StackPanel({ stack, props, onSet, onOpen }: { stack: StackBoxView; props: PanelState; onSet(prop: string[], value: PropValue): Promise<boolean>; onOpen(at: SourceLocation): void }) {
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
      <PropertyPanel key={stack.id} state={props} onSet={onSet} />
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

export function App() {
  const { view, connection, send, search, panel, openInEditor } = useView();
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
  const flowNodes = useMemo(() => (shown ? toFlowNodes(shown, expanded, toggle) : []), [shown, expanded, toggle]);
  const flowEdges = useMemo(() => (shown ? toFlowEdges(shown) : []), [shown]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  // Opening a Node must not move the viewport, so only the Nodes and boxes of the Design decide when to fit it again.
  const fitKey = flowNodes
    .filter((n) => n.type !== 'layer')
    .map((n) => n.id)
    .join('|');

  // The View is the truth; React Flow only holds a Node's position while it is being dragged. A new View
  // must not close the panel the user is editing in, so what is selected stays selected.
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const keepSelection = useCallback((all: Node[]) => all.map((n) => (n.id === selectedRef.current ? { ...n, selected: true } : n)), []);
  useEffect(() => setNodes(keepSelection(flowNodes)), [flowNodes, keepSelection]);
  const onNodesChange = useCallback<OnNodesChange>((changes) => setNodes((current) => applyNodeChanges(changes, current)), []);

  const request = useCallback(
    async (req: ClientRequest) => {
      const outcome = await send(req);
      setNotice(outcome.ok ? undefined : outcome.reason);
      // A refused change never reached the Sidecar, so put every Node back where the View has it.
      if (!outcome.ok) setNodes(keepSelection(flowNodes));
      return outcome.ok;
    },
    [send, flowNodes, keepSelection],
  );

  const onNodeDragStop = useCallback(
    (_event: unknown, _node: Node, dragged: Node[]) => {
      // React Flow reports a Node relative to its Stack box; the Sidecar keeps canvas coordinates.
      // A multi-select drag moves every selected Node, so every one is saved.
      for (const node of dragged) {
        const { x, y } = canvasPosition(node, nodes);
        void request({ type: 'move', id: node.id, x, y });
      }
    },
    [nodes, request],
  );

  const selected = shown?.nodes.find((n) => n.id === selectedId);
  const openStack = shown?.stacks.find((s) => stackNodeId(s.id) === selectedId);
  const [saving, setSaving] = useState(false);
  const draft = view?.draft;
  const unsaved = (draft?.items.length ?? 0) > 0;
  const stage = useCallback(
    (id: string) => (prop: string[], value: PropValue) => request({ type: 'setProp', id, prop, value }),
    [request],
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
        {error.kind === 'sidecar' ? null : view.synthing ? <p className="muted">synthing…</p> : <p className="muted">Truss is watching your files and will load the Design as soon as the app synths.</p>}
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
      <div className={error ? 'canvas dimmed' : 'canvas'}>
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
              <strong>{error.kind === 'draft' ? 'The Draft makes your app fail to synth. Showing the last good Design; undo the last edit to fix it.' : 'Your app no longer synths. Showing the last good Design.'}</strong>
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
            </div>
          ) : null}
        </div>
        <ReactFlow
          // fitView only runs on mount, so re-mount when the set of boxes changes (the first push has none).
          key={fitKey}
          nodes={nodes}
          onNodesChange={onNodesChange}
          onNodeDragStop={onNodeDragStop}
          onSelectionChange={({ nodes: picked }) => setSelectedId((picked.find((n) => n.type === 'truss' || n.type === 'layer') ?? picked.find((n) => n.type === 'stack'))?.id)}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          nodesConnectable={false}
          nodesDraggable={!error}
          // Deleting a Node is a code edit, not a canvas gesture; without this Backspace would hide the selected Node.
          deleteKeyCode={null}
          fitView
          minZoom={0.1}
          proOptions={{ hideAttribution: false }}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
        <Palette search={search} />
        {draft ? <DraftBar draft={draft} busy={view.synthing || saving} canSave={draft.problems.length === 0 && !error} onUndo={undo} onRedo={redo} onSave={() => void save()} onDiscard={discard} /> : null}
        {selected ? <NodePanel node={selected} nodes={shown?.nodes ?? []} props={panelState} paused={error !== undefined} onSave={(note) => void request({ type: 'note', id: selected.id, note })} onSet={stage(selected.id)} onOpen={openInEditor} /> : null}
        {openStack ? <StackPanel stack={openStack} props={panelState} onSet={stage(openStack.id)} onOpen={openInEditor} /> : null}
        {selectedLayer ? <LayerPanel child={selectedLayer.child} node={selectedLayer.node} /> : null}
      </div>
    </div>
  );
}
