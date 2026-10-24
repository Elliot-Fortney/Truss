export interface Position {
  line: number;
  col: number;
}

export interface Span {
  file: string;
  start: Position;
  end: Position;
}

/** Whether the `new` is assigned to something the code can refer to later. */
export type Binding = 'const' | 'field' | 'none';

/** A class of the app's own whose body holds a `new`. */
export interface EnclosingClass {
  name: string;
  /** `construct` is any other class that ends up extending `Construct`. */
  kind: 'stack' | 'stage' | 'construct';
}

/** The nearest loop or function around a `new`, when it isn't the body of a class constructor. */
export type Surround = { kind: 'loop' } | { kind: 'helper'; name: string };

export interface PropFacts {
  name: string;
  /** `literal` is a string, number, boolean, `null` or plain template; `object` is an object literal, read field by field; anything else is an `expression`. */
  kind: 'literal' | 'expression' | 'object';
  /** The prop's value exactly as written. */
  text: string;
  /** What a literal prop evaluates to: the string without its quotes, the number, the boolean or `null`. Absent for an expression. */
  value?: string | number | boolean | null;
  /** The props of an object literal. */
  fields?: PropFacts[];
  /** An expression of the form `[ns.]Type.MEMBER`, which is how an enum value is written. */
  member?: { type: string; name: string };
  /** An expression of the form `[ns.]Duration.seconds(30)` or `[ns.]Size.mebibytes(512)`. */
  quantity?: { type: 'Duration' | 'Size'; unit: string; amount: number };
}

/** The props argument: an object literal Truss can read prop by prop, or anything else (a variable, a call). */
export type PropsFacts = { form: 'object'; props: PropFacts[] } | { form: 'other'; text: string };

/** What the TypeScript source says about one construct path (ADR 0007). `span` is the `new` call, or the `fromXxx` call of an external. */
export interface NodeFacts {
  span: Span;
  /** The class as written, e.g. `s3.Bucket`; for an external, the `fromXxx` call's callee, e.g. `s3.Bucket.fromBucketName`. */
  className: string;
  /** The Construct ID when it is a string literal. */
  literalId?: string;
  /** How many construct paths were created by this one `new` span. */
  pathsOnSpan: number;
  binding: Binding;
  /** Absent when the `new` is outside any class, as a Stack is in `bin/app.ts`. */
  enclosingClass?: EnclosingClass;
  surround?: Surround;
  /** Absent when the `new` passes no props. */
  props?: PropsFacts;
  /** The construct comes from a `fromXxx` call, so the app refers to it without creating it. */
  external?: true;
}

/**
 * How the code writes a Reference. The first four are the Node's own binding and can be edited; an `accessor` is a
 * property read off the Node (`network.vpc`) and is drawn to the Node that owns it; a `call` and a `conditional`
 * hold the Node in an expression Truss doesn't take apart.
 */
export type ReferenceForm = 'identifier' | 'field' | 'shorthand' | 'alias' | 'accessor' | 'call' | 'conditional';

/** One prop of a construct that points at another Node. */
export interface ReferenceFacts {
  /** The construct path of the Node whose prop holds it. */
  from: string;
  /** The construct path of the Node it points at; for an accessor, the Node that owns what is read. */
  to: string;
  /** The prop of the `new` call's props object. */
  prop: string;
  form: ReferenceForm;
  /** Whether Truss can re-point or remove it. */
  editable: boolean;
  /** Why not, when it can't be. */
  reason?: string;
  /** Which element of an array prop it is. */
  index?: number;
  /** The expression as written. */
  text: string;
  /** Where the expression is. */
  span: Span;
}

/** Facts per construct path. Nothing in here is a syntax tree. */
export interface Facts {
  nodes: Record<string, NodeFacts>;
  /** The Nodes the props of each construct point at. Absent when none do. */
  references?: ReferenceFacts[];
}
