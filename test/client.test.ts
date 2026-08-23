import { afterEach, describe, expect, it } from "vitest";

import {
  EcosystemsClient,
  type EcosystemsClientOptions,
  MAX_BULK_LOOKUP_SIZE,
} from "../src/client.js";
import { EcosystemsError, looksLikeNetworkError } from "../src/errors.js";
import {
  pathname,
  query,
  readBody,
  startServer,
  type TestServer,
  writeJSON,
} from "./helpers/server.js";

/** Fast retries so tests exercising the retry path don't sit in real backoff. */
const fastRetry = { baseDelayMs: 1, maxDelayMs: 2 } as const;

let servers: TestServer[] = [];

async function serve(handler: Parameters<typeof startServer>[0]): Promise<string> {
  const server = await startServer(handler);
  servers.push(server);
  return server.url;
}

/** A server that answers everything with one status and no body. */
const serveStatus = (status: number): Promise<string> =>
  serve((_req, res) => {
    res.writeHead(status);
    res.end();
  });

/**
 * A client pointed at a loopback server. Pass a URL for the common packages-only case, or
 * a servers object for the few tests that exercise another service.
 */
const makeClient = (
  servers: string | EcosystemsClientOptions["servers"],
  options: Partial<EcosystemsClientOptions> = {},
): EcosystemsClient =>
  new EcosystemsClient({
    userAgent: "test-agent/1.0",
    servers: typeof servers === "string" ? { packages: servers } : servers,
    ...options,
  });

afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

describe("construction", () => {
  it("requires a userAgent", () => {
    expect(() => new EcosystemsClient({ userAgent: "" })).toThrow(/userAgent is required/);
  });

  it("falls back to the default page ceiling for a non-positive maxPages", async () => {
    // maxPages: 0 previously threw "pagination exceeded max pages 0" without issuing a
    // single request, unlike every other numeric option here.
    const url = await serve((_req, res) => writeJSON(res, "[]"));
    const client = makeClient(url, { maxPages: 0 });
    await expect(client.listRegistries()).resolves.toEqual([]);
    await expect(client.getAllVersions("rubygems.org", "rake")).resolves.toEqual([]);
  });

  it("accepts per-service server overrides", () => {
    const client = makeClient("https://custom.packages.server");
    expect(client).toBeInstanceOf(EcosystemsClient);
  });

  it("clamps batchSize to the bulk lookup maximum", async () => {
    const seen: number[] = [];
    const url = await serve(async (req, res) => {
      const body = JSON.parse(await readBody(req)) as { purls: string[] };
      seen.push(body.purls.length);
      writeJSON(res, "[]");
    });

    for (const [configured, expected] of [
      [25, 25],
      [0, MAX_BULK_LOOKUP_SIZE],
      [-5, MAX_BULK_LOOKUP_SIZE],
      [MAX_BULK_LOOKUP_SIZE + 50, MAX_BULK_LOOKUP_SIZE],
    ] as const) {
      seen.length = 0;
      const client = makeClient(url, { batchSize: configured });
      await client.bulkLookup(Array.from({ length: 120 }, (_, i) => `pkg:npm/p${i}`));
      expect(seen[0]).toBe(expected);
    }
  });
});

