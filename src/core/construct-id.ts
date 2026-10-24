import type { TreeNode } from './assembly.ts';

/** Shown, without blocking anything, whenever a Construct ID is changed: the new path is a different resource to CloudFormation. */
export const RENAME_NOTE = 'Changes the construct path: CloudFormation will replace this resource.';

/** How long a Construct ID the canvas will write can be. */
export const MAX_ID_LENGTH = 256;

/** CDK rewrites `/` in an ID to `--`, because `/` separates the parts of a path. */
const cdkId = (id: string) => id.replace(/\//g, '--');

/**
 * Why `id` can't be the Construct ID of a construct whose siblings have the IDs `siblings`, if it can't
 * (the `constructs` library's rules). Whether it is PascalCase is never checked: the code decides its own style.
 */
export function constructIdProblem(id: string, siblings: readonly string[]): string | undefined {
  if (id === '') return "A Construct ID can't be empty.";
  if (id.includes('/')) return "A Construct ID can't contain '/', which separates the parts of a construct path.";
  if (/[\r\n]/.test(id)) return "A Construct ID can't contain a newline.";
  const written = cdkId(id);
  if (siblings.some((s) => cdkId(s) === written)) return `A sibling already has the Construct ID "${written}".`;
  // CDK names the default child of a construct `Resource` or `Default`, and drops both from the logical ID, so the pair can't both exist.
  const partner = written === 'Resource' ? 'Default' : written === 'Default' ? 'Resource' : undefined;
  if (partner && siblings.includes(partner))
    return `"${written}" can't sit next to a sibling called "${partner}": CDK gives the two the same name in the template.`;
  return undefined;
}

/** The path of the construct that holds `path`; '' for the App root. */
export const parentPath = (path: string): string => path.slice(0, Math.max(path.lastIndexOf('/'), 0));

/** `path` with its last part, the Construct ID, replaced by `id`. */
export const withId = (path: string, id: string): string => (path.includes('/') ? `${parentPath(path)}/${id}` : id);

/** The Construct IDs of the other constructs under the parent of `path`, in the tree as it is. Empty when there is no such path. */
export function siblingIds(tree: TreeNode, path: string): string[] {
  const parent = parentPath(path);
  let node: TreeNode | undefined = tree;
  for (const part of parent === '' ? [] : parent.split('/')) node = node?.children.find((c) => c.id === part);
  const own = path.slice(parent === '' ? 0 : parent.length + 1);
  return node ? node.children.map((c) => c.id).filter((id) => id !== own) : [];
}
