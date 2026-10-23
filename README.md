# Truss

Open a TypeScript CDK app as an editable Design. See `CONTEXT.md` for the vocabulary and `docs/adr/` for the decisions.

## Use

```sh
npm i -D truss-cdk   # placeholder package name: `truss` is taken on npm
npx truss            # run inside a CDK app; --port <n>, --no-open, --synth-timeout <seconds> (default 120)
```

Truss opens apps on `aws-cdk-lib` 2.191.0 or newer (not CDK v1), and refuses one whose cloud assembly schema is newer than the one it bundles ("upgrade Truss"). It reads the constructs it offers from the app's installed `aws-cdk-lib` and directly installed jsii libraries, and caches them by package version in `~/.cache/truss/catalog`.

## Develop

```sh
npm ci && (cd test/fixtures/straight-line && npm ci)
npm run typecheck && npm run lint && npm test
npm run build && npm run e2e       # Playwright needs `npx playwright install chromium` once
npm run record-fixture -- straight-line   # re-record a fixture's synth output
```

Layers (enforced by `npm run lint`): `src/core` ← `src/session` ← `src/adapters`, `src/ui`; `src/cli*` wires them together.