describe("bulkLookup", () => {
  it("returns an empty result without hitting the network", async () => {
    const client = makeClient("http://127.0.0.1:1");
    const { results, failures } = await client.bulkLookup([]);
    expect(results.size).toBe(0);
    expect(failures).toEqual([]);
  });

  // Port of TestBulkLookupBatching.
  it("splits into batches of the configured size", async () => {
    const batches: string[][] = [];
    const url = await serve(async (req, res) => {
      const body = JSON.parse(await readBody(req)) as { purls: string[] };
      batches.push(body.purls);
      writeJSON(res, "[]");
    });

    const client = makeClient(url, { batchSize: 3 });
    await client.bulkLookup(["a", "b", "c", "d", "e", "f", "g"].map((n) => `pkg:a/${n}`));

    expect(batches.map((b) => b.length)).toEqual([3, 3, 1]);
  });

  it("keys results by purl and merges across batches", async () => {
    let call = 0;
    const url = await serve(async (_req, res) => {
      call++;
      writeJSON(
        res,
        call === 1
          ? `[{"purl":"pkg:npm/a","name":"a","ecosystem":"npm"}]`
          : `[{"purl":"pkg:npm/b","name":"b","ecosystem":"npm"}]`,
      );
    });

    const client = makeClient(url, { batchSize: 1 });
    const { results, failures } = await client.bulkLookup(["pkg:npm/a", "pkg:npm/b"]);

    expect([...results.keys()].sort()).toEqual(["pkg:npm/a", "pkg:npm/b"]);
    expect(results.get("pkg:npm/a")?.name).toBe("a");
    expect(failures).toEqual([]);
  });

  // Port of TestBulkLookupHintOn429. The hint now rides on the failure entry rather than
  // on a thrown error, but it is the same assertion about the same message.
  it("adds a rate-limit hint on 429", async () => {
    const url = await serveStatus(429);
    const client = makeClient(url, { retry: fastRetry });

    const { results, failures } = await client.bulkLookup(["pkg:npm/lodash"]);

    expect(results.size).toBe(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.error.message).toMatch(/429/);
    expect(failures[0]?.error.message).toMatch(/rate limited/);
    expect(failures[0]?.error.status).toBe(429);
  });

  // Port of TestBulkLookupNoHintOn5xx -- 500 is not rate limiting.
  it("does not add a rate-limit hint on 500", async () => {
    const url = await serveStatus(500);
    const client = makeClient(url, { retry: fastRetry });

    const { failures } = await client.bulkLookup(["pkg:npm/lodash"]);

    expect(failures).toHaveLength(1);
    expect(failures[0]?.error.message).not.toMatch(/rate limited/);
  });

  describe("partial results", () => {
    const PURLS = ["pkg:npm/a", "pkg:npm/b", "pkg:npm/c", "pkg:npm/d"];

    /** One batch per purl by default, so batch N is purl N. */
    const client = (url: string, batchSize = 1) =>
      makeClient(url, { batchSize, retry: fastRetry });

    /** Succeeds for every batch except the nth, which 502s. */
    const flakyServer = (failOn: number) => {
      let call = 0;
      return serve((_req, res) => {
        call++;
        if (call === failOn) {
          res.writeHead(502);
          res.end();
          return;
        }
        writeJSON(res, `[{"purl":"pkg:npm/a${call}","name":"a${call}","ecosystem":"npm"}]`);
      });
    };

    it("keeps the batches that succeeded when one fails", async () => {
      const { results, failures } = await client(await flakyServer(2)).bulkLookup(
        PURLS.slice(0, 3),
      );

      expect([...results.keys()].sort()).toEqual(["pkg:npm/a1", "pkg:npm/a3"]);
      expect(failures).toHaveLength(1);
    });

    // The point of the whole shape: a caller must be able to retry what was lost.
    it("reports which purls were in the failed batch", async () => {
      const { failures } = await client(await flakyServer(2), 2).bulkLookup(PURLS);

      expect(failures.flatMap((f) => f.purls)).toEqual(["pkg:npm/c", "pkg:npm/d"]);
      expect(failures[0]?.error).toBeInstanceOf(EcosystemsError);
      expect(failures[0]?.error.status).toBe(502);
    });

    it("does not throw when every batch fails", async () => {
      const { results, failures } = await client(await serveStatus(502)).bulkLookup(
        PURLS.slice(0, 2),
      );

      expect(results.size).toBe(0);
      expect(failures.flatMap((f) => f.purls)).toEqual(["pkg:npm/a", "pkg:npm/b"]);
    });

    it("collects a transport failure as a failure, not a throw", async () => {
      // Nothing listening: the request never reaches a status code.
      const { failures } = await client("http://127.0.0.1:1").bulkLookup(["pkg:npm/a"]);

      expect(failures).toHaveLength(1);
      expect(failures[0]?.error).toBeInstanceOf(EcosystemsError);
      expect(failures[0]?.error.status).toBeUndefined();
    });

    // Cancelling is the caller's own intent, so it must not be reported as a bad batch.
    it("throws rather than collecting when the caller aborts", async () => {
      const controller = new AbortController();
      const url = await serve((_req, res) => {
        controller.abort();
        res.writeHead(502);
        res.end();
      });

      await expect(
        client(url).bulkLookup(PURLS.slice(0, 2), { signal: controller.signal }),
      ).rejects.toThrow();
    });
  });

  // Port of TestBulkLookupNoHintOnPlain400 -- the 400 detail must survive.
  it("preserves the error detail from a 400 body", async () => {
    const url = await serve((_req, res) => {
      writeJSON(res, `{"error":"invalid purl"}`, 400);
    });
    const client = makeClient(url);

    const { failures } = await client.bulkLookup(["not-a-purl"]);

    expect(failures[0]?.error.message).toMatch(/invalid purl/);
    expect(failures[0]?.error.message).not.toMatch(/rate limited/);
  });

  it("finds a package looked up by a versioned purl", async () => {
    // The API canonicalises: it answers pkg:npm/lodash@4.17.21 with a record whose purl
    // is pkg:npm/lodash (verified live). Keying the map by the request purl missed it.
    const url = await serve((_req, res) => {
      writeJSON(res, `[{"purl":"pkg:npm/lodash","name":"lodash","ecosystem":"npm"}]`);
    });
    const client = makeClient(url);

    expect((await client.lookup("pkg:npm/lodash@4.17.21"))?.name).toBe("lodash");
    expect(await client.lookup("pkg:npm/lodash")).not.toBeNull();
  });

  it("still returns null when nothing matched", async () => {
    const url = await serve((_req, res) => writeJSON(res, "[]"));
    const client = makeClient(url);
    expect(await client.lookup("pkg:npm/nope-xyz")).toBeNull();
  });

  // lookup() shares #bulk with bulkLookup, so partial results could easily have turned a
  // failed request into a silent null here. It must stay an exception: null means
  // "no such package", which is a different answer from "the request failed".
  it("throws rather than returning null when the request fails", async () => {
    const url = await serveStatus(502);
    const client = makeClient(url, { retry: fastRetry });

    await expect(client.lookup("pkg:npm/lodash")).rejects.toThrow(EcosystemsError);
  });

  it("sends a real POST body rather than an empty GET", async () => {
    let method = "";
    let body = "";
    const url = await serve(async (req, res) => {
      method = req.method ?? "";
      body = await readBody(req);
      writeJSON(res, "[]");
    });

    const client = makeClient(url);
    await client.bulkLookup(["pkg:npm/lodash"]);

    expect(method).toBe("POST");
    expect(JSON.parse(body)).toEqual({ purls: ["pkg:npm/lodash"] });
  });
});

