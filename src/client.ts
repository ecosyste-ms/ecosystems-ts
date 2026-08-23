import createClient, { type Client } from "openapi-fetch";
import type { PackageURL } from "packageurl-js";
import { EcosystemsError, errorDetail, networkError, statusError } from "./errors.js";
import type { paths as AdvisoriesPaths } from "./generated/advisories.js";
import type { paths as CommitsPaths } from "./generated/commits.js";
import type { paths as IssuesPaths } from "./generated/issues.js";
import type { paths as PackagesPaths } from "./generated/packages.js";
import type { paths as ReposPaths } from "./generated/repos.js";
import { DEFAULT_SERVERS, type ServiceName } from "./generated/servers.js";
import { createEcosystemsFetch, type Identity } from "./http.js";
import {
  DEFAULT_MAX_PAGES,
  DEFAULT_PER_PAGE,
  followLinkedPages,
  pageCapMessage,
  paginateLinked,
  perPageForCap,
} from "./paginate.js";
import { purlToName, purlToRegistry } from "./purl.js";
import type { RateLimit } from "./ratelimit.js";
import { drain, type FetchLike, type RetryOptions } from "./retry.js";
import type * as T from "./types.js";

/** Server-side cap on PURLs per bulk lookup, declared as `maxItems: 100` in the spec. */
export const MAX_BULK_LOOKUP_SIZE = 100;

/** Deadline for one HTTP request, including its retries. Matches Go's `http.Client.Timeout`. */
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface EcosystemsClientOptions extends Identity {
  /**
   * PURLs per bulk-lookup request. Values `<= 0` or above {@link MAX_BULK_LOOKUP_SIZE}
   * fall back to the maximum. Lower it when the server rejects full-size batches under
   * load -- which happens independently of the documented limit.
   */
  batchSize?: number;
  /**
   * Deadline for one HTTP request, including its retries. `0` disables.
   *
   * Every bulk batch and every followed page gets its own budget, as in Go. For a
   * deadline over a whole operation, pass `{ signal: AbortSignal.timeout(ms) }` to the
   * method -- the analogue of handing Go a `context.WithTimeout`.
   */
  timeoutMs?: number;
  /** Hard ceiling on pages followed by any one paginating call. */
  maxPages?: number;
  /** Retry tuning, or `false` to disable retries entirely. */
  retry?: RetryOptions | false;
  /** Underlying fetch. Useful for tests and for custom agents/proxies. */
  fetch?: typeof globalThis.fetch;
  /** Per-service base URL overrides. Defaults come from each spec's `servers[0].url`. */
  servers?: Partial<Record<ServiceName, string>>;
}

/** Per-call options. `signal` is the analogue of Go's `context.Context`. */
export interface RequestOptions {
  signal?: AbortSignal | undefined;
}

/** One bulk-lookup batch that failed, carrying its inputs so the caller can retry them. */
export interface BulkLookupFailure {
  /** The PURLs sent in this batch. Retry with `failures.flatMap((f) => f.purls)`. */
  purls: string[];
  error: EcosystemsError;
}

/** The outcome of a {@link EcosystemsClient.bulkLookup}: what resolved, and what did not. */
export interface BulkLookupResult {
  /** Packages that came back, keyed by the PURL the API echoed. */
  results: Map<string, T.PackageWithRegistry>;
  /** Empty when every batch succeeded. */
  failures: BulkLookupFailure[];
}

interface CallResult<D> {
  data?: D | undefined;
  error?: unknown;
  response: Response;
}

/**
 * Client for the ecosyste.ms APIs.
 *
 * Wraps five services (packages, repos, advisories, commits, issues) over one shared
 * fetch, so identity, retries, and rate-limit capture are uniform across all of them.
 *
 * The generated clients are exposed as {@link packages}, {@link repos} etc. for the many
 * endpoints this facade does not wrap.
 */
