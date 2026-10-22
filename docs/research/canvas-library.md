# Research: canvas library for nested, expandable Nodes

Ticket: 03-canvas-library (resolved; see the Truss v1 map, #8). Researched 2026-10-22 against official docs, GitHub repo metadata, licence files and the npm registry.

## Recommendation

Use **React Flow (`@xyflow/react`, MIT)** as the canvas **adapter**, behind a canvas port. The **Design** model, including the Node tree, Layers and Connections, stays in the hexagonal core as plain TypeScript. A pure mapping function turns a Design plus the current expand state into React Flow `nodes`/`edges`.

Why:
- It is the only candidate that passes on every criterion: a permissive licence, first-class nesting, typed handles with a validation hook, a JSON snapshot, an official testing guide, and active maintenance.
- JointJS core is the runner-up. Its licence is acceptable, but much of the editor tooling is commercial.

Svelte Flow is also MIT and built on the same `@xyflow/system` package, so it is a valid alternative if the team prefers Svelte. Choosing between them is a UI-framework decision, not a canvas decision. This research did not compare framework features in depth.

## Licence screen (Apache-2.0 compatibility)

| Library | Licence (source) | Verdict |
|---|---|---|
| React Flow `@xyflow/react` 12.12.0 | MIT ([npm](https://www.npmjs.com/package/@xyflow/react), [GitHub repo licence](https://github.com/xyflow/xyflow)) | OK. "React Flow is open-source MIT-licensed software, and it will be forever." ([reactflow.dev/pro](https://reactflow.dev/pro)) |
| Svelte Flow `@xyflow/svelte` 1.7.0 | MIT ([svelteflow.dev](https://svelteflow.dev/)); peer dependency `svelte ^5.25.0` (npm) | OK |
| tldraw 5.5.2 | Custom licence, `SEE LICENSE IN LICENSE.md` ([LICENSE.md](https://github.com/tldraw/tldraw/blob/main/LICENSE.md)) | **Excluded.** The licence forbids use "in Production Environments" without a trial or commercial licence key, and the software includes licence-key enforcement and watermark checks. This is incompatible with an Apache-2.0 tool that anyone can run or host. |
| JointJS `@joint/core` 4.3.3, `@joint/react` 4.3.6 | MPL-2.0 ([GitHub](https://github.com/clientIO/joint), npm) | OK. MPL's copyleft applies per file, so Apache code combined with it in a Larger Work does not need relicensing ([MPL FAQ Q11, Q13](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)). Only changes to JointJS's own files must stay MPL. JointJS+ is commercial, priced from $3,468 per developer as a perpetual licence ([pricing](https://www.jointjs.com/pricing)). |
| Rete.js `rete` 2.0.6 | MIT (npm) | Core is OK, but nesting is **excluded**. `rete-scopes-plugin` is CC-BY-NC-SA-4.0, and "Commercial use is currently not permitted" ([licensing](https://retejs.org/docs/licensing), npm). |
| maxGraph `@maxgraph/core` 0.25.1 | Apache-2.0 ([GitHub](https://github.com/maxGraph/maxGraph)) | Licence is OK, but the library is still 0.x. Its README says some "adjustments still required to match the behavior of mxGraph" and that the docs are a work in progress. |
| AntV X6 `@antv/x6` 3.1.8 | MIT ([GitHub](https://github.com/antvis/X6)) | OK |
| projectstorm react-diagrams 7.0.4 | MIT | Licence is OK, but the project appears stale: the last npm publish was 2024-02 and the last push was 2025-04 (GitHub API). |

Activity check from the GitHub API on 2026-10-21/22: xyflow, tldraw, JointJS, Rete, X6 and maxGraph all had pushes within the last few days. Stars: xyflow ~38.7k, tldraw ~51k, Rete ~12.3k, X6 ~6.7k, JointJS ~5.4k, maxGraph ~1.2k.

## Criteria for the shortlist

### Nested Nodes that expand and collapse (Layers)

- **React Flow**: Native sub-flows. A child sets `parentId`, and "A position of `{ x: 0, y: 0 }` is the top left corner of the parent". When the parent moves, the child moves with it. `extent: 'parent'` keeps children inside their parent. Parents must come before their children in the `nodes` array ([sub-flows guide](https://reactflow.dev/learn/layouting/sub-flows)). `expandParent` grows the parent when a child is dragged to its edge. `hidden` toggles visibility ([Node type](https://reactflow.dev/api-reference/types/node)). For large trees, the performance guide recommends showing "only a limited number of nodes and allow users to expand them as needed", toggling the `hidden` property ([performance](https://reactflow.dev/learn/advanced-use/performance)). That is the Layer model.
  - Caveat: the ready-made **Expand and Collapse** example is a **Pro** example under the xyflow Pro licence ([example](https://reactflow.dev/examples/layout/expand-collapse)). Truss can't copy it, but the free primitives (`parentId`, `hidden`, `expandParent`) are enough to build the feature.
  - Docs give no limit on nesting depth.
- **JointJS core**: `parent.embed(...)`/`unembed`, `embeddingMode` with `validateEmbedding`, `getEmbeddedCells({ deep: true })` and `fitToChildren()`. The docs show that embedding combined with the Paper `viewport` option can create "collapsible container shapes" ([containers and grouping](https://docs.jointjs.com/learn/features/containers-and-grouping/)).
- **X6**: `parent.addChild(child)`, an `embedding` option with `findParent`, and `translating.restrict`. Collapse is built by hand: a custom Group node hides its descendants, and the docs call auto-expand involved ([group tutorial](https://x6.antv.antgroup.com/en/tutorial/intermediate/group)).
- **Rete**: Nesting depends on the non-commercial scopes plugin, which also needs explicit node sizes ([scopes guide](https://retejs.org/docs/guides/scopes)).

### Typed connection handles

- **React Flow**: Each `<Handle>` has a `type` of `source` or `target`, and multiple handles on a node need unique `id`s. Edges attach to a handle through `sourceHandle`/`targetHandle`. Dynamic handles need `useUpdateNodeInternals` ([handles](https://reactflow.dev/learn/customization/handles)). `isValidConnection` on `<ReactFlow>` "can be used to validate a new connection" ([API](https://reactflow.dev/api-reference/react-flow), [validation example](https://reactflow.dev/examples/interaction/validation)). Truss's semantic types, such as which construct property a handle stands for, live in the core. The adapter calls a core function such as `canConnect(design, from, to)` from `isValidConnection`.
- **JointJS**: Has ports, and the docs list them as a feature ([features](https://docs.jointjs.com/learn/features/)). This research did not confirm whether they are in core or JointJS+.

### Performance with hundreds of Nodes

- React Flow's docs give **no numeric limit**. Their guidance: memoise custom node components and callbacks, and don't subscribe components to the whole `nodes` array, which changes on every drag, pan and zoom. Keep derived state such as selection in its own store field, use `hidden` to expand on demand, and simplify heavy CSS ([performance](https://reactflow.dev/learn/advanced-use/performance)). `onlyRenderVisibleElements` renders only what is in the viewport, at some extra overhead ([API](https://reactflow.dev/api-reference/react-flow)).
- Layers help: collapsed Nodes keep the visible count down, so "hundreds" is the worst case, when everything is expanded.
- This research ran no benchmark. Spike: render around 500 nodes with three levels of nesting and measure drag frame times.

### Serialisable state

- React Flow `toObject()` returns "the nodes, edges and the viewport as a JSON object" ([ReactFlowInstance](https://reactflow.dev/api-reference/types/react-flow-instance)). Nodes are plain objects (`id`, `type`, `position`, `parentId`, `data`, ...). Docs recommend a controlled flow with an external store such as Zustand, created immutably ([state management](https://reactflow.dev/learn/advanced-use/state-management)).
- **Recommendation**: don't use `toObject()` as the Design file format (ticket 08). The Design file should be Truss's own schema, owned by the core. Canvas state, meaning positions, viewport and expand flags, is view state that the adapter maps in and out. Keeping that boundary also keeps Import (v2) independent of the canvas.

### Testability (TDD)

- React Flow publishes a testing guide. Cypress and Playwright need "no additional setup". Jest needs a provided mock file covering `ResizeObserver`, `DOMMatrixReadOnly`, `offsetWidth`/`offsetHeight` and `getBBox`. Tests must wait for nodes to be measured before edges render, and must disable dragging (d3-drag) in jsdom ([testing](https://reactflow.dev/learn/advanced-use/testing)). The guide doesn't mention Vitest, but the same mocks should carry over. This is unverified.
- Hexagonal fit: most of the logic can be TDD'd with no canvas at all. That covers the Design model, the expand/collapse rules, `canConnect`, and the pure `designToFlow(design, viewState)` mapper. Only a thin layer of component and e2e tests touches React Flow.

## Notes and follow-ups

- **Auto-layout when a Layer expands** is not part of React Flow. Options include dagre (MIT) or elkjs, which handles compound graphs. elkjs is licensed `EPL-2.0 OR GPL-3.0-or-later` (npm). EPL-2.0 is weak copyleft, so using it unmodified as a dependency is generally fine, but check that before adopting it. Free React Flow docs point to these engines, and the auto-layout example is Pro ([Pro examples](https://reactflow.dev/pro/examples)).
- Edges connected to child nodes render above nodes by default. Adjust with `zIndex` if needed ([sub-flows](https://reactflow.dev/learn/layouting/sub-flows)).
- Svelte Flow shares `@xyflow/system` 0.0.83 with React Flow (npm dependencies). Its site confirms subflows "out of the box" and a `<Handle />` component. Feature parity was not checked line by line.
