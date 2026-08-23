import { EcosystemsError } from "./errors.js";

export const DEFAULT_PER_PAGE = 100;

/**
 * Hard ceiling on pages followed in one call.
 *
 * Exceeding it throws rather than truncating silently -- a silently short dependency or
 * advisory list is a correctness bug in the caller, not a smaller result. Same decision
 * as ecosystems-go.
 *
 * DIVERGENCE FROM ecosystems-go: Go caps at 20 pages (2,000 items), which real
 * collections exceed -- `/packages/critical` alone is ~96 pages. A ceiling that ordinary
 * data trips is a functional limit dressed as a safety net, and it fails only after
 * doing 20 pages of work. This guards the thing that actually warrants a guard -- a
 * server looping `rel="next"` forever -- and leaves legitimate crawls alone. A call
 * bounded by `maxItems` is not subject to it at all; see {@link pageBudget}.
 */
export const DEFAULT_MAX_PAGES = 1000;

/**
 * Extracts the `rel="next"` URL from an RFC 8288 `Link` header.
 *
 * The `Link` header is not declared in any ecosyste.ms OpenAPI spec, yet it drives all
 * pagination. Tolerates bare `rel=next`, ignores `rel=first`/`rel=last`, allows commas
 * inside the URL, and returns null on malformed input. Direct port of Go's `nextLink`.
 */
export function nextLink(header: string | null | undefined): string | null {
  if (!header) return null;

  let rest = header;
  let open = rest.indexOf("<");

  while (open !== -1) {
    rest = rest.slice(open + 1);
    const close = rest.indexOf(">");
    if (close === -1) return null; // unterminated

    const url = rest.slice(0, close);
    const after = rest.slice(close + 1);
    const nextOpen = after.indexOf("<");
    const params = nextOpen === -1 ? after : after.slice(0, nextOpen);

    if (params.includes('rel="next"') || params.includes("rel=next")) return url;

    rest = after;
    open = nextOpen;
  }

  return null;
}

/** Shrinks `per_page` when the caller wants fewer than a full page. */
export function perPageForCap(maxItems: number): number {
  return maxItems > 0 && maxItems < DEFAULT_PER_PAGE ? maxItems : DEFAULT_PER_PAGE;
}

/**
 * Pages one call may follow, given what the caller asked for.
 *
 * `maxPages` guards *unbounded* calls. A caller who passed `maxItems` has already bounded
 * the work, so the item cap wins where it is the larger of the two -- asking for 50,000
 * items should not fail at page 1,000 for a reason the caller never set.
 *
 * `perPage` is how many items a page actually holds, not what was requested: an endpoint
 * that honours `per_page` loosely, or a filtered collection returning half-full pages,
 * needs proportionally more pages to reach the same cap. Callers that only know the
 * requested size get the default, and {@link followLinkedPages} re-derives it per page.
 */
export function pageBudget(
  maxItems: number,
  maxPages: number,
  perPage: number = DEFAULT_PER_PAGE,
): number {
  if (maxItems <= 0) return maxPages;
  return Math.max(maxPages, Math.ceil(maxItems / perPage));
}

/** Truncates to `maxItems`; `maxItems <= 0` means unlimited. */
export function capItems<T>(items: T[], maxItems: number): { items: T[]; capped: boolean } {
  if (maxItems <= 0 || items.length <= maxItems) return { items, capped: false };
  return { items: items.slice(0, maxItems), capped: true };
}

/** True once we hold everything the caller asked for. `maxItems <= 0` is never satisfied. */
function satisfied(count: number, maxItems: number): boolean {
  return maxItems > 0 && count >= maxItems;
}

/**
 * The next page's URL, resolved against the response it came from.
 *
 * RFC 8288 permits a relative URI-reference. ecosyste.ms sends absolute URLs today
 * (checked), but a proxy rewriting them to `</api/v1/...>` would otherwise make
 * `new Request(next)` throw rather than paginate.
 */
export function nextPageUrl(response: Response): string | null {
  const next = nextLink(response.headers.get("link"));
  if (next === null || !response.url) return next;
  try {
    return new URL(next, response.url).toString();
  } catch {
    return next;
  }
}

/** One wording for the ceiling, so every paginating path points at the same lever. */
export function pageCapMessage(maxPages: number): string {
  return `pagination exceeded max pages ${maxPages} (raise the client's \`maxPages\` option)`;
}

export type PageFetcher<T> = (url: string) => Promise<{ data: T[]; response: Response }>;

export interface FollowOptions<T> {
  /** The already-fetched first page. */
  first: T[];
  /** The response that first page came from, for its `Link` header. */
  response: Response;
  /** Stop after this many items. `<= 0` means unlimited. */
  maxItems?: number;
  maxPages?: number;
  getPage: PageFetcher<T>;
}

/**
 * Follows `Link: rel="next"` from an initial response, accumulating results.
 *
 * Port of Go's `appendLinkedPages`. See `paginateLinked` for a streaming alternative that
 * avoids holding every page in memory.
 *
 * DIVERGENCE FROM ecosystems-go: Go stops only once a page overshoots `maxItems`, so a
 * request for exactly 25 items that the first page already satisfies still fetches a
 * second page and discards it -- and a 429 on that wasted page fails a call whose results
 * were already in hand. We stop as soon as the count is reached. Same results, one fewer
 * round-trip, one fewer way to fail.
 */
export async function followLinkedPages<T>(options: FollowOptions<T>): Promise<T[]> {
  const { first, response, maxItems = 0, maxPages = DEFAULT_MAX_PAGES, getPage } = options;
  // Recomputed per page rather than assumed: a budget derived from a full page would
  // still fail short of `maxItems` against an endpoint that returns half-full pages.
  // Empty pages never extend it -- that is the runaway case `maxPages` exists for.
  let budget = pageBudget(maxItems, maxPages, first.length || undefined);

  let { items: out } = capItems(first, maxItems);
  if (satisfied(out.length, maxItems)) return out;

  let next = nextPageUrl(response);

  for (let page = 1; next !== null && page < budget; page++) {
    const result = await getPage(next);
    ({ items: out } = capItems(out.concat(result.data), maxItems));
    if (satisfied(out.length, maxItems)) return out;

    if (result.data.length > 0) {
      budget = Math.max(budget, pageBudget(maxItems, maxPages, result.data.length));
    }
    next = nextPageUrl(result.response);
  }

  if (next !== null) {
    throw new EcosystemsError(pageCapMessage(budget), { url: next });
  }

  return out;
}

/**
 * Streaming form of {@link followLinkedPages}, yielding one page at a time.
 *
 * ecosystems-go has no equivalent -- it always accumulates into a slice. Async iteration
 * is the natural TypeScript shape and lets callers stop early without a page budget.
 */
export async function* paginateLinked<T>(
  options: Omit<FollowOptions<T>, "maxItems">,
): AsyncGenerator<T[], void, undefined> {
  const { first, response, maxPages = DEFAULT_MAX_PAGES, getPage } = options;

  yield first;
  let next = nextPageUrl(response);

  for (let page = 1; next !== null && page < maxPages; page++) {
    const result = await getPage(next);
    yield result.data;
    next = nextPageUrl(result.response);
  }

  if (next !== null) {
    throw new EcosystemsError(pageCapMessage(maxPages), { url: next });
  }
}