export class EcosystemsClient {
  readonly packages: Client<PackagesPaths>;
  readonly repos: Client<ReposPaths>;
  readonly advisories: Client<AdvisoriesPaths>;
  readonly commits: Client<CommitsPaths>;
  readonly issues: Client<IssuesPaths>;

  readonly #fetch: FetchLike;
  readonly #batchSize: number;
  readonly #maxPages: number;
  #rateLimit: RateLimit | null = null;

  constructor(options: EcosystemsClientOptions) {
    if (!options.userAgent) {
      throw new EcosystemsError("userAgent is required");
    }

    this.#batchSize =
      !options.batchSize || options.batchSize <= 0 || options.batchSize > MAX_BULK_LOOKUP_SIZE
        ? MAX_BULK_LOOKUP_SIZE
        : options.batchSize;
    // Non-positive is meaningless here and would fail every paginating call without
    // issuing a request, so it falls back to the default -- the same shape as batchSize.
    this.#maxPages =
      !options.maxPages || options.maxPages <= 0 ? DEFAULT_MAX_PAGES : options.maxPages;

    this.#fetch = createEcosystemsFetch({
      identity: {
        userAgent: options.userAgent,
        from: options.from,
        apiKey: options.apiKey,
      },
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      retry: options.retry,
      fetch: options.fetch,
      onResponse: (rateLimit) => {
        if (rateLimit) this.#rateLimit = rateLimit;
      },
    });

    const server = (name: ServiceName) => options.servers?.[name] ?? DEFAULT_SERVERS[name];
    const make = <P extends object>(name: ServiceName): Client<P> =>
      createClient<P>({ baseUrl: server(name), fetch: this.#fetch });

    this.packages = make<PackagesPaths>("packages");
    this.repos = make<ReposPaths>("repos");
    this.advisories = make<AdvisoriesPaths>("advisories");
    this.commits = make<CommitsPaths>("commits");
    this.issues = make<IssuesPaths>("issues");
  }

  /**
   * Rate-limit headers from the most recent response, or null if none seen.
   *
   * Read-only reporting. See {@link RateLimit} -- these values are CDN-cacheable and must
   * not drive control flow.
   */
  get rateLimit(): RateLimit | null {
    return this.#rateLimit;
  }

  // -- internals -------------------------------------------------------------

  /** Runs one network operation, turning any thrown transport error into ours. */
  async #call<R>(what: string, run: () => Promise<R>): Promise<R> {
    try {
      return await run();
    } catch (err) {
      throw networkError(what, err);
    }
  }

  /** 404 -> null; other non-2xx -> throw. Mirrors every Go wrapper's status handling. */
  #one<D>(what: string, result: CallResult<D>): D | null {
    if (result.response.status === 404) return null;
    if (!result.response.ok) {
      throw statusError(what, result.response, errorDetail(result.error), this.#rateLimit);
    }
    return result.data ?? null;
  }

  /** As {@link #one}, but 404 and an absent body both yield an empty list (Go's nil slice). */
  #list<D>(what: string, result: CallResult<D[]>): D[] {
    if (result.response.status === 404) return [];
    if (!result.response.ok) {
      throw statusError(what, result.response, errorDetail(result.error), this.#rateLimit);
    }
    return result.data ?? [];
  }

  /**
   * Fetches an opaque `Link`-header URL.
   *
   * Goes around the generated client deliberately -- the next-page URL is opaque and has
   * no place in the typed path table. Identity headers are applied by the shared fetch,
   * so they cannot drift from the main request path.
   */
  #getPage = async <D>(
    url: string,
    signal?: AbortSignal,
  ): Promise<{ data: D[]; response: Response }> => {
    const what = `get ${url}`;
    // Transport and decode failures are wrapped here, not left to escape as a bare
    // `TypeError: fetch failed`. Every error out of this SDK is an EcosystemsError, and
    // a page fetch is the one path where that was previously not true.
    const response = await this.#call(what, () =>
      this.#fetch(new Request(url, { method: "GET", signal })),
    );

    if (!response.ok) {
      // Release the socket before unwinding; an undisturbed body keeps the connection
      // checked out of undici's pool until GC.
      await drain(response);
      throw statusError(what, response, undefined, this.#rateLimit);
    }

    const data = await this.#call(what, () => response.json());
    if (!Array.isArray(data)) {
      // A 200 carrying an object rather than a page (an error envelope, a gateway page)
      // would otherwise be concatenated in as a single bogus element.
      throw new EcosystemsError(`${what} returned ${typeof data}, expected an array`, {
        status: response.status,
        url,
      });
    }
    return { data: data as D[], response };
  };

  /**
   * Runs one request and returns a single object, or null when the API says 404.
   *
   * Takes the operation label once, for both the transport failure and the status
   * failure -- writing it twice let the two drift apart.
   */
  async #single<D>(
    what: string,
    run: (init: { signal?: AbortSignal | undefined }) => Promise<CallResult<D>>,
    signal?: AbortSignal,
  ): Promise<D | null> {
    return this.#one(what, await this.#call(what, () => run({ signal })));
  }

  /** Runs one request and follows `Link: rel="next"` from it, accumulating results. */
  async #collection<D>(
    what: string,
    run: (init: { signal?: AbortSignal | undefined }) => Promise<CallResult<D[]>>,
    maxItems = 0,
    signal?: AbortSignal,
  ): Promise<D[]> {
    const result = await this.#call(what, () => run({ signal }));
    return followLinkedPages<D>({
      first: this.#list(what, result),
      response: result.response,
      maxItems,
      maxPages: this.#maxPages,
      getPage: (url) => this.#getPage<D>(url, signal),
    });
  }

  // -- streaming pagination ---------------------------------------------------

  /**
   * Streams any `Link`-paginated endpoint, one page at a time.
   *
   * The accumulating methods below hold every page in memory and cap at `maxItems`; this
   * lets the caller stop whenever it likes. ecosystems-go has no equivalent -- it always
   * collects into a slice.
   *
   * Takes a builder returning an `openapi-fetch` result, so it works with the wrapped
   * endpoints and with the many that this facade does not wrap. Spread the `init` it
   * hands you, or `options.signal` will not reach the first request:
   *
   * ```ts
   * const pages = client.paginate((init) =>
   *   client.packages.GET("/registries/{registryName}/packages/{packageName}/dependent_packages", {
   *     ...init,
   *     params: { path: { registryName: "npmjs.org", packageName: "lodash" } },
   *   }),
   * );
   * for await (const page of pages) {
   *   for (const pkg of page) console.log(pkg.name);
   * }
   * ```
   *
   * The page ceiling still applies: exhausting it throws rather than ending the iteration
   * early, so a caller cannot mistake a truncated stream for a complete one.
   */
  async *paginate<D>(
    start: (init: { signal?: AbortSignal | undefined }) => Promise<CallResult<D[]>>,
    options: RequestOptions = {},
  ): AsyncGenerator<D[], void, undefined> {
    const { signal } = options;
    const result = await this.#call("paginate", () => start({ signal }));
    if (result.response.status === 404) return;

    const first = this.#list("paginate", result);
    yield* paginateLinked<D>({
      first,
      response: result.response,
      maxPages: this.#maxPages,
      getPage: (url) => this.#getPage<D>(url, signal),
    });
  }

  // -- packages --------------------------------------------------------------

  /**
   * Looks up multiple packages by PURL, keyed by the PURL the API echoes back.
   *
   * Requests are batched at {@link MAX_BULK_LOOKUP_SIZE} (or the configured `batchSize`)
   * and issued sequentially. Unmatched PURLs are simply absent from `results`, which is
   * why that is a Map rather than an array.
   *
   * A failed batch lands in `failures` with the PURLs it was carrying, rather than
   * failing the call. **Nothing throws, even when every batch fails, so check
   * `failures`.** An aborted `signal` is the exception: cancelling is the caller's own
   * intent, not a failure of the service.
   *
   * NOTE that the server canonicalises: a versioned or differently-cased input comes back
   * as the package-level PURL, so `pkg:npm/lodash@4.17.21` is keyed `pkg:npm/lodash`, and
   * several inputs can collapse onto one entry. Look results up by the canonical PURL, or
   * use {@link lookup} for a single package, which sidesteps the keying entirely.
   */
  async bulkLookup(purls: string[], options: RequestOptions = {}): Promise<BulkLookupResult> {
    const results = new Map<string, T.PackageWithRegistry>();
    const failures: BulkLookupFailure[] = [];

    for (const batch of this.#batches(purls)) {
      try {
        for (const pkg of await this.#bulk(batch, options.signal)) {
          results.set(pkg.purl, pkg);
        }
      } catch (err) {
        // Cancellation is the caller's decision, not a batch that went wrong: surface it
        // rather than burying it in `failures` and continuing to issue the rest.
        if (options.signal?.aborted) throw err;
        failures.push({
          purls: batch,
          error: err instanceof EcosystemsError ? err : new EcosystemsError(String(err)),
        });
      }
    }

    return { results, failures };
  }

  /**
   * Looks up a single package by PURL.
   *
   * Reads the record straight off the response rather than through {@link bulkLookup}'s
   * map: we asked about exactly one PURL, so any record returned is that package. Keying
   * by the request PURL would return null for `pkg:npm/lodash@4.17.21`, which the API
   * answers with a record whose `purl` is `pkg:npm/lodash`.
   */
  async lookup(
    purl: string,
    options: RequestOptions = {},
  ): Promise<T.PackageWithRegistry | null> {
    const [found] = await this.#bulk([purl], options.signal);
    return found ?? null;
  }

  /** One bulk-lookup request. Shared by {@link bulkLookup} and {@link lookup}. */
  async #bulk(batch: string[], signal?: AbortSignal): Promise<T.PackageWithRegistry[]> {
    const what = "bulk lookup";
    const result = await this.#call(what, () =>
      this.packages.POST("/packages/bulk_lookup", { body: { purls: batch }, signal }),
    );
    // Not `#list`: a 404 here is a real failure, not an empty result set.
    if (!result.response.ok) {
      throw statusError(what, result.response, errorDetail(result.error), this.#rateLimit);
    }
    return result.data ?? [];
  }

  *#batches(purls: string[]): Generator<string[]> {
    for (let i = 0; i < purls.length; i += this.#batchSize) {
      yield purls.slice(i, i + this.#batchSize);
    }
  }

  /** Looks up a package by registry and name. */
  lookupByRegistryAndName(
    registry: string,
    name: string,
    options: RequestOptions = {},
  ): Promise<T.Package | null> {
    return this.#single(
      "lookup package",
      (init) =>
        this.packages.GET("/registries/{registryName}/packages/{packageName}", {
          ...init,
          params: { path: { registryName: registry, packageName: name } },
        }),
      options.signal,
    );
  }

  /** Looks up package records matching a PURL. Follows `Link` pagination. */
  lookupPackagesByPurl(
    purl: string,
    options: RequestOptions = {},
  ): Promise<T.PackageWithRegistry[]> {
    return this.#collection(
      "lookup packages by purl",
      (init) => this.packages.GET("/packages/lookup", { ...init, params: { query: { purl } } }),
      0,
      options.signal,
    );
  }

  /**
   * Looks up package records published from a source repository.
   *
   * `maxItems <= 0` means unlimited (subject to the page ceiling). Note that this
   * endpoint does not declare `per_page` in its spec even though it honours it, so the
   * first page is always 100 rows and any smaller `maxItems` truncates client-side --
   * identical to ecosystems-go. See the review doc, section 8.1.
   */
  lookupPackagesByRepositoryUrl(
    repositoryUrl: string,
    maxItems = 0,
    options: RequestOptions = {},
  ): Promise<T.PackageWithRegistry[]> {
    return this.#collection(
      "lookup packages by repository url",
      (init) =>
        this.packages.GET("/packages/lookup", {
          ...init,
          params: { query: { repository_url: repositoryUrl } },
        }),
      maxItems,
      options.signal,
    );
  }

  /** Gets a specific version of a package. */
  getVersion(
    registry: string,
    name: string,
    version: string,
    options: RequestOptions = {},
  ): Promise<T.VersionWithDependencies | null> {
    return this.#single(
      "get version",
      (init) =>
        this.packages.GET(
          "/registries/{registryName}/packages/{packageName}/versions/{versionNumber}",
          {
            ...init,
            params: {
              path: { registryName: registry, packageName: name, versionNumber: version },
            },
          },
        ),
      options.signal,
    );
  }

  /**
   * Gets just the version numbers of a package -- one unpaginated request.
   *
   * Prefer this over {@link getAllVersions} when the numbers are all you need: that one
   * returns full {@link T.Version} objects and pages, which over a whole-registry crawl is
   * a large multiple of the bytes for fields the caller discards.
   *
   * An unknown package yields `[]`, as with every list wrapper here.
   */
  getVersionNumbers(
    registry: string,
    name: string,
    options: RequestOptions = {},
  ): Promise<string[]> {
    const what = "get version numbers";
    return this.#call(what, async () =>
      this.#list(
        what,
        await this.packages.GET(
          "/registries/{registryName}/packages/{packageName}/version_numbers",
          {
            signal: options.signal,
            params: { path: { registryName: registry, packageName: name } },
          },
        ),
      ),
    );
  }

  /**
   * Gets every version of a package.
   *
   * DIVERGENCE FROM ecosystems-go: Go's `GetAllVersions` pages until a short page with no
   * ceiling at all, so a pathological package loops until the context deadline. Every
   * other paginating method in that library caps at 20 pages and errors. We apply the
   * same ceiling here for consistency; this looks like an oversight upstream rather than
   * a deliberate choice.
   */
  async getAllVersions(
    registry: string,
    name: string,
    options: RequestOptions = {},
  ): Promise<T.Version[]> {
    const what = "get versions";
    const all: T.Version[] = [];

    for (let page = 1; page <= this.#maxPages; page++) {
      const result = await this.#call(what, () =>
        this.packages.GET("/registries/{registryName}/packages/{packageName}/versions", {
          signal: options.signal,
          params: {
            path: { registryName: registry, packageName: name },
            query: { page, per_page: DEFAULT_PER_PAGE },
          },
        }),
      );

      const batch = this.#list(what, result);
      all.push(...batch);
      if (batch.length < DEFAULT_PER_PAGE) return all;
    }

    throw new EcosystemsError(pageCapMessage(this.#maxPages));
  }

  /** Returns packages that depend on `registry`/`name`. Follows `Link` pagination. */
  getDependentPackages(
    registry: string,
    name: string,
    maxItems = 0,
    options: RequestOptions = {},
  ): Promise<T.Package[]> {
    return this.#collection(
      "get dependent packages",
      (init) =>
        this.packages.GET(
          "/registries/{registryName}/packages/{packageName}/dependent_packages",
          {
            ...init,
            params: {
              path: { registryName: registry, packageName: name },
              query: { per_page: perPageForCap(maxItems) },
            },
          },
        ),
      maxItems,
      options.signal,
    );
  }

  /**
   * Lists critical packages across every registry. Follows `Link` pagination.
   *
   * ~9,600 packages as of 2026-08-23, so an uncapped call is ~96 requests. Not to be
   * confused with `/critical` (`getCriticalPackages`), a different endpoint.
   */
  listCriticalPackages(
    maxItems = 0,
    options: RequestOptions = {},
  ): Promise<T.PackageWithRegistry[]> {
    return this.#collection(
      "list critical packages",
      (init) =>
        this.packages.GET("/packages/critical", {
          ...init,
          params: { query: { per_page: perPageForCap(maxItems) } },
        }),
      maxItems,
      options.signal,
    );
  }

  /** Returns all available registries. 109 as of 2026-08-16. */
  async listRegistries(options: RequestOptions = {}): Promise<T.Registry[]> {
    const what = "list registries";
    const result = await this.#call(what, () =>
      this.packages.GET("/registries", { signal: options.signal }),
    );
    return this.#list(what, result);
  }

  // -- repos / advisories / commits / issues ---------------------------------

  /** Looks up a repository by URL. */
  getRepository(url: string, options: RequestOptions = {}): Promise<T.Repository | null> {
    return this.#single(
      "lookup repository",
      (init) => this.repos.GET("/repositories/lookup", { ...init, params: { query: { url } } }),
      options.signal,
    );
  }

  /** Returns advisories associated with a source repository. Follows `Link` pagination. */
  getAdvisoriesByRepoUrl(
    repositoryUrl: string,
    maxItems = 0,
    options: RequestOptions = {},
  ): Promise<T.Advisory[]> {
    return this.#collection(
      "get advisories by repository url",
      (init) =>
        this.advisories.GET("/advisories", {
          ...init,
          params: {
            query: { repository_url: repositoryUrl, per_page: perPageForCap(maxItems) },
          },
        }),
      maxItems,
      options.signal,
    );
  }

  /** Looks up commit summary metadata for a source repository. */
  getCommitsSummary(
    repositoryUrl: string,
    options: RequestOptions = {},
  ): Promise<T.CommitsSummary | null> {
    return this.#single(
      "get commits summary",
      (init) =>
        this.commits.GET("/repositories/lookup", {
          ...init,
          params: { query: { url: repositoryUrl } },
        }),
      options.signal,
    );
  }

  /** Looks up issue and pull-request summary metadata for a source repository. */
  getIssuesSummary(
    repositoryUrl: string,
    options: RequestOptions = {},
  ): Promise<T.IssuesSummary | null> {
    return this.#single(
      "get issues summary",
      (init) =>
        this.issues.GET("/repositories/lookup", {
          ...init,
          params: { query: { url: repositoryUrl } },
        }),
      options.signal,
    );
  }

  // -- PURL-flavoured wrappers ----------------------------------------------

  /** Looks up a package by PURL via the registry/name endpoint (returns full `Package`). */
  async lookupPurl(purl: PackageURL, options: RequestOptions = {}): Promise<T.Package | null> {
    const registry = this.#registryFor(purl);
    return this.lookupByRegistryAndName(registry, purlToName(purl), options);
  }

  /** Gets a specific version using a PURL. Requires the PURL to carry a version. */
  async getVersionPurl(
    purl: PackageURL,
    options: RequestOptions = {},
  ): Promise<T.VersionWithDependencies | null> {
    if (!purl.version) {
      throw new EcosystemsError("PURL has no version");
    }
    const registry = this.#registryFor(purl);
    return this.getVersion(registry, purlToName(purl), purl.version, options);
  }

  /** Gets all versions for a package using a PURL. */
  async getAllVersionsPurl(
    purl: PackageURL,
    options: RequestOptions = {},
  ): Promise<T.Version[]> {
    const registry = this.#registryFor(purl);
    return this.getAllVersions(registry, purlToName(purl), options);
  }

  #registryFor(purl: PackageURL): string {
    const registry = purlToRegistry(purl);
    if (registry === null) {
      throw new EcosystemsError(`unsupported PURL type: ${purl.type}`);
    }
    return registry;
  }
}

/** Convenience factory. `new EcosystemsClient(...)` is equivalent. */
export function createEcosystemsClient(options: EcosystemsClientOptions): EcosystemsClient {
  return new EcosystemsClient(options);
}