describe("Link pagination", () => {
  // Port of TestLookupPackagesByRepositoryURLFollowsLinkAndCaps.
  it("follows rel=next, caps at maxItems, and carries identity headers", async () => {
    let nextPageUserAgent: string | undefined;
    const url = await serve(async (req, res) => {
      expect(pathname(req)).toBe("/packages/lookup");

      if (query(req).get("page") === "2") {
        nextPageUserAgent = req.headers["user-agent"];
        writeJSON(
          res,
          `[{"purl":"pkg:npm/b","name":"b","ecosystem":"npm"},
            {"purl":"pkg:npm/c","name":"c","ecosystem":"npm"}]`,
        );
        return;
      }

      expect(query(req).get("repository_url")).toBe("https://github.com/acme/widget");
      const host = req.headers.host;
      writeJSON(res, `[{"purl":"pkg:npm/a","name":"a","ecosystem":"npm"}]`, 200, {
        link: `<http://${host}/packages/lookup?page=2>; rel="next"`,
      });
    });

    const client = makeClient(url);
    const got = await client.lookupPackagesByRepositoryUrl("https://github.com/acme/widget", 2);

    expect(got.map((p) => p.purl)).toEqual(["pkg:npm/a", "pkg:npm/b"]);
    expect(nextPageUserAgent).toBe("test-agent/1.0");
  });

  it("stops once maxItems is satisfied, without fetching another page", async () => {
    // DIVERGENCE FROM ecosystems-go: Go stops only on overshoot, so a first page that
    // exactly satisfies maxItems still costs a second request whose rows are discarded.
    let hits = 0;
    const url = await serve((req, res) => {
      hits++;
      const perPage = Number(query(req).get("per_page") ?? "100");
      const rows = Array.from({ length: perPage }, (_, i) => ({
        purl: `pkg:npm/p${hits}-${i}`,
        name: `p${i}`,
        ecosystem: "npm",
      }));
      writeJSON(res, JSON.stringify(rows), 200, {
        link: `<http://${req.headers.host}/x?page=${hits + 1}&per_page=${perPage}>; rel="next"`,
      });
    });

    const client = makeClient(url);
    const got = await client.getDependentPackages("npmjs.org", "lodash", 25);

    expect(got.length).toBe(25);
    expect(hits).toBe(1);
  });

  it("rejects a page that is not an array", async () => {
    const url = await serve((req, res) => {
      if (query(req).get("page") === "2") {
        // A 200 carrying an error envelope, which concat would have folded in silently.
        writeJSON(res, `{"error":"upstream exploded"}`);
        return;
      }
      writeJSON(res, `[{"purl":"pkg:npm/a","name":"a","ecosystem":"npm"}]`, 200, {
        link: `<http://${req.headers.host}/packages/lookup?page=2>; rel="next"`,
      });
    });

    const client = makeClient(url);
    await expect(client.lookupPackagesByPurl("pkg:npm/a")).rejects.toThrow(/expected an array/);
  });

  it("resolves a relative rel=next against the response URL", async () => {
    // ecosyste.ms sends absolute URLs today, but RFC 8288 permits relative ones and a
    // rewriting proxy would otherwise make `new Request(next)` throw.
    const url = await serve((req, res) => {
      if (query(req).get("page") === "2") {
        writeJSON(res, `[{"purl":"pkg:npm/b","name":"b","ecosystem":"npm"}]`);
        return;
      }
      writeJSON(res, `[{"purl":"pkg:npm/a","name":"a","ecosystem":"npm"}]`, 200, {
        link: `</packages/lookup?page=2>; rel="next"`,
      });
    });

    const client = makeClient(url);
    const got = await client.lookupPackagesByPurl("pkg:npm/a");
    expect(got.map((p) => p.purl)).toEqual(["pkg:npm/a", "pkg:npm/b"]);
  });

  it("wraps a transport failure on a followed page", async () => {
    const url = await serve((_req, res) => {
      // Nothing is listening on port 1, so following this link fails at the socket.
      writeJSON(res, `[{"purl":"pkg:npm/a","name":"a","ecosystem":"npm"}]`, 200, {
        link: `<http://127.0.0.1:1/packages/lookup?page=2>; rel="next"`,
      });
    });

    const client = makeClient(url, { retry: fastRetry });

    // Previously escaped as a bare `TypeError: fetch failed`, with no hint and no status.
    const err = await client.lookupPackagesByPurl("pkg:npm/a").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EcosystemsError);
    expect((err as EcosystemsError).message).toMatch(/rejected before a response/);
  });

  // Port of TestLookupPackagesByRepositoryURLSignalsPageCap -- must error, not truncate.
  it("throws rather than silently truncating at the page ceiling", async () => {
    const url = await serve((req, res) => {
      const page = query(req).get("page") ?? "1";
      writeJSON(res, `[{"purl":"pkg:npm/a","name":"a","ecosystem":"npm"}]`, 200, {
        link: `<http://${req.headers.host}/packages/lookup?page=${page}x>; rel="next"`,
      });
    });

    // maxPages explicitly, so the test does not ride whatever the default happens to be.
    const client = makeClient(url, { maxPages: 4 });
    await expect(
      client.lookupPackagesByRepositoryUrl("https://github.com/acme/widget", 0),
    ).rejects.toThrow(/pagination exceeded max pages 4/);
  });

  // Port of TestGetDependentPackagesFollowsLink -- note the bare `rel=next`.
  it("accepts an unquoted rel=next", async () => {
    const url = await serve((req, res) => {
      expect(pathname(req)).toBe("/registries/npmjs.org/packages/lodash/dependent_packages");

      if (query(req).get("page") === "2") {
        writeJSON(
          res,
          `[{"purl":"pkg:npm/downstream-b","name":"downstream-b","ecosystem":"npm"}]`,
        );
        return;
      }
      writeJSON(
        res,
        `[{"purl":"pkg:npm/downstream-a","name":"downstream-a","ecosystem":"npm"}]`,
        200,
        {
          link: `<http://${req.headers.host}/registries/npmjs.org/packages/lodash/dependent_packages?page=2>; rel=next`,
        },
      );
    });

    const client = makeClient(url);
    const got = await client.getDependentPackages("npmjs.org", "lodash", 0);

    expect(got.map((p) => p.purl)).toEqual(["pkg:npm/downstream-a", "pkg:npm/downstream-b"]);
  });
});

