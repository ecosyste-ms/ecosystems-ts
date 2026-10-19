import type { PackageURL } from "packageurl-js";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_REGISTRY_BY_PURL_TYPE,
  REGISTRIES_WITHOUT_DEFAULT,
} from "../src/generated/registries.js";
import {
  DEB_VENDOR_TO_PURL_TYPE,
  PINNED_REGISTRIES,
  PURL_TYPE_ALIASES,
  PURL_TYPES_WITHOUT_REGISTRY,
  parsePurl,
  purlToName,
  purlToRegistry,
  supportedPurlTypes,
} from "../src/purl.js";

// Ported from purl_test.go.
describe("purlToRegistry", () => {
  const cases: Array<[type: string, want: string]> = [
    ["npm", "npmjs.org"],
    ["gem", "rubygems.org"],
    ["pypi", "pypi.org"],
    ["maven", "repo1.maven.org"],
    ["cargo", "crates.io"],
    ["golang", "proxy.golang.org"],
    ["nuget", "nuget.org"],
    ["composer", "packagist.org"],
    ["hex", "hex.pm"],
    ["pub", "pub.dev"],
    ["apk", "alpine-edge"],
    ["docker", "hub.docker.com"],
    ["brew", "formulae.brew.sh"],
    ["julia", "juliahub.com"],
    ["huggingface", "huggingface.co"],
  ];

  it.each(cases)("%s -> %s", (type, want) => {
    expect(purlToRegistry({ type, name: "x" } as PackageURL)).toBe(want);
  });

  it("returns null for known types with no ecosyste.ms registry", () => {
    for (const type of [
      "github",
      "generic",
      "oci",
      "rpm",
      "bitbucket",
      "bitnami",
      // Named registries that do not exist; absent from GET /registries.
      "alpm",
      "chef",
      "chocolatey",
    ]) {
      expect(purlToRegistry({ type, name: "x" } as PackageURL)).toBeNull();
    }
  });

  // There is no registry named `debian`, only one per release. Expected values come from
  // the snapshot, so an upstream release bump is not a failure: what is asserted is that
  // the vendor selects the right ecosystem.
  describe("deb resolves through the namespace vendor", () => {
    it.each([
      ["debian", "debian"],
      ["ubuntu", "ubuntu"],
      ["Debian", "debian"],
    ])("pkg:deb/%s/curl -> the %s default", (namespace, ecosystem) => {
      expect(purlToRegistry({ type: "deb", namespace, name: "curl" } as PackageURL)).toBe(
        DEFAULT_REGISTRY_BY_PURL_TYPE[ecosystem],
      );
    });

    it("falls back to the Debian default when no vendor is given", () => {
      expect(purlToRegistry({ type: "deb", name: "curl" } as PackageURL)).toBe(
        DEFAULT_REGISTRY_BY_PURL_TYPE.debian,
      );
    });

    it("returns null for a vendor ecosyste.ms does not carry", () => {
      const purl = { type: "deb", namespace: "raspbian", name: "curl" } as PackageURL;
      expect(purlToRegistry(purl)).toBeNull();
    });
  });

  it("returns null for unknown types", () => {
    expect(purlToRegistry({ type: "not-a-real-type", name: "x" } as PackageURL)).toBeNull();
  });
});

describe("purlToName", () => {
  const cases: Array<[label: string, purl: Partial<PackageURL>, want: string]> = [
    ["simple npm package", { type: "npm", name: "lodash" }, "lodash"],
    ["scoped npm package", { type: "npm", namespace: "babel", name: "core" }, "babel/core"],
    [
      "maven package",
      { type: "maven", namespace: "org.apache.commons", name: "commons-lang3" },
      "org.apache.commons:commons-lang3",
    ],
    ["gem package", { type: "gem", name: "rails" }, "rails"],
    ["pypi package", { type: "pypi", name: "requests" }, "requests"],
    [
      "go package with namespace",
      { type: "golang", namespace: "github.com/go-git", name: "go-git" },
      "github.com/go-git/go-git",
    ],
    ["apk ignores namespace", { type: "apk", namespace: "alpine", name: "curl" }, "curl"],
    // The namespace is the vendor, not part of the name: "debian/curl" is a 404.
    ["deb ignores namespace", { type: "deb", namespace: "debian", name: "curl" }, "curl"],
    [
      "deb ignores ubuntu namespace",
      { type: "deb", namespace: "ubuntu", name: "curl" },
      "curl",
    ],
  ];

  it.each(cases)("%s", (_label, purl, want) => {
    expect(purlToName(purl as PackageURL)).toBe(want);
  });
});

