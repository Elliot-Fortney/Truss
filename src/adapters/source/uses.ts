// Finds where the app's code uses a name, with the TypeScript language service's find-references, over the app's files as given.
import ts from '@typescript/typescript6';
import type { FileSet, SourceUse } from '../../core/ports.ts';

const ROOT = '/app/';

/** A language service over `files` alone: names declared and used among them resolve, whatever they import from elsewhere does not. */
export function languageServiceOver(files: FileSet): ts.LanguageService {
  const has = (name: string) => name.startsWith(ROOT) && files.has(name.slice(ROOT.length));
  const text = (name: string) => files.get(name.slice(ROOT.length));
  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...files.keys()].map((f) => ROOT + f),
    getScriptVersion: () => '1',
    getScriptSnapshot: (name) => (has(name) ? ts.ScriptSnapshot.fromString(text(name)!) : undefined),
    getCurrentDirectory: () => ROOT,
    getCompilationSettings: () => ({ target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, noLib: true, allowJs: false }),
    getDefaultLibFileName: () => ROOT + 'lib.d.ts',
    fileExists: has,
    readFile: (name) => (has(name) ? text(name) : undefined),
    directoryExists: (dir) => dir === '/' || (dir + '/').startsWith(ROOT),
  };
  return ts.createLanguageService(host, ts.createDocumentRegistry());
}

/** Every reference to the symbol declared at `position` of `file`, as offsets into the files; the declaration itself and writes included. */
export function referencesTo(service: ts.LanguageService, file: string, position: number): Array<{ file: string; start: number; end: number }> {
  const found = service.findReferences(ROOT + file, position) ?? [];
  return found.flatMap((symbol) => symbol.references.map((r) => ({ file: r.fileName.slice(ROOT.length), start: r.textSpan.start, end: r.textSpan.start + r.textSpan.length })));
}

/** Where in `files` an offset is, with the line of code it is on. */
export function useAt(files: FileSet, file: string, offset: number): SourceUse {
  const text = files.get(file) ?? '';
  const before = text.slice(0, offset);
  const lineStart = before.lastIndexOf('\n') + 1;
  const lineEnd = text.indexOf('\n', offset);
  return { file, line: before.split('\n').length, col: offset - lineStart + 1, text: text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd).trim() };
}
