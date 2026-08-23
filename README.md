# ecosystems-ts

TypeScript client library for the [ecosyste.ms](https://ecosyste.ms) APIs. See the
[API documentation](https://ecosyste.ms/api) for details.

A port of [ecosystems-go](https://github.com/ecosyste-ms/ecosystems-go). Two runtime
dependencies:
[`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/) (6 kB) and
[`packageurl-js`](https://github.com/package-url/packageurl-js).

## Installation

```bash
npm install @ecosyste-ms/ecosystems-ts
```

Requires Node 20+, or any server-side runtime with `fetch` (Deno, Bun, Cloudflare
Workers).

Not browsers — the API hides the headers pagination depends on from cross-origin
scripts, so importing this in a browser build throws. Call it from your server.

## Usage

```ts
import { EcosystemsClient } from "@ecosyste-ms/ecosystems-ts";

// userAgent is required - identify your application
const client = new EcosystemsClient({ userAgent: "my-app/1.0" });

// Bulk lookup packages by PURL
const { results, failures } = await client.bulkLookup([
  "pkg:gem/rails",
  "pkg:npm/lodash",
  "pkg:pypi/requests",
]);

// Batches that failed, with the purls to retry
console.log(failures.flatMap((f) => f.purls));

for (const [purl, pkg] of results) {
  console.log(`${purl}: ${pkg.name} (${pkg.latest_release_number})`);
}

// Lookup a single package
const pkg = await client.lookup("pkg:gem/rake");
console.log(`rake has ${pkg?.versions_count} versions`);

// Get a specific version
const version = await client.getVersion("rubygems.org", "rake", "13.0.0");
console.log(`rake 13.0.0 integrity: ${version?.integrity}`);

// Get all versions
const versions = await client.getAllVersions("rubygems.org", "rake");
console.log(`rake has ${versions.length} versions`);

// Get just the version numbers - one request, no Version objects
const numbers = await client.getVersionNumbers("rubygems.org", "rake");

// Every critical package across all registries (~9,600 today, ~96 requests)
const critical = await client.listCriticalPackages();
```

`lookup` is the single-package counterpart to `bulkLookup`: same PURL vocabulary, one
request, one package. It takes a PURL string; `lookupPurl` takes a parsed `PackageURL`
(see [PURL Helpers](#purl-helpers)).

`bulkLookup` chunks its input at `batchSize` and sends the batches one after another, so
5,000 PURLs is 50 round-trips. A failed batch does not fail the call — it lands in
`failures` carrying its purls, so the other batches survive and you can retry the rest.
Nothing throws when every batch fails, so check `failures`.

Lookups that find nothing return `null` (or `[]` for lists) rather than throwing — "not
found" is a normal outcome for a lookup API, not an exception.

## PURL Helpers

```ts
import {
  parsePurl,
  purlToRegistry,
  purlToName,
} from "@ecosyste-ms/ecosystems-ts";

// Parse a PURL string (handles with or without the pkg: prefix)
const purl = parsePurl("gem/rails@7.0.0");

// Convert PURL to an ecosyste.ms registry name
purlToRegistry(purl); // "rubygems.org"

// Convert PURL to the ecosyste.ms package name format
purlToName(purl); // "rails"

// Lookup using a PURL directly
const pkg = await client.lookupPurl(purl);
const version = await client.getVersionPurl(purl);
const versions = await client.getAllVersionsPurl(purl);
```

The API speaks two vocabularies: bulk lookup takes PURLs, but the per-package endpoints
are `/registries/{registry}/packages/{name}` — and a registry name is not a PURL type.
These helpers bridge them. The mapping is generated weekly from `GET /registries` and
covers all 51 ecosystems it serves; `client.listRegistries()` is authoritative at runtime.

`purlToRegistry` returns `null` for types with no ecosyste.ms registry (`github`,
`generic`, `oci`, `rpm`, …) rather than a name that 404s. `deb` resolves by vendor —
`pkg:deb/ubuntu/curl` to the current Ubuntu LTS, `pkg:deb/debian/curl` to the current
Debian stable, anything else to `null`.

## Repository Metadata

```ts
const repoUrl = "https://github.com/rails/rails";

const repo = await client.getRepository(repoUrl);
const packages = await client.lookupPackagesByRepositoryUrl(repoUrl, 25);
const advisories = await client.getAdvisoriesByRepoUrl(repoUrl, 100);
const commits = await client.getCommitsSummary(repoUrl);
const issues = await client.getIssuesSummary(repoUrl);
const dependents = await client.getDependentPackages("rubygems.org", "rails", 30);
```

List methods follow `Link: rel="next"` pagination and stop at the requested item cap when
one is provided. Reaching the page ceiling **throws** rather than silently returning a
short list.

That ceiling (`maxPages`, default 1000) exists to stop a server looping `rel="next"`
forever, not to bound result size - whole-collection crawls like `listCriticalPackages()`
are expected to run to hundreds of pages. A call given an explicit item cap is not subject
to it: the cap already bounds the work, so `getDependentPackages(reg, name, 500_000)` will
not fail at page 1000 for a limit it never set.

Those methods hold every page in memory. To stream instead, `client.paginate` yields one
page at a time and stops fetching the moment you stop consuming:

```ts
const pages = client.paginate(() =>
  client.packages.GET("/registries/{registryName}/packages/{packageName}/dependent_packages", {
    params: { path: { registryName: "npmjs.org", packageName: "lodash" } },
  }),
);

for await (const page of pages) {
  for (const pkg of page) console.log(pkg.name);
}
```

It takes a thunk returning any `openapi-fetch` result, so it works on the endpoints this
facade wraps and on the many it does not. The page ceiling still applies and still throws,
so a truncated stream can never be mistaken for a complete one.

## Options

```ts
const client = new EcosystemsClient({
  userAgent: "my-app/1.0",       // required
  from: "you@example.com",       // From header - see Rate limits below
  apiKey: "your-api-key",        // Authorization: Bearer - see Rate limits below
  batchSize: 50,                 // PURLs per bulk lookup request (max 100)
  timeoutMs: 30_000,             // deadline per HTTP request, including its retries
  maxPages: 1000,                // runaway-pagination guard; see Pagination below
  retry: { attempts: 3 },        // or `false` to disable
  fetch: myFetch,                // custom fetch (proxies, agents, tests)
  servers: {                     // per-service base URL overrides; any of
    packages: "https://custom.packages.server",  // packages, repos, advisories,
  },                                             // commits, issues
});
```

Every method takes an optional trailing `{ signal }` for cancellation.

```ts
const controller = new AbortController();
const pkg = await client.lookup("pkg:gem/rake", { signal: controller.signal });
```

`timeoutMs` covers one HTTP request and its retries, so every bulk batch and every
followed page gets its own budget. For a deadline over a whole operation — 50 batches of
a large `bulkLookup`, say — pass your own signal:

```ts
await client.bulkLookup(purls, { signal: AbortSignal.timeout(120_000) });
```

## Rate limits

ecosyste.ms runs two pools. Identifying yourself triples your quota:

```ts
new EcosystemsClient({ userAgent: "my-app/1.0", from: "you@example.com" });
```

Passing `from` appends `(mailto:you@example.com)` to your User-Agent and sets the `From`
header. The User-Agent is what does the work. Measured 2026-08-16, every sample a
`cf-cache-status: MISS`:

| Identification | Tier | Limit |
| --- | --- | --- |
| nothing | `anonymous` | 5000/hr |
| `From:` header | `anonymous` | 5000/hr |
| email in the User-Agent | `polite` | 15000/hr |
| `?mailto=` query parameter | `polite` | 15000/hr |

The `From` header alone does nothing. We send it as the polite HTTP convention, but never
rely on it — put the email in the User-Agent, which is what `from` does for you.

`?mailto=` works too and is deliberately not used: the CDN sends `Vary: Origin` only, so
a query parameter gives every email its own cache entry and fragments the shared cache.
Identifying through the User-Agent costs nothing.

### API keys

If you have been issued a key, pass it as `apiKey` and it is sent as
`Authorization: Bearer <key>` on every request, across all five services:

```ts
new EcosystemsClient({ userAgent: "my-app/1.0", apiKey: process.env.ECOSYSTEMS_API_KEY });
```

Keys are not part of the public ecosyste.ms flow — there is no self-serve signup and the
OpenAPI specs do not describe the scheme — so this is here for hosted or sponsor
deployments that do issue one, and for self-hosted instances behind a gateway. The tiers
measured above are the ones an anonymous or polite caller sees; a key's quota is whatever
the issuing deployment sets. Identify through the User-Agent as well either way — it costs
nothing and is what earns the polite pool when no key is in play.

### Observing the limit

The most recent response's rate-limit headers are available read-only:

```ts
client.rateLimit; // { limit, remaining, reset, tier, consumer } | null
```

**Do not build control flow on these.** Responses are CDN-cached, so on a cache hit you
receive the cached response's rate-limit headers rather than your own. For real
backpressure the client already reacts to 429 and `Retry-After`.

## Beyond the wrapped methods

The methods above cover the common cases. The generated clients are exposed for
everything else — the specs describe far more, including `/versions/lookup` (lookup by
integrity/sha256/sha1/sha512 hash), `/keywords`, `/registries/{r}/maintainers`, all of
`/topics` and `/hosts/**`, and issue/commit detail endpoints.

```ts
const { data, error, response } = await client.packages.GET("/versions/lookup", {
  params: { query: { sha256: "abc123..." } },
});
```

`client.packages`, `.repos`, `.advisories`, `.commits` and `.issues` are typed
`openapi-fetch` clients sharing the same identity, retry and rate-limit handling.

## Generated Code

`src/generated/` contains types generated from the vendored specs in `specs/`. To refresh:

```bash
npm run sync-specs   # download the latest OpenAPI specs, record sha256 in specs/.lock.json
npm run generate     # regenerate types + server URLs
```

Both the specs and the generated output are committed, and CI fails if they drift apart.
Base URLs are read from each spec's `servers[0].url` rather than hardcoded.

The generator is not a dependency of this package. `npm run generate` runs
openapi-typescript from a throwaway `npx` install, pinned to exact versions at the top of
`scripts/generate.mjs` and tracked by Renovate. It brings its own `typescript@5`, because
openapi-typescript emits through the TypeScript compiler API (`ts.factory`) and the
`typescript@7` this package compiles with no longer ships one.

## Testing

```bash
npm test                  # unit tests (loopback HTTP servers, no network)
npm run test:integration  # integration tests (hits the live API)
```

Set `ECOSYSTEMS_FROM` to run the integration suite against the polite pool.

## License

MIT