describe("paginate", () => {
  const twoPages = async () =>
    await serve((req, res) => {
      if (query(req).get("page") === "2") {
        writeJSON(res, `[{"purl":"pkg:npm/b","name":"b","ecosystem":"npm"}]`);
        return;
      }
      writeJSON(res, `[{"purl":"pkg:npm/a","name":"a","ecosystem":"npm"}]`, 200, {
        link: `<http://${req.headers.host}/packages/lookup?page=2>; rel="next"`,
      });
    });

  it("yields one page at a time", async () => {
    const url = await twoPages();
    const client = makeClient(url);

    const pages: string[][] = [];
    for await (const page of client.paginate(() =>
      client.packages.GET("/packages/lookup", { params: { query: { purl: "pkg:npm/a" } } }),
    )) {
      pages.push(page.map((p) => p.purl));
    }

    expect(pages).toEqual([["pkg:npm/a"], ["pkg:npm/b"]]);
  });

  it("stops fetching when the caller breaks out", async () => {
    let hits = 0;
    const url = await serve((req, res) => {
      hits++;
      writeJSON(res, `[{"purl":"pkg:npm/a","name":"a","ecosystem":"npm"}]`, 200, {
        link: `<http://${req.headers.host}/packages/lookup?page=2>; rel="next"`,
      });
    });
    const client = makeClient(url);

    for await (const _page of client.paginate(() =>
      client.packages.GET("/packages/lookup", { params: { query: { purl: "pkg:npm/a" } } }),
    )) {
      break;
    }

    expect(hits).toBe(1);
  });

  it("passes the caller signal to the first request", async () => {
    let hits = 0;
    const url = await serve(async (_req, res) => {
      hits++;
      await new Promise((resolve) => setTimeout(resolve, 200));
      writeJSON(res, "[]");
    });
    const client = makeClient(url, { timeoutMs: 0 });

    await expect(async () => {
      for await (const _page of client.paginate(
        (init) =>
          client.packages.GET("/packages/lookup", {
            ...init,
            params: { query: { purl: "pkg:npm/a" } },
          }),
        { signal: AbortSignal.timeout(50) },
      )) {
        // never reached
      }
    }).rejects.toThrow();
    expect(hits).toBe(1);
  });

  it("throws at the page ceiling rather than ending the stream", async () => {
    const url = await serve((req, res) => {
      const page = query(req).get("page") ?? "1";
      writeJSON(res, `[{"purl":"pkg:npm/a","name":"a","ecosystem":"npm"}]`, 200, {
        link: `<http://${req.headers.host}/packages/lookup?page=${page}x>; rel="next"`,
      });
    });
    const client = makeClient(url, { maxPages: 3 });

    await expect(async () => {
      for await (const _page of client.paginate(() =>
        client.packages.GET("/packages/lookup", { params: { query: { purl: "pkg:npm/a" } } }),
      )) {
        // drain
      }
    }).rejects.toThrow(/pagination exceeded max pages 3/);
  });
});

