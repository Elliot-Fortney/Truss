import { applyNodeChanges, Background, Controls, ReactFlow, useStore, type Node, type NodeProps, type OnNodesChange } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SourceLocation } from '../core/assembly.ts';
import { MAX_NOTE_LENGTH, type ClientRequest } from '../core/protocol.ts';
import type { NodeView, View, ViewError } from '../core/view.ts';
import { layoutView, NODE_HEIGHT, NODE_WIDTH } from './layout.ts';
import { NodeIcon } from './node-icon.tsx';
import { chooseStage, rememberStage, rememberedStage, showStage } from './stage.ts';
import { useView } from './use-view.ts';
import { namesShownAt } from './zoom.ts';

interface StackData extends Record<string, unknown> {
  label: string;
  env: string;
}
interface TrussNodeData extends Record<string, unknown> {
  label: string;
  subtitle: string;
  fqn: string;
  icon: string;
  note?: string;
  lock?: string;
  external?: boolean;
}

function StackBox({ data }: NodeProps<Node<StackData>>) {
  return (
    <div className="stack-box">
      <div className="stack-header">
        <strong>{data.label}</strong>
        <span>{data.env}</span>
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

function TrussNode({ data }: NodeProps<Node<TrussNodeData>>) {
  // Zoomed out, a name is too small to read, so the Node is its icon; the full name stays in the tooltip.
  const showName = useStore((s) => namesShownAt(s.transform[2]));
  const className = ['truss-node', data.external ? 'external' : '', showName ? '' : 'icon-only'].filter(Boolean).join(' ');
  const tooltip = data.external ? `${data.label} · ${data.fqn} · refers to an existing resource` : `${data.label} · ${data.fqn}`;
  return (
    <div className={className} title={tooltip}>
      <NodeIcon icon={data.icon} size={showName ? 36 : 44} />
      {/* Always in the page, so screen readers have the name; zoomed out it is clipped away rather than removed. */}
      <div className="node-text">
        <div className="node-label">{data.label}</div>
        <div className="node-subtitle">{data.subtitle}</div>
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
    </div>
  );
}

const nodeTypes = { stack: StackBox, truss: TrussNode };

function toFlowNodes(view: View): Node[] {
  const layout = layoutView(view);
  const stacksById = new Map(view.stacks.map((s) => [s.id, s]));
  const boxesById = new Map(layout.stacks.map((b) => [b.id, b]));
  const nodesById = new Map(view.nodes.map((n) => [n.id, n]));
  const stackNodes: Node[] = layout.stacks.map((box) => {
    const stack = stacksById.get(box.id)!;
    // React Flow places a child relative to its parent, and a nested box is laid out in canvas coordinates.
    const parent = boxesById.get(box.parentId ?? '');
    return {
      id: `stack:${box.id}`,
      type: 'stack',
      ...(parent ? { parentId: `stack:${parent.id}` } : {}),
      position: { x: box.x - (parent?.x ?? 0), y: box.y - (parent?.y ?? 0) },
      style: { width: box.width, height: box.height },
      data: { label: stack.label, env: stack.env },
      draggable: false,
      selectable: false,
    };
  });
  const nodes: Node[] = layout.nodes.map((pos) => {
    const n = nodesById.get(pos.id)!;
    return {
      id: n.id,
      type: 'truss',
      parentId: `stack:${n.stackId}`,
      position: { x: pos.x, y: pos.y },
      style: { width: NODE_WIDTH, height: NODE_HEIGHT },
      data: { label: n.label, subtitle: n.subtitle, fqn: n.fqn, icon: n.icon, ...(n.note ? { note: n.note } : {}), ...(n.lock ? { lock: n.lock } : {}), ...(n.external ? { external: true } : {}) },
    };
  });
  // React Flow needs a parent to come before its children.
  return [...stackNodes, ...nodes];
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

function NodePanel({ node, onSave, onOpen }: { node: NodeView; onSave: (note: string) => void; onOpen(at: SourceLocation): void }) {
  return (
    <aside className="note-panel">
      <h2>{node.label}</h2>
      {node.lock ? <p className="lock-reason">Read-only: {node.lock}</p> : null}
      <button type="button" className="open-in-editor" onClick={() => onOpen(node.source)}>
        Open in editor
      </button>
      <label>
        Note
        {/* Keyed by Node so switching Nodes starts from that Node's note; saved when the field loses focus. */}
        <textarea
          key={node.id}
          defaultValue={node.note ?? ''}
          rows={6}
          maxLength={MAX_NOTE_LENGTH}
          onBlur={(e) => {
            if (e.currentTarget.value !== (node.note ?? '')) onSave(e.currentTarget.value);
          }}
        />
      </label>
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
  const { view, connection, send, openInEditor } = useView();
  // The picked Stage is only a preference of this browser; with none picked, or a gone one, the first Stage shows.
  const [pickedStage, setPickedStage] = useState(rememberedStage);
  const stageId = view ? chooseStage(view.stages, pickedStage) : undefined;
  const shown = useMemo(() => (view ? showStage(view, stageId) : undefined), [view, stageId]);
  const flowNodes = useMemo(() => (shown ? toFlowNodes(shown) : []), [shown]);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const fitKey = flowNodes.map((n) => n.id).join('|');

  // The View is the truth; React Flow only holds a Node's position while it is being dragged.
  useEffect(() => setNodes(flowNodes), [flowNodes]);
  const onNodesChange = useCallback<OnNodesChange>((changes) => setNodes((current) => applyNodeChanges(changes, current)), []);

  const request = useCallback(
    async (req: ClientRequest) => {
      const outcome = await send(req);
      setNotice(outcome.ok ? undefined : outcome.reason);
      // A refused change never reached the Sidecar, so put every Node back where the View has it.
      if (!outcome.ok) setNodes(flowNodes);
    },
    [send, flowNodes],
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
          {error ? (
            <div className="banner error-banner" role="alert">
              <strong>Your app no longer synths. Showing the last good Design.</strong>
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
          onSelectionChange={({ nodes: picked }) => setSelectedId(picked.find((n) => n.type === 'truss')?.id)}
          edges={[]}
          nodeTypes={nodeTypes}
          nodesConnectable={false}
          // Deleting a Node is a code edit, not a canvas gesture; without this Backspace would hide the selected Node.
          deleteKeyCode={null}
          fitView
          minZoom={0.1}
          proOptions={{ hideAttribution: false }}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
        {selected ? <NodePanel node={selected} onSave={(note) => void request({ type: 'note', id: selected.id, note })} onOpen={openInEditor} /> : null}
      </div>
    </div>
  );
}
