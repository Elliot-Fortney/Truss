import { applyNodeChanges, Background, Controls, ReactFlow, type Node, type NodeProps, type OnNodesChange } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { MAX_NOTE_LENGTH, type ClientRequest } from '../core/protocol.ts';
import type { NodeView, View } from '../core/view.ts';
import { layoutView, NODE_HEIGHT, NODE_WIDTH } from './layout.ts';
import { useView } from './use-view.ts';

interface StackData extends Record<string, unknown> {
  label: string;
  env: string;
}
interface TrussNodeData extends Record<string, unknown> {
  label: string;
  subtitle: string;
  fqn: string;
  note?: string;
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

function GenericIcon() {
  return (
    <svg className="node-icon" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 12h8M12 8v8" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function TrussNode({ data }: NodeProps<Node<TrussNodeData>>) {
  return (
    <div className="truss-node" title={data.fqn}>
      <GenericIcon />
      <div className="node-text">
        <div className="node-label">{data.label}</div>
        <div className="node-subtitle">{data.subtitle}</div>
      </div>
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
  const stackNodes: Node[] = layout.stacks.map((box) => {
    const stack = view.stacks.find((s) => s.id === box.id)!;
    return {
      id: `stack:${box.id}`,
      type: 'stack',
      position: { x: box.x, y: box.y },
      style: { width: box.width, height: box.height },
      data: { label: stack.label, env: stack.env },
      draggable: false,
      selectable: false,
    };
  });
  const nodes: Node[] = layout.nodes.map((pos) => {
    const n = view.nodes.find((v) => v.id === pos.id)!;
    return {
      id: n.id,
      type: 'truss',
      parentId: `stack:${n.stackId}`,
      position: { x: pos.x, y: pos.y },
      style: { width: NODE_WIDTH, height: NODE_HEIGHT },
      data: { label: n.label, subtitle: n.subtitle, fqn: n.fqn, ...(n.note ? { note: n.note } : {}) },
    };
  });
  // React Flow needs a parent to come before its children.
  return [...stackNodes, ...nodes];
}

function NotePanel({ node, onSave }: { node: NodeView; onSave: (note: string) => void }) {
  return (
    <aside className="note-panel">
      <h2>{node.label}</h2>
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

export function App() {
  const { view, connection, send } = useView();
  const flowNodes = useMemo(() => (view ? toFlowNodes(view) : []), [view]);
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
        const box = nodes.find((n) => n.id === node.parentId);
        void request({ type: 'move', id: node.id, x: node.position.x + (box?.position.x ?? 0), y: node.position.y + (box?.position.y ?? 0) });
      }
    },
    [nodes, request],
  );

  const selected = view?.nodes.find((n) => n.id === selectedId);

  if (!view) {
    return <div className="page-message">{connection === 'closed' ? 'Disconnected from Truss.' : 'Connecting…'}</div>;
  }
  if (view.error) {
    return (
      <div className="page-error" role="alert">
        <h1>{view.error.kind === 'sidecar' ? 'Truss can’t use your truss.json' : 'Your app didn’t synth'}</h1>
        <p>{view.error.message}</p>
        {view.error.output ? <pre>{view.error.output}</pre> : null}
      </div>
    );
  }
  return (
    <div className="canvas">
      {view.synthing ? <div className="synthing">synthing…</div> : null}
      {connection === 'closed' ? <div className="banner">Disconnected from Truss.</div> : null}
      {notice ? (
        <div className="banner notice" role="alert">
          {notice}
        </div>
      ) : null}
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
      {selected ? <NotePanel node={selected} onSave={(note) => void request({ type: 'note', id: selected.id, note })} /> : null}
    </div>
  );
}
