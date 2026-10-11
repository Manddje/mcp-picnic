# mcp-picnic - Development Guide

## Common Commands

- Build: `npm run build`
- Type Check: `npm run typecheck`
- Lint: `npm run lint`
- Run Tests: `npm test`
- Run Single Test: `npx vitest run test/path/to/test.test.ts`
- Run Tests in Watch Mode: `npm run test:watch`
- Dev Mode (watch & rebuild): `npm run dev`

## Code Style Guidelines

- **Formatting**: Uses Prettier with 100 char width, no semicolons, double quotes
- **TypeScript**: Use strict typing, avoid `any` when possible
- **Imports**: Order from external to internal, group related imports
- **Naming**: Use camelCase for variables/functions, PascalCase for types/interfaces
- **Error Handling**: Always handle errors in async functions with try/catch blocks
- **Documentation**: Add JSDoc style comments for functions and interfaces

## Testing

Tests use Vitest with a lightweight unit testing approach. Current test structure:

- `test/unit/` - Lightweight unit tests for public API functions

Focus on testing behavior, not implementation details. Tool tests mock `src/utils/picnic-client.js`, so the suite never calls the live Picnic API.

## Context

mcp-picnic is an MCP server that lets an LLM use the Picnic online supermarket (NL, DE and FR) through the unofficial [picnic-api](https://github.com/MRVDH/picnic-api) package (4.10): search products and promotions, browse recipes and manage the user's own recipes, plan meals, fill the cart, pick a delivery slot and follow deliveries.

### Layout

- `src/index.ts` - entry point: optional HTTP(S) proxy, Picnic login, then the stdio transport, or Streamable HTTP when `ENABLE_HTTP_SERVER=true`
- `src/config.ts` - environment variables, validated with zod
- `src/tools/` - `registry.ts` (tool registry: zod input schemas, MCP annotations, result formatting) and `picnic-tools.ts` (all Picnic tools)
- `src/prompts/` - `registry.ts` and `picnic-prompts.ts` (all prompts)
- `src/resources/` - resource registry; no resources are registered yet
- `src/transports/` - `base.ts` connects the three registries to the MCP request handlers; `stdio.ts` and `streamable-http.ts` are the transports
- `src/utils/` - Picnic client and session file (`picnic-client.ts`, `device-id.ts`), recipe page parsing (`recipe-parser.ts`), meal planning (`recipe-meal-planning.ts`), outbound proxy, rate limiting and the server factory
- `bin/mcp-server.js` - the `mcp-picnic` CLI: maps flags to env vars and loads `dist/bundle.js`
- `scripts/` - developer tools outside the build and the tests: live probes that run real tool handlers against the Picnic API (see `scripts/README.md`) and MCP Inspector launchers (`npm run inspect`)

### Conventions

- Each tool, prompt and handler has a single responsibility.
- Tools, prompts and resources register themselves when their module is imported; each folder's `index.ts` imports them.
- Every tool declares MCP annotations: `readOnlyHint` for lookups, `destructiveHint` and `idempotentHint` for writes, so clients know what is safe to retry.
- Prompt messages use only the `user` and `assistant` roles; MCP has no `system` role.
- Recipe and page data come from Picnic's server-driven app pages (Fusion or React Server Components), not a stable data API. When a layout change breaks the parsers, the `scripts/` probes show the live structure.
- **No ordering**: placing orders, checkout and payment were removed on purpose and must not come back. The tools stop at the cart and the delivery slot; the user checks out in the Picnic app. Tests guard against checkout or payment tools and against prompts that suggest ordering. `picnic_cancel_delivery` cannot be undone either, so it is only registered with `PICNIC_ENABLE_CANCEL_DELIVERY=true`.