describe("service wrappers", () => {
  // Port of TestLookupPackagesByPURL.
  it("looks up packages by purl", async () => {
    const url = await serve((req, res) => {
      expect(query(req).get("purl")).toBe("pkg:gem/rake");
      writeJSON(
        res,
        `[{"purl":"pkg:gem/rake","name":"rake","ecosystem":"rubygems","repository_url":"https://github.com/ruby/rake"}]`,
      );
    });

    const client = makeClient(url);
    const got = await client.lookupPackagesByPurl("pkg:gem/rake");

    expect(got).toHaveLength(1);
    expect(got[0]?.repository_url).toBe("https://github.com/ruby/rake");
  });

  // Port of TestGetAdvisoriesByRepoURL.
  it("gets advisories by repository url", async () => {
    const url = await serve((req, res) => {
      expect(query(req).get("repository_url")).toBe("https://github.com/rails/rails");
      writeJSON(res, `[{"uuid":"GHSA-1","repository_url":"https://github.com/rails/rails"}]`);
    });

    const client = makeClient({ advisories: url });
    const got = await client.getAdvisoriesByRepoUrl("https://github.com/rails/rails", 10);

    expect(got.map((a) => a.uuid)).toEqual(["GHSA-1"]);
  });

  // Port of TestGetCommitsAndIssuesSummary.
  it("gets commits and issues summaries from their own services", async () => {
    const commitsUrl = await serve((_req, res) => {
      writeJSON(res, `{"full_name":"acme/widget","total_commits":42}`);
    });
    const issuesUrl = await serve((_req, res) => {
      writeJSON(res, `{"full_name":"acme/widget","issues_count":7}`);
    });

    const client = makeClient({ commits: commitsUrl, issues: issuesUrl });

    expect(
      (await client.getCommitsSummary("https://github.com/acme/widget"))?.total_commits,
    ).toBe(42);
    expect(
      (await client.getIssuesSummary("https://github.com/acme/widget"))?.issues_count,
    ).toBe(7);
  });

  it("returns null on 404 rather than throwing", async () => {
    const url = await serve((_req, res) => {
      writeJSON(res, `{"error":"not found"}`, 404);
    });

    const client = makeClient(url);
    expect(await client.lookupByRegistryAndName("rubygems.org", "nope")).toBeNull();
  });

  // Port of TestLookupWrapperReportsStatus.
  it("reports the status code on an unexpected error", async () => {
    const url = await serveStatus(500);

    const client = makeClient(url, { retry: fastRetry });
    await expect(client.lookupPackagesByPurl("pkg:npm/lodash")).rejects.toThrow(/status 500/);
  });

  it("stops paging once a short page arrives", async () => {
    let calls = 0;
    const url = await serve((_req, res) => {
      calls++;
      const rows =
        calls === 1
          ? Array.from({ length: 100 }, (_, i) => `{"number":"1.0.${i}"}`)
          : [`{"number":"2.0.0"}`];
      writeJSON(res, `[${rows.join(",")}]`);
    });

    const client = makeClient(url);
    const versions = await client.getAllVersions("rubygems.org", "rake");

    expect(versions).toHaveLength(101);
    expect(calls).toBe(2);
  });
});

