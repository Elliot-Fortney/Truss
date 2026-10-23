import { Background, Controls, ReactFlow, type Node, type NodeProps } from '@xyflow/react';
import { useMemo } from 'react';
import type { SourceLocation, SynthError } from '../core/assembly.ts';
import type { View } from '../core/view.ts';
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
      extent: 'parent',
      position: { x: pos.x, y: pos.y },
      style: { width: NODE_WIDTH, height: NODE_HEIGHT },
      data: { label: n.label, subtitle: n.subtitle, fqn: n.fqn },
      draggable: false,
    };
  });
  // React Flow needs a parent to come before its children.
  return [...stackNodes, ...nodes];
}

function ErrorLocation({ error, onOpen }: { error: SynthError; onOpen(at: SourceLocation): void }) {
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
  const { view, connection, openInEditor } = useView();
  const flowNodes = useMemo(() => (view ? toFlowNodes(view) : []), [view]);
  const fitKey = flowNodes.map((n) => n.id).join('|');

  if (!view) {
    return <div className="page-message">{connection === 'closed' ? 'Disconnected from Truss.' : 'Connecting…'}</div>;
  }
  const { error } = view;
  // Nothing has ever synthed, so there is no Design to keep: the error is the whole page.
  if (error && !view.hasDesign) {
    return (
      <div className="page-error" role="alert">
        <h1>Your app didn’t synth</h1>
        <p>{error.message}</p>
        <ErrorLocation error={error} onOpen={openInEditor} />
        {error.output ? <pre>{error.output}</pre> : null}
        {view.synthing ? <p className="muted">synthing…</p> : <p className="muted">Truss is watching your files and will load the Design as soon as the app synths.</p>}
      </div>
    );
  }
  return (
    // With an error here the Design is the last good one: dimmed, and not editable until synth works again.
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
      </div>
      <ReactFlow
        // fitView only runs on mount, so re-mount when the set of boxes changes (the first push has none).
        key={fitKey}
        nodes={flowNodes}
        edges={[]}
        nodeTypes={nodeTypes}
        nodesConnectable={false}
        elementsSelectable={false}
        fitView
        minZoom={0.1}
        proOptions={{ hideAttribution: false }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
