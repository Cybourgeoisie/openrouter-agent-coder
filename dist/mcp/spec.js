/**
 * Phase 5.2.1 — Shared MCP types.
 *
 * Re-exports the slice of `@modelcontextprotocol/sdk/types.js` that downstream
 * cards (5.2.2 HTTP transport, 5.2.4 tool-bridge) will consume. Going through
 * this module keeps deep SDK subpath imports off the rest of the codebase so a
 * future vendor swap (or pin bump) is a one-file change.
 *
 * All re-exports are `type`-only — no runtime value is pulled in here, so this
 * module has zero side-effects on import. The SDK is loaded lazily inside
 * [[McpStdioClient.connect]] and [[McpHttpClient.connect]] instead.
 */
export {};
//# sourceMappingURL=spec.js.map