describe("parsePurl", () => {
  const cases: Array<[input: string, type: string, name: string, version: string]> = [
    ["pkg:gem/rails@7.0.0", "gem", "rails", "7.0.0"],
    ["gem/rails@7.0.0", "gem", "rails", "7.0.0"],
    ["pkg:npm/@babel/core@7.20.0", "npm", "core", "7.20.0"],
    ["pkg:maven/org.apache.commons/commons-lang3@3.12.0", "maven", "commons-lang3", "3.12.0"],
  ];

  it.each(cases)("%s", (input, type, name, version) => {
    const purl = parsePurl(input);
    expect(purl.type).toBe(type);
    expect(purl.name).toBe(name);
    expect(purl.version).toBe(version);
  });

  it("keeps the scope as the namespace for scoped npm packages", () => {
    expect(parsePurl("pkg:npm/@babel/core@7.20.0").namespace).toBe("@babel");
  });

  it("round-trips a golang namespace containing slashes", () => {
    const purl = parsePurl("pkg:golang/github.com%2Fgo-git/go-git@v5.0.0");
    expect(purlToName(purl)).toBe("github.com/go-git/go-git");
  });

  it("throws on input that is not a PURL", () => {
    expect(() => parsePurl("nonsense")).toThrow();
  });
});

describe("supportedPurlTypes", () => {
  it("includes the common ecosystems and excludes unmapped ones", () => {
    const types = supportedPurlTypes();
    expect(types.length).toBeGreaterThan(0);
    for (const required of ["npm", "gem", "pypi", "maven", "cargo", "golang"]) {
      expect(types).toContain(required);
    }
    for (const unsupported of ["github", "generic", "oci", "rpm"]) {
      expect(types).not.toContain(unsupported);
    }
  });
});

// Guards the hand-written layer in src/purl.ts against drift in the snapshot.
describe("generated snapshot", () => {
  it("pins every purl_type the API leaves without a default", () => {
    for (const type of Object.keys(REGISTRIES_WITHOUT_DEFAULT)) {
      // Unpinned, the ecosystem is unreachable. Pick from REGISTRIES_WITHOUT_DEFAULT.
      expect(PINNED_REGISTRIES).toHaveProperty(type);
      expect(REGISTRIES_WITHOUT_DEFAULT[type]).toContain(PINNED_REGISTRIES[type]);
    }
  });

  it("aliases only onto purl_types the API actually serves", () => {
    for (const target of Object.values(PURL_TYPE_ALIASES)) {
      expect(purlTypesInSnapshot()).toContain(target);
    }
    for (const target of Object.values(DEB_VENDOR_TO_PURL_TYPE)) {
      expect(purlTypesInSnapshot()).toContain(target);
    }
  });

  it("does not claim a registry is absent when the API serves one", () => {
    // These short-circuit to null before the snapshot is read, so an entry that gains a
    // registry upstream would be suppressed rather than returned.
    for (const type of PURL_TYPES_WITHOUT_REGISTRY) {
      expect(purlTypesInSnapshot()).not.toContain(type);
    }
  });

  it("covers every purl_type the API serves", () => {
    for (const type of purlTypesInSnapshot()) {
      expect(purlToRegistry({ type, name: "x" } as PackageURL)).not.toBeNull();
    }
  });

  const purlTypesInSnapshot = () => [
    ...Object.keys(DEFAULT_REGISTRY_BY_PURL_TYPE),
    ...Object.keys(REGISTRIES_WITHOUT_DEFAULT),
  ];
});

describe("prototype keys", () => {
  // `constructor` is a valid PURL type per the spec grammar, and a bare index lookup
  // returned the Object constructor -- truthy, typed string, interpolated into a URL.
  it("does not resolve Object.prototype members as registries", () => {
    expect(purlToRegistry(parsePurl("pkg:constructor/foo"))).toBeNull();
  });
});
