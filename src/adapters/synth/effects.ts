import type { Effect, EffectEnd, ImportRef } from '../../core/assembly.ts';

type Json = unknown;

/** The parts of a CloudFormation template that effects are read from. */
export interface EffectTemplate {
  Resources?: Record<string, { Type?: string; Metadata?: Record<string, unknown>; Properties?: Record<string, Json> }>;
  Outputs?: Record<string, { Value?: Json; Export?: { Name?: Json } }>;
}

interface Scope {
  /** Construct path by logical ID, in this template. */
  pathOf: ReadonlyMap<string, string>;
  /** Construct path of what each export name exports, over every template. */
  exports: ReadonlyMap<string, { path: string; template: EffectTemplate }>;
}

const PSEUDO: Record<string, string> = { 'AWS::Partition': 'aws' };

/** Reads `value` as text, with every reference to a construct shown as its path in braces, and notes those paths in `paths`. */
function flatten(value: Json, scope: Scope, paths: Set<string>): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((v) => flatten(v, scope, paths)).join('');
  if (typeof value !== 'object' || value === null) return '';
  const obj = value as Record<string, Json>;
  const reference = (id: string): string => {
    const path = scope.pathOf.get(id);
    if (path === undefined) return PSEUDO[id] ?? `\${${id}}`;
    paths.add(path);
    return `{${path}}`;
  };
  if (typeof obj.Ref === 'string') return reference(obj.Ref);
  if ('Fn::GetAtt' in obj) {
    const att = obj['Fn::GetAtt'];
    const id = Array.isArray(att) ? att[0] : typeof att === 'string' ? att.split('.')[0] : undefined;
    return typeof id === 'string' ? reference(id) : '';
  }
  if ('Fn::ImportValue' in obj) {
    const name = obj['Fn::ImportValue'];
    if (typeof name !== 'string') return flatten(name, scope, paths);
    const exported = scope.exports.get(name);
    if (!exported) return `\${import:${name}}`;
    paths.add(exported.path);
    return `{${exported.path}}`;
  }
  if ('Fn::Join' in obj) {
    const join = obj['Fn::Join'];
    if (!Array.isArray(join) || typeof join[0] !== 'string') return '';
    return (Array.isArray(join[1]) ? join[1] : []).map((v) => flatten(v, scope, paths)).join(join[0]);
  }
  if ('Fn::Sub' in obj) {
    const sub = obj['Fn::Sub'];
    const text = Array.isArray(sub) ? sub[0] : sub;
    const vars = (Array.isArray(sub) ? sub[1] : undefined) as Record<string, Json> | undefined;
    if (typeof text !== 'string') return '';
    return text.replace(/\$\{(!?)([^}]+)\}/g, (_, literal: string, name: string) => {
      if (literal) return `\${${name}}`;
      const id = name.split('.')[0]!;
      return vars && id in vars ? flatten(vars[id], scope, paths) : reference(id);
    });
  }
  return Object.values(obj)
    .map((v) => flatten(v, scope, paths))
    .join('');
}

function endOf(value: Json, scope: Scope): EffectEnd {
  const paths = new Set<string>();
  const text = flatten(value, scope, paths);
  return { paths: [...paths], text };
}

const NOTHING: EffectEnd = { paths: [], text: '' };

/** The logical IDs a value points at with `Ref` or `Fn::GetAtt`. */
function idsIn(value: Json, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => idsIn(v, out));
  else if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, Json>;
    if (typeof obj.Ref === 'string') out.add(obj.Ref);
    else if ('Fn::GetAtt' in obj) {
      const att = obj['Fn::GetAtt'];
      const id = Array.isArray(att) ? att[0] : typeof att === 'string' ? att.split('.')[0] : undefined;
      if (typeof id === 'string') out.add(id);
    } else Object.values(obj).forEach((v) => idsIn(v, out));
  }
  return out;
}

