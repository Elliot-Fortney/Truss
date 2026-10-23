# Edits inside a Stack or Stage class created more than once apply to every instance

The write-back decision makes a Node editable only when exactly one construct path maps to its `new` span. Real apps usually create one Stack or Stage class several times (`new ApiStack(app, 'Dev')`, `new ApiStack(app, 'Prod')`, one per region), which puts several paths on every span inside it, so that rule alone would make most real apps view-only. We relax it in one case: when a span's paths differ only because an enclosing **Stack or Stage class** is created more than once, the Node is editable. The edit goes into the class body and so applies to every instance.

## Considered Options

- **Keep the one-path rule**: rejected. The round trip would fail on the most common shape of real app.
- **Edit one instance and fork it**: rejected. Truss would have to restructure the user's code, which it never does.
- **Extend the exception to every user `Construct` subclass**: rejected. Those stay read-only, as the write-back decision says. Stacks and Stages are the scopes people deploy and think in, but a reusable construct's body is a library.

## Consequences

- The property panel says "Applies to N instances: Dev, Prod", and the Draft badges the Node in every affected instance.
- Values that differ per instance usually come from constructor props. They aren't literals, so they stay read-only under the existing prop rules.
- A Node created only in some instances (`if (props.prod) new Alarm(...)`) has one path per span and follows the normal rules.
- Dragging a Node writes its position to every instance's path in the Sidecar, so the Stages look alike. Sidecar keying is unchanged.
