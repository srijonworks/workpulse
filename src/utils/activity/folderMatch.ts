// Folder matching shared by the server readers and the page. Case-insensitive and slash-agnostic.

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** True when `cwd` is `folder` or inside it. Separator-bounded. */
export function isUnderFolder(cwd: string, folder: string): boolean {
  const c = norm(cwd);
  const f = norm(folder);
  return c === f || c.startsWith(`${f}/`);
}

/** The listed folder that contains `cwd`; when listed folders nest, the deepest one. */
export function deepestFolder(cwd: string, folders: string[]): string | null {
  let best: string | null = null;
  for (const f of folders) {
    if (isUnderFolder(cwd, f) && (best === null || norm(f).length > norm(best).length)) best = f;
  }
  return best;
}
