// PROTOTYPE (throwaway, ticket #15): the pure view projection the core would
// own. Design + expand state -> React Flow nodes/edges, with a naive grid
// layout. Stacks are group boxes, not Nodes.
//
// mode 'omit':   collapsed Layers' children are left out of the array.
// mode 'hidden': every construct is in the array; collapsed ones get hidden.

const W = 150, H = 64, PAD = 16, HEAD = 34, GAP = 20;

function measure(node, expanded, sizes) {
  if (!expanded.has(node.id) || node.children.length === 0) {
    sizes.set(node.id, { w: W, h: H });
    return sizes.get(node.id);
  }
  const kids = node.children.map((c) => measure(c, expanded, sizes));
  sizes.set(node.id, grid(kids));
  return sizes.get(node.id);
}

// Uniform-cell grid; returns the container size and stashes child offsets.
function grid(kids) {
  const cols = Math.ceil(Math.sqrt(kids.length));
  const cw = Math.max(...kids.map((k) => k.w));
  const ch = Math.max(...kids.map((k) => k.h));
  kids.forEach((k, i) => {
    k.x = PAD + (i % cols) * (cw + GAP);
    k.y = HEAD + Math.floor(i / cols) * (ch + GAP);
  });
  const rows = Math.ceil(kids.length / cols);
  return { w: PAD * 2 + cols * cw + (cols - 1) * GAP, h: HEAD + PAD + rows * ch + (rows - 1) * GAP, kids };
}

export function designToFlow(design, expanded, labels, mode) {
  const nodes = [];
  const sizes = new Map();
  const stackSizes = design.stacks.map((s) => grid(s.children.map((c) => measure(c, expanded, sizes))));
  const stackGrid = grid(stackSizes);

  design.stacks.forEach((stack, si) => {
    const ss = stackSizes[si];
    nodes.push({
      id: stack.id, type: 'stack', position: { x: ss.x, y: ss.y },
      width: ss.w, height: ss.h, data: { label: stack.id }, selectable: false, draggable: false,
    });
    const emit = (node, parentId, size, hidden) => {
      const isOpen = expanded.has(node.id) && node.children.length > 0;
      const n = {
        id: node.id, type: 'truss', parentId,
        position: hidden ? { x: 0, y: 0 } : { x: size.x, y: size.y },
        width: hidden ? W : size.w, height: hidden ? H : size.h,
        data: {
          label: labels.get(node.id) ?? node.label, fqn: node.fqn, tier: node.tier,
          expandable: node.children.length > 0, expanded: isOpen,
        },
      };
      if (hidden) n.hidden = true;
      nodes.push(n);
      if (isOpen && !hidden) size.kids.forEach((k, i) => emit(node.children[i], node.id, k, hidden));
      else if (mode === 'hidden') node.children.forEach((c) => emit(c, node.id, null, true));
    };
    stack.children.forEach((c, i) => emit(c, stack.id, ss.kids[i], false));
  });

  const edges = design.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, data: { kind: e.kind }, className: `kind-${e.kind}` }));
  return { nodes, edges };
}
