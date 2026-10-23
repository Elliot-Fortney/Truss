---
status: superseded by ADR-0007
---

# The local process owns the Design; the core is pure behind two ports

The live Design and its undo history are held by the local Node process, not the browser. The browser is a thin view: it sends edits to one session over a WebSocket and gets the whole view model back after every change. Code is split into four layers, with dependencies pointing inward only. **core** is pure: the Design model and its edits, validation, the Design file codec and migrations, codegen, Export planning, the canvas view projection and the Preview SVG. **session** holds the state and is the only layer that calls ports. **adapters** and **ui** sit outside it. There are only two ports: **Instantiation** (`instantiate(design)` returns a tree or a CDK error per Node) and **Files** (`read` / `write` / `exists`).

## Considered Options

- **Browser holds the Design, process is a stateless host for I/O and CDK**: edits are instant and undo is local, but the state would be split between the browser and the process. Rejected so that a single place owns the Design, which is also where CDK runs, files are written, and the Preview is rendered without a DOM.
- **A port for every candidate seam** (Catalog, Overlays, canvas, Preview, transport): rejected under the two-adapters rule. The Catalog is plain data handed in, with Overlays merged at build time. React Flow is the only canvas there will ever be, so it's a thin renderer with no interface (this reverses the canvas-library research's suggested canvas port). The Preview is a pure function, and the transport is a driving adapter.
- **Running CDK in the main process**: rejected. A Design that hangs CDK would freeze saving and editing. The real adapter runs in a worker thread that is killed and restarted when it fails.

## Consequences

- Every edit is a round trip to the process. That's fine locally, but prop text fields keep a local draft and send it on pause or blur.
- CDK runs after every edit, debounced, with stale results dropped. So CDK errors work as live validation, even on collapsed Nodes.
- Tests drive the session directly, using an in-memory folder and a fake instantiator. A few end-to-end tests cover the socket, and a few cover the real file and CDK adapters.
- Hashing and every "don't clobber silently" check live in the core. The Design file isn't watched; if its hash changed since it was loaded, Truss asks before saving over it.
- Hosting later means one server-side session per user, with a sandboxed Instantiation adapter and storage behind the Files port.
- TDD order: codegen, then the codec, then Export planning, then the session with fakes, then the real adapters.
