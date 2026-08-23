import { describe, expect, it } from "vitest";

import { capItems, nextLink, pageBudget, perPageForCap } from "../src/paginate.js";

describe("nextLink", () => {
  // Ported verbatim from TestNextLink in ecosystems-go's services_test.go. The Link
  // header is undocumented in every spec, so this table is the only specification of it
  // we have.
  const cases: Array<[header: string, want: string | null]> = [
    ['<https://x/api?page=2>; rel="next"', "https://x/api?page=2"],
    [
      '<https://x/api?page=3>; rel="last", <https://x/api?page=2>; rel="next"',
      "https://x/api?page=2",
    ],
    ["<https://x/api?page=2>; rel=next", "https://x/api?page=2"],
    ['<https://x/api?page=9>; rel="last"', null],
    ['<https://x/api?page=2&f=a,b,c>; rel="next"', "https://x/api?page=2&f=a,b,c"],
    ["", null],
    ["garbage", null],
    ['<https://x/api?page=2; rel="next"', null],
  ];

  it.each(cases)("nextLink(%j) === %j", (header, want) => {
    expect(nextLink(header)).toBe(want);
  });

  it("handles null and undefined", () => {
    expect(nextLink(null)).toBeNull();
    expect(nextLink(undefined)).toBeNull();
  });

  it("finds rel=next when it is not the last entry", () => {
    const header =
      '<https://x/api?page=1>; rel="first", <https://x/api?page=2>; rel="next", <https://x/api?page=9>; rel="last"';
    expect(nextLink(header)).toBe("https://x/api?page=2");
  });
});

describe("perPageForCap", () => {
  it("shrinks per_page below a full page", () => {
    expect(perPageForCap(25)).toBe(25);
  });

  it("uses a full page when uncapped or capped above it", () => {
    expect(perPageForCap(0)).toBe(100);
    expect(perPageForCap(-1)).toBe(100);
    expect(perPageForCap(500)).toBe(100);
    expect(perPageForCap(100)).toBe(100);
  });
});

describe("capItems", () => {
  it("treats maxItems <= 0 as unlimited", () => {
    expect(capItems([1, 2, 3], 0)).toEqual({ items: [1, 2, 3], capped: false });
    expect(capItems([1, 2, 3], -5)).toEqual({ items: [1, 2, 3], capped: false });
  });

  it("does not report capped when exactly at the limit", () => {
    expect(capItems([1, 2, 3], 3)).toEqual({ items: [1, 2, 3], capped: false });
  });

  it("truncates and reports capped", () => {
    expect(capItems([1, 2, 3], 2)).toEqual({ items: [1, 2], capped: true });
  });
});

describe("pageBudget", () => {
  it("uses the page ceiling when the call is unbounded", () => {
    expect(pageBudget(0, 20)).toBe(20);
    expect(pageBudget(-1, 20)).toBe(20);
  });

  it("lets an explicit item cap raise the ceiling", () => {
    // The caller has already bounded the work; maxPages exists for the calls that have not.
    expect(pageBudget(500_000, 1000)).toBe(5000);
    expect(pageBudget(250, 2)).toBe(3);
  });

  it("scales with the items a page actually holds", () => {
    expect(pageBudget(250, 2, 10)).toBe(25);
    expect(pageBudget(250, 2, 1)).toBe(250);
  });

  it("never lowers the ceiling below maxPages", () => {
    expect(pageBudget(10, 1000)).toBe(1000);
  });
});
