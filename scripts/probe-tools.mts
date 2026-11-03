// Live smoke test of the read-only tools against the user's real Picnic account, after a
// picnic-api upgrade: each tool runs through its real handler and prints a one-line summary.
// Nothing is written: no cart, slot, recipe or delivery changes. Run:
// npx tsx scripts/probe-tools.mts [search term]
import { toolRegistry } from "../src/tools/registry.js"
import "../src/tools/picnic-tools.js"
import { initializePicnicClient } from "../src/utils/picnic-client.js"

const term = process.argv[2] ?? "melk"
type Payload = Record<string, any>

let failures = 0

/** Runs one tool and prints `summarize(payload)`, or the error. Returns the payload or null. */
async function probe(
  name: string,
  args: Record<string, unknown>,
  summarize: (payload: Payload) => string,
): Promise<Payload | null> {
  const tool = toolRegistry.getToolsList().find((candidate) => candidate.name === name)
  if (!tool?.annotations?.readOnlyHint) throw new Error(`${name} is not a read-only tool`)
  const started = Date.now()
  try {
    const result = await toolRegistry.executeTool(name, args)
    const payload = JSON.parse(result.content[0].text ?? "null")
    console.log(`ok   ${name} (${Date.now() - started} ms): ${summarize(payload)}`)
    return payload
  } catch (error) {
    failures++
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

await initializePicnicClient()

const search = await probe(
  "picnic_search",
  { query: term, limit: 3 },
  (p) => `${p.pagination.total} results, first: ${JSON.stringify(p.results[0])}`,
)
await probe("picnic_search_many", { queries: [term, "kipfilet", "broccoli"], limit: 1 }, (p) =>
  p.searches.map((s: Payload) => `${s.query}=${s.error ?? s.total}`).join(", "),
)
await probe("picnic_get_suggestions", { query: term }, (p) => `${p.suggestions.length} suggestions`)

const productId: string | undefined = search?.results[0]?.id
if (productId) {
  await probe("picnic_get_product_details", { productId }, (p) => JSON.stringify(p))
  await probe(
    "picnic_get_product_details",
    { productId, full: true },
    (p) => `${p.infoSections?.length} info sections, allergens ${JSON.stringify(p.allergenGroups)}`,
  )
  await probe("picnic_check_products", { product_ids: [productId], flag_keywords: ["melk"] }, (p) =>
    JSON.stringify(p.products[0]).slice(0, 300),
  )
}

await probe(
  "picnic_get_promotions",
  { limit: 3, sort: "discount" },
  (p) => `${p.pagination.total} promotions, first: ${p.promotions[0]?.name}`,
)
await probe(
  "picnic_get_cart",
  {},
  (p) =>
    `${p.items.length} lines, total_count ${p.total_count}, total_price ${p.total_price}, ` +
    `first: ${JSON.stringify(p.items[0] ?? null)}`,
)
await probe(
  "picnic_get_overview",
  {},
  (p) =>
    `cart ${JSON.stringify(p.cart)}, slot ${JSON.stringify(p.selected_slot)}, ` +
    `${p.current_deliveries.length} current deliveries`,
)
await probe(
  "picnic_get_delivery_slots",
  {},
  (p) => `${p.slots.length} slots, selected ${JSON.stringify(p.selectedSlot)}`,
)

const deliveries = await probe(
  "picnic_get_deliveries",
  { limit: 3 },
  (p) => `${p.pagination.total} deliveries, first: ${JSON.stringify(p.deliveries[0] ?? null)}`,
)
const deliveryId: string | undefined = deliveries?.deliveries[0]?.id
if (deliveryId) {
  await probe(
    "picnic_get_delivery",
    { deliveryId },
    (p) =>
      `status ${p.status}, ${p.orders?.length} orders, ${p.totalCount} products, total ${p.totalPrice}`,
  )
}

await probe(
  "picnic_get_page",
  { page_id: "category-tree-root", max_chars: 1000 },
  (p) => `format ${p.format}, ${p.totalChars} chars`,
)
await probe("picnic_browse_recipes", { limit: 3 }, (p) => `${p.pagination.total} recipes`)
await probe("picnic_get_saved_recipes", { limit: 3 }, (p) => `${p.pagination.total} saved`)
const own = await probe("picnic_get_own_recipes", { limit: 3 }, (p) => `${p.pagination.total} own`)

const ownRecipeId: string | undefined = own?.recipes[0]?.recipeId
if (ownRecipeId) {
  await probe(
    "picnic_get_own_recipe",
    { recipe_url_or_id: ownRecipeId },
    (p) => `${p.name}: ${p.portions} portions, ${p.ingredients.length} ingredients`,
  )
  await probe(
    "picnic_get_recipe_ingredients",
    { recipe_url_or_id: ownRecipeId },
    (p) => `${p.ingredients?.length} ingredients`,
  )
}

console.log(failures === 0 ? "\nAll probes passed." : `\n${failures} probe(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
