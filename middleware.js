/* ============================================================
   Edge Middleware — client subdomain routing.

   Serves each client landing on its own subdomain
   (e.g. sanmi.thehagentic.com) by rewriting INTERNALLY to
   /clientes/<slug>/ — the visible URL does not change.

   Runs before the filesystem, so it works where the old
   vercel.json "rewrites" could not (a static /index.html
   shadowed them).

   Excluded via the matcher: /api/*, /assets/*, /_next/*,
   /conferencia-mexico-2026, favicon and any file with an
   extension. So the chat (/api/chat), leads (/api/lead),
   the conference page and the main site are untouched.
   ============================================================ */

import { next, rewrite } from '@vercel/edge';

// Add future clients here. The subdomain's first label is the slug,
// which maps to /clientes/<slug>/. Keeping it a Set makes adding a
// client a one-line change.
const CLIENT_SLUGS = new Set(['sanmi']);

// Hosts that must always pass through untouched (the main site).
const ROOT_HOSTS = new Set(['thehagentic.com', 'www.thehagentic.com']);

export const config = {
  matcher: ['/((?!api/|assets/|_next/|conferencia-mexico-2026|favicon\\.svg|.*\\.).*)'],
};

/**
 * Pure routing decision (kept separate so it can be unit-tested).
 * Returns the internal rewrite path, or null to pass through.
 */
export function resolveClientPath(host, pathname) {
  const h = (host || '').split(':')[0].toLowerCase();
  if (!h || ROOT_HOSTS.has(h) || !h.endsWith('.thehagentic.com')) return null;

  const slug = h.split('.')[0];
  if (!CLIENT_SLUGS.has(slug)) return null;

  const base = '/clientes/' + slug;
  if (pathname === base || pathname.startsWith(base + '/')) return null; // already mapped

  return base + (pathname === '/' ? '/' : pathname);
}

export default function middleware(request) {
  const url = new URL(request.url);
  const target = resolveClientPath(request.headers.get('host'), url.pathname);
  if (!target) return next();
  url.pathname = target;
  return rewrite(url);
}
