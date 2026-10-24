import { GENERIC_ICON, ICON_FILES } from '../core/icons.ts';
import genericUrl from '../../assets/tabler-icons/components.svg?url';

// The vendored AWS icons, by file name. Vite emits each one unmodified.
const awsUrls = import.meta.glob<string>('../../assets/aws-architecture-icons/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
});
const urlByFile = new Map(Object.entries(awsUrls).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1), url]));

/** The AWS icon for an icon id from the View, or undefined for the generic icon (and an id this build has no file for). */
function awsIconUrl(icon: string): string | undefined {
  const file = ICON_FILES[icon];
  return file ? urlByFile.get(file) : undefined;
}

export function NodeIcon({ icon, size }: { icon: string; size: number }) {
  const url = icon === GENERIC_ICON ? undefined : awsIconUrl(icon);
  if (url) return <img className="node-icon" src={url} width={size} height={size} alt="" draggable={false} />;
  // Tabler draws in `currentColor`, which an <img> can't pick up, so the SVG is a mask over a coloured box.
  return (
    <span
      className="node-icon generic"
      aria-hidden="true"
      style={{ width: size, height: size, maskImage: `url("${genericUrl}")`, WebkitMaskImage: `url("${genericUrl}")` }}
    />
  );
}