describe("transport", () => {
  // Port of TestDefaultHTTPClientRetriesGET.
  it("retries a GET that returns 503", async () => {
    let hits = 0;
    const url = await serve((_req, res) => {
      hits++;
      if (hits === 1) {
        res.writeHead(503);
        res.end();
        return;
      }
      writeJSON(res, "[]");
    });

    const client = makeClient(url, { retry: fastRetry });
    await client.listRegistries();

    expect(hits).toBe(2);
  });

  it("sends User-Agent, From and Authorization", async () => {
    let headers: Record<string, string | string[] | undefined> = {};
    const url = await serve((req, res) => {
      headers = req.headers;
      writeJSON(res, "[]");
    });

    const client = makeClient(url, { from: "you@example.com", apiKey: "secret" });
    await client.listRegistries();

    expect(headers["user-agent"]).toBe("test-agent/1.0 (mailto:you@example.com)");
    expect(headers["from"]).toBe("you@example.com");
    expect(headers["authorization"]).toBe("Bearer secret");
    expect(headers["accept"]).toBe("application/json");
  });

  it("exposes rate-limit headers from the last response", async () => {
    const url = await serve((_req, res) => {
      writeJSON(res, "[]", 200, {
        "x-ratelimit-limit": "15000",
        "x-ratelimit-remaining": "14999",
        "x-ratelimit-reset": "1786834800",
        "x-ratelimit-tier": "polite",
        "x-ratelimit-consumer": "anonymous",
      });
    });

    const client = makeClient(url);
    expect(client.rateLimit).toBeNull();

    await client.listRegistries();

    expect(client.rateLimit).toMatchObject({
      limit: 15000,
      remaining: 14999,
      tier: "polite",
      consumer: "anonymous",
    });
    expect(client.rateLimit?.reset?.toISOString()).toBe("2026-08-15T23:00:00.000Z");
  });

  it("identifies through the User-Agent, never through the query string", async () => {
    // The `From` header does not reach the polite pool (measured live, on cache misses);
    // the email in the User-Agent does. `?mailto=` also works but is deliberately unused,
    // because it would give every email its own CDN cache entry.
    let seen = "";
    const url = await serve((req, res) => {
      seen = req.url ?? "";
      writeJSON(res, "[]");
    });

    const client = makeClient(url, { from: "you@example.com" });
    await client.listRegistries();

    expect(seen).toBe("/registries");
    expect(seen).not.toContain("mailto");
  });

  // The Go original puts its 30s on http.Client, so it covers one request and its
  // retries. These two tests pin that scope: per request, not per operation.
  it("gives every bulk batch its own timeout budget", async () => {
    let hits = 0;
    const url = await serve(async (_req, res) => {
      hits++;
      await new Promise((resolve) => setTimeout(resolve, 60));
      writeJSON(res, "[]");
    });

    const client = makeClient(url, { batchSize: 1, timeoutMs: 150 });

    // Four batches at 60ms each is 240ms of wall clock, well past the 150ms budget that
    // a whole-operation deadline would impose.
    await client.bulkLookup(["pkg:npm/a", "pkg:npm/b", "pkg:npm/c", "pkg:npm/d"]);
    expect(hits).toBe(4);
  });

  it("still times out a single request that overruns", async () => {
    const url = await serve(async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      writeJSON(res, "[]");
    });

    const client = makeClient(url, { timeoutMs: 50, retry: false });

    await expect(client.listRegistries()).rejects.toThrow();
  });

  it("honours a caller signal as the whole-operation deadline", async () => {
    let hits = 0;
    const url = await serve(async (_req, res) => {
      hits++;
      await new Promise((resolve) => setTimeout(resolve, 60));
      writeJSON(res, "[]");
    });

    const client = makeClient(url, { batchSize: 1, timeoutMs: 0 });

    // What a Go caller expresses with context.WithTimeout.
    await expect(
      client.bulkLookup(["pkg:npm/a", "pkg:npm/b", "pkg:npm/c", "pkg:npm/d"], {
        signal: AbortSignal.timeout(100),
      }),
    ).rejects.toThrow();
    expect(hits).toBeLessThan(4);
  });

  it("wraps transport failures with an actionable hint", async () => {
    // Nothing is listening on port 1.
    const client = makeClient("http://127.0.0.1:1", { retry: fastRetry });

    await expect(client.listRegistries()).rejects.toThrow(/rejected before a response/);
  });
});

