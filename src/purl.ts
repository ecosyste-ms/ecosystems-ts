import { PackageURL } from "packageurl-js";

import {
  DEFAULT_REGISTRY_BY_PURL_TYPE,
  REGISTRIES_WITHOUT_DEFAULT,
} from "./generated/registries.js";

/**
 * PURL type -> ecosyste.ms `purl_type`, where the two vocabularies disagree.
 *
 * No registry anywhere in `GET /registries` has `purl_type: "deb"` or `"apk"`; it uses
 * `debian`, `ubuntu` and `alpine`. Without this, the PURLs users write resolve to null.
 *
 * `deb` here covers the vendorless case only -- see {@link DEB_VENDOR_TO_PURL_TYPE}.
 */
export const PURL_TYPE_ALIASES: Readonly<Record<string, string>> = {
  apk: "alpine",
  deb: "debian",
};

/**
 * `deb` namespace (the distro vendor) -> ecosyste.ms `purl_type`.
 *
 * `deb` has no default repository: the vendor lives in the namespace
 * (`pkg:deb/ubuntu/curl`) because Debian and Ubuntu are different archives. A vendor that
 * is not here resolves to null rather than falling back to Debian, since a wrong-distro
 * 404 reads as "package not found".
 */
export const DEB_VENDOR_TO_PURL_TYPE: Readonly<Record<string, string>> = {
  debian: "debian",
  ubuntu: "ubuntu",
};

/**
 * Fallbacks for `purl_type` values the API serves without flagging any registry `default`.
 *
 * Alpine and postmarketOS publish one registry per release and mark none. Both pin the
 * rolling branch, so neither needs bumping. The API's `default` still wins if one appears.
 */
export const PINNED_REGISTRIES: Readonly<Record<string, string>> = {
  alpine: "alpine-edge",
  postmarketos: "postmarketos-master",
};

/**
 * PURL types with no ecosyste.ms registry at all.
 *
 * Absence is not in the API data, so this is hand-written: it distinguishes "there is
 * nothing" from "we have not looked".
 */
export const PURL_TYPES_WITHOUT_REGISTRY: readonly string[] = [
  "alpm",
  "bitbucket",
  "bitnami",
  "chef",
  "chocolatey",
  "generic",
  "github",
  "oci",
  "rpm",
];

const WITHOUT_REGISTRY = new Set(PURL_TYPES_WITHOUT_REGISTRY);

/** Resolves one ecosyste.ms `purl_type`, preferring the API's `default` over our pin. */
function registryForEcosystemsType(type: string): string | null {
  if (Object.hasOwn(DEFAULT_REGISTRY_BY_PURL_TYPE, type)) {
    return DEFAULT_REGISTRY_BY_PURL_TYPE[type] || null;
  }
  if (Object.hasOwn(PINNED_REGISTRIES, type)) return PINNED_REGISTRIES[type] || null;
  return null;
}

/**
 * Maps PURL types to ecosyste.ms registry *names*.
 *
 * Bulk lookup takes PURLs, but the per-package endpoints are
 * `/registries/{registry}/packages/{name}`, and a registry name is not a PURL type.
 *
 * Derived from the generated snapshot plus the hand-written layer above. Keys span both
 * vocabularies: `debian` and `deb` both resolve. Empty string means "known type, no
 * registry"; {@link purlToRegistry} normalises those to null.
 */
export const PURL_TYPE_TO_REGISTRY: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries([
    ...Object.keys(DEFAULT_REGISTRY_BY_PURL_TYPE).map(
      (type) => [type, registryForEcosystemsType(type) ?? ""] as const,
    ),
    ...Object.keys(REGISTRIES_WITHOUT_DEFAULT).map(
      (type) => [type, registryForEcosystemsType(type) ?? ""] as const,
    ),
    ...Object.entries(PURL_TYPE_ALIASES).map(
      ([purlType, type]) => [purlType, registryForEcosystemsType(type) ?? ""] as const,
    ),
    ...PURL_TYPES_WITHOUT_REGISTRY.map((type) => [type, ""] as const),
  ]),
);

/**
 * The ecosyste.ms registry name for a PURL, or null when the type has no registry.
 *
 * `Object.hasOwn` rather than a bare lookup: `constructor` is a valid PURL type per the
 * spec's grammar, and a plain index would return `Object` itself -- truthy, typed
 * `string`, and interpolated straight into a URL path.
 */
export function purlToRegistry(purl: PackageURL): string | null {
  const type = purl.type.toLowerCase();

  if (type === "deb" && purl.namespace) {
    const vendor = Object.hasOwn(DEB_VENDOR_TO_PURL_TYPE, purl.namespace.toLowerCase())
      ? DEB_VENDOR_TO_PURL_TYPE[purl.namespace.toLowerCase()]
      : undefined;
    return vendor ? registryForEcosystemsType(vendor) : null;
  }

  if (WITHOUT_REGISTRY.has(type)) return null;

  const alias = Object.hasOwn(PURL_TYPE_ALIASES, type) ? PURL_TYPE_ALIASES[type] : undefined;
  return registryForEcosystemsType(alias ?? type);
}

/**
 * Assembles the ecosyste.ms package name from a PURL's namespace and name.
 *
 * The per-ecosystem rules are empirical, not derivable from any spec: Maven joins with a
 * colon, the distro types discard the namespace entirely, everything else joins with a
 * slash.
 */
export function purlToName(purl: PackageURL): string {
  const { namespace, name, type } = purl;
  if (!namespace) return name;

  switch (type) {
    case "maven":
      // Maven uses colon separator for group:artifact
      return `${namespace}:${name}`;
    case "apk":
    case "deb":
      // The namespace is the distro vendor, which the registry name already encodes:
      // `/registries/debian-12/packages/debian%2Fcurl` is a 404, `.../curl` is a 200.
      return name;
    default:
      // Most ecosystems use slash separator
      return `${namespace}/${name}`;
  }
}

/** Parses a PURL string, tolerating a missing `pkg:` scheme (`gem/rails@7.0.0`). */
export function parsePurl(value: string): PackageURL {
  return PackageURL.fromString(value.startsWith("pkg:") ? value : `pkg:${value}`);
}

/** PURL types that have an ecosyste.ms registry mapping. */
export function supportedPurlTypes(): string[] {
  return Object.entries(PURL_TYPE_TO_REGISTRY)
    .filter(([, registry]) => registry !== "")
    .map(([type]) => type);
}

export { PackageURL };