const list = (v: Json): Json[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** The effects of one IAM policy document attached to `source`: one per allowed resource. */
function grantsOf(at: string, document: Json, source: EffectEnd, scope: Scope): Effect[] {
  const out: Effect[] = [];
  const statements = list((document as { Statement?: Json } | undefined)?.Statement) as Record<string, Json>[];
  for (const statement of statements) {
    if (statement.Effect !== 'Allow' || statement.Resource === undefined) continue;
    const actions = list(statement.Action).filter((a): a is string => typeof a === 'string');
    const detail = actions.length > 0 ? actions.join(', ') : 'all actions except those listed';
    for (const resource of list(statement.Resource))
      out.push({ kind: 'grant', at, source, target: endOf(resource, scope), detail });
  }
  return out;
}

const ports = (props: Record<string, Json>): string => {
  const protocol = String(props.IpProtocol ?? '');
  if (protocol === '-1') return 'all traffic';
  const from = props.FromPort;
  const to = props.ToPort;
  if (from === undefined && to === undefined) return protocol;
  return from === to || to === undefined ? `${protocol} ${from}` : `${protocol} ${from}-${to}`;
};

/** CDK adds this rule to every security group that doesn't turn `allowAllOutbound` off. */
const isDefaultEgress = (rule: Record<string, Json>) => rule.CidrIp === '0.0.0.0/0' && String(rule.IpProtocol) === '-1';

/** The ends of a rule's peer: another security group, or the address range or prefix list. */
function peerOf(rule: Record<string, Json>, scope: Scope, keys: readonly string[]): EffectEnd {
  for (const key of keys) if (rule[key] !== undefined) return endOf(rule[key], scope);
  return NOTHING;
}

/**
 * Reads the Grants, Integrations and Network rules the templates of an app produce (ADR 0012), resolved to construct paths,
 * and the references that cross from one Stack's template to another's through `Fn::ImportValue` and `Export`.
 */
export function templateEffects(templates: readonly EffectTemplate[]): { effects: Effect[]; importRefs: ImportRef[] } {
  const pathsOf = templates.map((t) => {
    const map = new Map<string, string>();
    for (const [id, r] of Object.entries(t.Resources ?? {})) {
      const path = r.Metadata?.['aws:cdk:path'];
      if (typeof path === 'string') map.set(id, path);
    }
    return map;
  });
  const exports = new Map<string, { path: string; template: EffectTemplate }>();
  templates.forEach((template, i) => {
    for (const output of Object.values(template.Outputs ?? {})) {
      const name = output.Export?.Name;
      const id = [...idsIn(output.Value)].find((id) => pathsOf[i]!.has(id));
      if (typeof name === 'string' && id !== undefined) exports.set(name, { path: pathsOf[i]!.get(id)!, template });
    }
  });

  const effects: Effect[] = [];
  const importRefs = new Map<string, ImportRef>();
  templates.forEach((template, i) => {
    const pathOf = pathsOf[i]!;
    const scope: Scope = { pathOf, exports };
    const resources = Object.entries(template.Resources ?? {}).flatMap(([id, r]) => {
      const path = pathOf.get(id);
      return path === undefined ? [] : [{ id, path, type: r.Type ?? '', props: r.Properties ?? {} }];
    });
    const principals = (props: Record<string, Json>): EffectEnd => {
      const paths = new Set<string>();
      const text = ['Roles', 'Users', 'Groups']
        .map((k) => flatten(props[k], scope, paths))
        .filter(Boolean)
        .join(', ');
      return { paths: [...paths], text };
    };
    // A managed policy a role lists in `ManagedPolicyArns` is attached to that role, even when it names no role itself.
    const attachedTo = new Map<string, string[]>();
    for (const r of resources) {
      if (r.type !== 'AWS::IAM::Role') continue;
      for (const id of idsIn(r.props.ManagedPolicyArns))
        (attachedTo.get(id) ?? attachedTo.set(id, []).get(id)!).push(r.path);
    }

    for (const r of resources) {
      const { props } = r;
      switch (r.type) {
        case 'AWS::IAM::Policy':
        case 'AWS::IAM::ManagedPolicy': {
          const named = principals(props);
          const roles = attachedTo.get(r.id) ?? [];
          const source: EffectEnd = {
            paths: [...new Set([...named.paths, ...roles])],
            text: [named.text, ...roles.map((p) => `{${p}}`)].filter(Boolean).join(', '),
          };
          effects.push(...grantsOf(r.path, props.PolicyDocument, source, scope));
          break;
        }
        case 'AWS::IAM::Role':
          for (const inline of list(props.Policies) as Record<string, Json>[]) {
            effects.push(...grantsOf(r.path, inline.PolicyDocument, { paths: [r.path], text: `{${r.path}}` }, scope));
          }
          break;
        case 'AWS::Lambda::EventSourceMapping':
          effects.push({
            kind: 'integration',
            at: r.path,
            source: endOf(props.EventSourceArn, scope),
            target: endOf(props.FunctionName, scope),
            detail: 'event source mapping',
          });
          break;
        case 'AWS::SNS::Subscription':
          effects.push({
            kind: 'integration',
            at: r.path,
            source: endOf(props.TopicArn, scope),
            target: endOf(props.Endpoint, scope),
            detail: `subscription (${flatten(props.Protocol, scope, new Set())})`,
          });
          break;
        case 'AWS::Events::Rule':
          for (const target of list(props.Targets) as Record<string, Json>[]) {
            effects.push({
              kind: 'integration',
              at: r.path,
              source: { paths: [r.path], text: `{${r.path}}` },
              target: endOf(target.Arn, scope),
              detail: 'rule target',
            });
          }
          break;
        case 'AWS::EC2::SecurityGroupIngress':
          effects.push({
            kind: 'network',
            at: r.path,
            source: peerOf(props, scope, ['SourceSecurityGroupId', 'CidrIp', 'CidrIpv6', 'SourcePrefixListId']),
            target: endOf(props.GroupId, scope),
            detail: ports(props),
          });
          break;
        case 'AWS::EC2::SecurityGroupEgress':
          effects.push({
            kind: 'network',
            at: r.path,
            source: endOf(props.GroupId, scope),
            target: peerOf(props, scope, [
              'DestinationSecurityGroupId',
              'CidrIp',
              'CidrIpv6',
              'DestinationPrefixListId',
            ]),
            detail: ports(props),
          });
          break;
        case 'AWS::EC2::SecurityGroup': {
          const self: EffectEnd = { paths: [r.path], text: `{${r.path}}` };
          for (const rule of list(props.SecurityGroupIngress) as Record<string, Json>[]) {
            effects.push({
              kind: 'network',
              at: r.path,
              source: peerOf(rule, scope, ['SourceSecurityGroupId', 'CidrIp', 'CidrIpv6', 'SourcePrefixListId']),
              target: self,
              detail: ports(rule),
            });
          }
          for (const rule of list(props.SecurityGroupEgress) as Record<string, Json>[]) {
            if (isDefaultEgress(rule)) continue;
            effects.push({
              kind: 'network',
              at: r.path,
              source: self,
              target: peerOf(rule, scope, [
                'DestinationSecurityGroupId',
                'CidrIp',
                'CidrIpv6',
                'DestinationPrefixListId',
              ]),
              detail: ports(rule),
            });
          }
          break;
        }
      }

      // Anything this resource reads from another Stack's export, other than permissions, which are Grants.
      for (const [prop, value] of Object.entries(props)) {
        if (prop === 'PolicyDocument' || prop === 'Policies') continue;
        for (const name of importsIn(value)) {
          const exported = exports.get(name);
          if (!exported || exported.template === template || exported.path === r.path) continue;
          importRefs.set(`${r.path}\0${exported.path}\0${prop}`, { from: r.path, to: exported.path, prop });
        }
      }
    }
  });
  return { effects, importRefs: [...importRefs.values()] };
}

/** The export names a value imports. */
function importsIn(value: Json, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => importsIn(v, out));
  else if (typeof value === 'object' && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      if (key === 'Fn::ImportValue' && typeof inner === 'string') out.push(inner);
      else importsIn(inner, out);
    }
  }
  return out;
}
