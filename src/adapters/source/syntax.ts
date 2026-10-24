// Reading literal-ish expressions, shared by `analyse` (what the code says) and `plan` (what may be replaced).
import ts from '@typescript/typescript6';
import type { PropFacts } from '../../core/facts.ts';

export function isStringLike(n: ts.Node): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);
}

/** What a literal evaluates to, boxed so that `null` and `false` aren't mistaken for "not a literal". */
export function literalValue(n: ts.Expression): { value: string | number | boolean | null } | undefined {
  if (isStringLike(n)) return { value: n.text };
  if (ts.isNumericLiteral(n)) return { value: Number(n.text) };
  if (n.kind === ts.SyntaxKind.TrueKeyword) return { value: true };
  if (n.kind === ts.SyntaxKind.FalseKeyword) return { value: false };
  if (n.kind === ts.SyntaxKind.NullKeyword) return { value: null };
  if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(n.operand))
    return { value: -Number(n.operand.text) };
  return undefined;
}

/** The last identifier of `a.b.C`, when the chain is plain names. */
export function lastName(n: ts.Expression): string | undefined {
  return ts.isIdentifier(n)
    ? n.text
    : ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.name)
      ? n.name.text
      : undefined;
}

/** `s3.BucketEncryption.KMS_MANAGED` or `RemovalPolicy.DESTROY`: a name starting with a capital, then an upper-case member. */
export function memberOf(n: ts.Expression): PropFacts['member'] {
  if (!ts.isPropertyAccessExpression(n) || !ts.isIdentifier(n.name)) return undefined;
  const type = lastName(n.expression);
  return type && /^[A-Z]/.test(type) && /^[A-Z][A-Z0-9_]*$/.test(n.name.text) ? { type, name: n.name.text } : undefined;
}

const QUANTITIES: Record<string, 'Duration' | 'Size'> = { Duration: 'Duration', Size: 'Size' };

/** `cdk.Duration.seconds(30)` or `Size.mebibytes(512)`, with a plain number for an argument. */
export function quantityOf(n: ts.Expression): PropFacts['quantity'] {
  if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression) || n.arguments.length !== 1)
    return undefined;
  const type = QUANTITIES[lastName(n.expression.expression) ?? ''];
  const amount = literalValue(n.arguments[0]!);
  return type && typeof amount?.value === 'number'
    ? { type, unit: n.expression.name.text, amount: amount.value }
    : undefined;
}
