export {
  type BulkLookupFailure,
  type BulkLookupResult,
  createEcosystemsClient,
  DEFAULT_TIMEOUT_MS,
  EcosystemsClient,
  type EcosystemsClientOptions,
  MAX_BULK_LOOKUP_SIZE,
  type RequestOptions,
} from "./client.js";

export {
  EcosystemsError,
  type EcosystemsErrorOptions,
  looksLikeNetworkError,
  NETWORK_HINT,
  RATE_LIMIT_HINT,
} from "./errors.js";
export { DEFAULT_SERVERS, type ServiceName } from "./generated/servers.js";
export { applyIdentity, createEcosystemsFetch, type Identity } from "./http.js";

export {
  capItems,
  DEFAULT_MAX_PAGES,
  DEFAULT_PER_PAGE,
  followLinkedPages,
  nextLink,
  pageBudget,
  paginateLinked,
  perPageForCap,
} from "./paginate.js";

export {
  PackageURL,
  PURL_TYPE_TO_REGISTRY,
  parsePurl,
  purlToName,
  purlToRegistry,
  supportedPurlTypes,
} from "./purl.js";
export { parseRateLimit, type RateLimit } from "./ratelimit.js";
export {
  backoffDelay,
  createRetryingFetch,
  DEFAULT_RETRY_ATTEMPTS,
  DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RETRY_MAX_DELAY_MS,
  type FetchLike,
  RETRYABLE_METHODS,
  RETRYABLE_STATUS,
  type RetryOptions,
  retryAfterDelay,
} from "./retry.js";

export type * from "./types.js";