describe("looksLikeNetworkError", () => {
  // Port of TestLooksLikeStreamErr.
  it.each([
    [null, false],
    [new Error("connection refused"), false],
    [new Error("stream error: stream ID 1; INTERNAL_ERROR; received from peer"), true],
    [new Error("http2: server sent GOAWAY"), true],
    [new Error("ENHANCE_YOUR_CALM"), true],
    [new TypeError("fetch failed"), true],
    [new TypeError("Failed to fetch"), true],
  ])("%s -> %s", (err, want) => {
    expect(looksLikeNetworkError(err)).toBe(want);
  });

  it("detects undici socket codes on the cause", () => {
    const err = new TypeError("something odd");
    (err as { cause?: unknown }).cause = { code: "ECONNRESET" };
    expect(looksLikeNetworkError(err)).toBe(true);
  });
});

describe("listCriticalPackages", () => {
  it("follows Link pagination across pages", async () => {
    const seen: string[] = [];
    const url = await serve((req, res) => {
      const page = Number(query(req).get("page") ?? "1");
      seen.push(`${pathname(req)}?page=${page}`);
      const link: Record<string, string> =
        page < 3
          ? {
              link: `<http://${req.headers.host}/packages/critical?page=${page + 1}>; rel="next"`,
            }
          : {};
      writeJSON(
        res,
        `[{"name":"p${page}","ecosystem":"npm","registry":{"name":"npmjs.org"}}]`,
        200,
        link,
      );
    });

    const client = makeClient(url);
    const packages = await client.listCriticalPackages();

    expect(packages.map((p) => p.name)).toEqual(["p1", "p2", "p3"]);
    expect(seen).toEqual([
      "/packages/critical?page=1",
      "/packages/critical?page=2",
      "/packages/critical?page=3",
    ]);
  });

  it("crawls past the page ceiling when maxItems asks for it", async () => {
    // ~96 pages today and growing; a bounded caller must not hit a ceiling it never set.
    let pages = 0;
    const url = await serve((req, res) => {
      pages++;
      const batch = Array.from(
        { length: 100 },
        (_v, i) => `{"name":"p${pages}-${i}","ecosystem":"npm"}`,
      );
      writeJSON(res, `[${batch.join(",")}]`, 200, {
        link: `<http://${req.headers.host}/packages/critical?page=${pages + 1}>; rel="next"`,
      });
    });

    const client = makeClient(url, { maxPages: 2 });
    const packages = await client.listCriticalPackages(250);

    expect(packages).toHaveLength(250);
    expect(pages).toBe(3);
  });

  it("keeps going for a bounded call when pages come back short", async () => {
    // per_page is a request, not a promise; a budget assuming full pages would cut this
    // off at one page and report a ceiling the caller never set.
    let pages = 0;
    const url = await serve((req, res) => {
      pages++;
      writeJSON(res, `[{"name":"p${pages}","ecosystem":"npm"}]`, 200, {
        link: `<http://${req.headers.host}/packages/critical?page=${pages + 1}>; rel="next"`,
      });
    });

    const client = makeClient(url, { maxPages: 2 });
    await expect(client.listCriticalPackages(5)).resolves.toHaveLength(5);
    expect(pages).toBe(5);
  });

  it("stops at the requested item cap", async () => {
    const url = await serve((req, res) => {
      expect(query(req).get("per_page")).toBe("2");
      writeJSON(res, `[{"name":"a","ecosystem":"npm"},{"name":"b","ecosystem":"npm"}]`, 200, {
        link: `<http://${req.headers.host}/packages/critical?page=2>; rel="next"`,
      });
    });

    const client = makeClient(url);
    await expect(client.listCriticalPackages(2)).resolves.toHaveLength(2);
  });
});

describe("getVersionNumbers", () => {
  it("returns the unpaginated string array", async () => {
    let requests = 0;
    const url = await serve((req, res) => {
      requests++;
      expect(pathname(req)).toBe("/registries/rubygems.org/packages/rake/version_numbers");
      // A Link header here must not trigger a second request: this endpoint is not paged.
      writeJSON(res, `["13.0.0","13.0.1"]`, 200, {
        link: `<http://${req.headers.host}/x?page=2>; rel="next"`,
      });
    });

    const client = makeClient(url);
    await expect(client.getVersionNumbers("rubygems.org", "rake")).resolves.toEqual([
      "13.0.0",
      "13.0.1",
    ]);
    expect(requests).toBe(1);
  });

  it("returns an empty list for an unknown package", async () => {
    const client = makeClient(await serveStatus(404));
    await expect(client.getVersionNumbers("rubygems.org", "nope")).resolves.toEqual([]);
  });

  it("throws on a server error", async () => {
    const client = makeClient(await serveStatus(500), { retry: false });
    await expect(client.getVersionNumbers("rubygems.org", "rake")).rejects.toBeInstanceOf(
      EcosystemsError,
    );
  });
});
