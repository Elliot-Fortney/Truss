import { useEffect, useRef, useState } from 'react';
import type { SearchHit } from '../core/catalog.ts';
import type { SearchOutcome } from './use-view.ts';

/** What a palette entry puts on the drag, so a drop on a Stack knows which construct it is. */
export const CONSTRUCT_DRAG = 'application/x-truss-construct';

/** The line under a construct's name: where it comes from and what it builds, so two like-named constructs can be told apart. */
export function hitDetail(hit: SearchHit): string {
  return [hit.service, hit.cfnType, hit.library === 'aws-cdk-lib' ? undefined : hit.library].filter(Boolean).join(' · ');
}

/** The palette: every construct the app's installed libraries offer, searched by name, service or CloudFormation type. */
export function Palette({ search, scope, onAdd }: { search(query: string): Promise<SearchOutcome>; scope: string | undefined; onAdd(hit: SearchHit): void }) {
  const [query, setQuery] = useState('');
  const [outcome, setOutcome] = useState<SearchOutcome>();
  const asked = useRef(0);

  useEffect(() => {
    // Answers can arrive out of order, so only the latest question's answer is shown.
    const mine = ++asked.current;
    void search(query).then((result) => {
      if (asked.current === mine) setOutcome(result);
    });
  }, [query, search]);

  return (
    <aside className="palette" aria-label="Palette">
      <input type="search" placeholder="Search constructs, services, AWS::…" aria-label="Search constructs" value={query} onChange={(e) => setQuery(e.target.value)} />
      {outcome && !outcome.ok ? <p className="palette-empty">{outcome.reason}</p> : null}
      {outcome?.ok && outcome.hits.length === 0 ? <p className="palette-empty">No constructs match.</p> : null}
      {outcome?.ok ? (
        <ul>
          {outcome.hits.map((hit) => (
            <li
              key={hit.fqn}
              className="palette-hit"
              title={hit.fqn}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(CONSTRUCT_DRAG, hit.fqn);
                e.dataTransfer.effectAllowed = 'copy';
              }}
            >
              <span className="palette-name">
                {hit.displayName ?? hit.name}
                {hit.deprecated ? <span className="palette-deprecated"> deprecated</span> : null}
              </span>
              <span className={`tier tier-${hit.tier}`}>{hit.tier}</span>
              <button type="button" className="palette-add" disabled={scope === undefined} title={scope === undefined ? 'Select a Stack to add to, or drag this onto one' : `Add to ${scope}`} aria-label={`Add ${hit.displayName ?? hit.name}`} onClick={() => onAdd(hit)}>
                +
              </button>
              <span className="palette-detail">{hitDetail(hit)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </aside>
  );
}
