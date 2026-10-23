// PROTOTYPE (throwaway, ticket #15): React Flow scale spike.
// URL params pick the variant:
//   nodes=500  expand=none|l3|all  mode=omit|hidden  apply=replace|diff  orv=0|1
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ReactFlow, Background, MiniMap, Handle, Position, applyNodeChanges, applyEdgeChanges, useReactFlow, ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { makeDesign, countConstructs, allIds } from './design.js';
import { designToFlow } from './project.js';

const params = new URLSearchParams(location.search);
const CFG = {
  nodes: +(params.get('nodes') ?? 500),
  expand: params.get('expand') ?? 'none',
  mode: params.get('mode') ?? 'omit',
  apply: params.get('apply') ?? 'diff',
  orv: params.get('orv') === '1',
};

// --- the "local process" side: owns the Design and pushes whole views ---
const design = makeDesign({ nodes: CFG.nodes });
const expanded = new Set(
  CFG.expand === 'all' ? allIds(design, (n) => n.children.length > 0)
  : CFG.expand === 'l3' ? allIds(design, (n) => n.tier === 'L3' || (n.tier !== 'L1' && n.id.split('/').length > 2))
  : [],
);
const labels = new Map();
function push() {
  const t0 = performance.now();
  const view = designToFlow(design, expanded, labels, CFG.mode);
  const t1 = performance.now();
  const msg = JSON.stringify(view);
  const t2 = performance.now();
  return { msg, project: t1 - t0, stringify: t2 - t1 };
}

// --- the browser side: thin view ---
const sameNode = (a, b) =>
  a.type === b.type && a.parentId === b.parentId && a.hidden === b.hidden &&
  a.position.x === b.position.x && a.position.y === b.position.y &&
  a.width === b.width && a.height === b.height &&
  a.data.label === b.data.label && a.data.expanded === b.data.expanded;
const sameEdge = (a, b) => a.source === b.source && a.target === b.target && a.data.kind === b.data.kind;
function reconcile(prev, next, same) {
  const byId = new Map(prev.map((n) => [n.id, n]));
  let changed = 0;
  const out = next.map((n) => {
    const p = byId.get(n.id);
    if (p && same(p, n)) return p;
    changed++;
    return n;
  });
  return { out, changed };
}

const TIER = { L1: '#8a8f98', L2: '#ff9900', L3: '#7aa116' };
let onToggle = () => {};
const TrussNode = memo(function TrussNode({ id, data }) {
  return (
    <div className={`truss ${data.expanded ? 'open' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="head">
        <span className="icon" style={{ background: TIER[data.tier] }}>{data.tier}</span>
        <span className="label" title={data.fqn}>{data.label}</span>
        {data.expandable && (
          <button className="nodrag" onClick={() => onToggle(id)}>{data.expanded ? '−' : '+'}</button>
        )}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
});
const StackBox = memo(function StackBox({ data }) {
  return <div className="stack"><span>{data.label}</span></div>;
});
const nodeTypes = { truss: TrussNode, stack: StackBox };

const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

function Canvas() {
  const first = useRef(JSON.parse(push().msg));
  const [nodes, setNodes] = useState(first.current.nodes);
  const [edges, setEdges] = useState(first.current.edges);
  const nodesRef = useRef(nodes), edgesRef = useRef(edges);
  nodesRef.current = nodes; edgesRef.current = edges;
  const lastChange = useRef(performance.now());
  const rf = useReactFlow();

  const onNodesChange = useCallback((c) => { lastChange.current = performance.now(); setNodes((ns) => applyNodeChanges(c, ns)); }, []);
  const onEdgesChange = useCallback((c) => setEdges((es) => applyEdgeChanges(c, es)), []);

  // One edit round trip: server projects + serialises, client parses + applies.
  const roundTrip = useCallback(async (edit) => {
    const t0 = performance.now();
    edit();
    const { msg, project, stringify } = push();
    const t1 = performance.now();
    const view = JSON.parse(msg);
    const t2 = performance.now();
    let nextNodes = view.nodes, nextEdges = view.edges, changed = view.nodes.length;
    if (CFG.apply === 'diff') {
      const n = reconcile(nodesRef.current, view.nodes, sameNode);
      nextNodes = n.out; changed = n.changed;
      nextEdges = reconcile(edgesRef.current, view.edges, sameEdge).out;
    }
    const t3 = performance.now();
    flushSync(() => { setNodes(nextNodes); setEdges(nextEdges); });
    const t4 = performance.now();
    await frame();
    const t5 = performance.now();
    // "Settled": React Flow has stopped sending dimension changes.
    while (performance.now() - lastChange.current < 50 && performance.now() - t0 < 5000) await frame();
    const t6 = performance.now();
    return {
      project, stringify, parse: t2 - t1, reconcile: t3 - t2, commit: t4 - t3,
      toPaint: t5 - t0, settled: Math.max(t5, Math.min(t6, lastChange.current + 16)) - t0,
      bytes: msg.length, nodesInView: view.nodes.length, changed,
    };
  }, []);

  useEffect(() => {
    onToggle = (id) => roundTrip(() => (expanded.has(id) ? expanded.delete(id) : expanded.add(id))).then((r) => console.log('toggle', r));
    window.bench = {
      cfg: CFG,
      stats: () => ({
        constructs: countConstructs(design), edges: design.edges.length,
        nodesInArray: nodesRef.current.length,
        domNodes: document.querySelectorAll('.react-flow__node').length,
        domEdges: document.querySelectorAll('.react-flow__edge').length,
      }),
      toggle: (id) => roundTrip(() => (expanded.has(id) ? expanded.delete(id) : expanded.add(id))),
      edit: (id) => roundTrip(() => labels.set(id, `Renamed${Math.random().toString(36).slice(2, 6)}`)),
      ids: (tier, open) => allIds(design, (n) => n.tier === tier && n.id.split('/').length === 2 && expanded.has(n.id) === open),
      setViewport: (v) => rf.setViewport(v),
      fitView: () => rf.fitView(),
      center: (id) => { const n = rf.getInternalNode(id); rf.setCenter(n.internals.positionAbsolute.x + 75, n.internals.positionAbsolute.y + 32, { zoom: 1 }); },
      screenPos: (id) => { const r = document.querySelector(`[data-id="${CSS.escape(id)}"]`)?.getBoundingClientRect(); return r && { x: r.x + 40, y: r.y + 12 }; },
      // Records rAF intervals until stop() is called.
      record: () => {
        const deltas = []; let last = performance.now(), on = true;
        const tick = (t) => { deltas.push(t - last); last = t; if (on) requestAnimationFrame(tick); };
        requestAnimationFrame((t) => { last = t; requestAnimationFrame(tick); });
        window.bench.stop = () => { on = false; return deltas; };
      },
      settle: async () => { await frame(); while (performance.now() - lastChange.current < 100) await frame(); },
    };
    window.benchReady = true;
  }, [roundTrip, rf]);

  return (
    <ReactFlow
      nodes={nodes} edges={edges} nodeTypes={nodeTypes}
      onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
      onlyRenderVisibleElements={CFG.orv} minZoom={0.02} fitView
    >
      <Background />
      {params.get('minimap') === '1' && <MiniMap pannable zoomable />}
    </ReactFlow>
  );
}

export default function App() {
  return (
    <>
      <div className="banner">
        PROTOTYPE · React Flow scale spike (#15) · {CFG.nodes} Nodes · expand={CFG.expand} · mode={CFG.mode} · apply={CFG.apply} · orv={String(CFG.orv)}
      </div>
      <ReactFlowProvider><Canvas /></ReactFlowProvider>
    </>
  );
}
