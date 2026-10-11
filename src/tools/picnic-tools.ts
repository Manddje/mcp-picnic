import { z } from "zod"
import PicnicClient from "picnic-api"
import { toolRegistry, mcpContent } from "./registry.js"
import {
  getPicnicClient,
  initializePicnicClient,
  saveSession,
  verifyPicnic2FACode,
} from "../utils/picnic-client.js"
import {
  resolveRecipeId,
  parseSellingGroupRecipe,
  parseRecipeList,
  buildRecipeSourceUrl,
  buildImageUrl,
} from "../utils/recipe-parser.js"
import {
  buildShoppingList,
  findMealCombinations,
  parseRecipeIngredients,
} from "../utils/recipe-meal-planning.js"
import { config } from "../config.js"

/**
 * Picnic API tools optimized for LLM consumption
 *
 * Optimizations applied:
 * - Search results are filtered to essential fields only (id, name, price, unit, image_id)
 * - Pagination added to search and deliveries tools to prevent context overflow
 * - Cart data is filtered to reduce verbosity while keeping essential information
 * - Default limits set to reasonable values (10 for search, 10 for deliveries)
 */

// Helper function to ensure client is initialized
async function ensureClientInitialized() {
  try {
    getPicnicClient()
  } catch {
    // Client not initialized, initialize it now
    await initializePicnicClient()
  }
}

/**
 * Runs a cart mutation, converting failures into an explicitly ambiguous error.
 *
 * Picnic applies the mutation and renders the updated cart in the same request, so a
 * non-2xx response does not mean the write was rejected — it may already have landed and
 * only the render failed. A caller that reads such an error as "nothing happened" will
 * retry, and each retry applies the change again. Say so instead of reporting a clean
 * failure, and point the caller at a read rather than a retry.
 */
async function mutateCart<T>(action: string, mutation: () => Promise<T>): Promise<T> {
  try {
    return await mutation()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `${action} failed: ${message}. The cart may still have been modified — ` +
        `call picnic_get_cart to check the current contents before retrying, ` +
        `because retrying can apply the change a second time.`,
    )
  }
}

// Annotations shared by every tool that mutates cart contents. Tells the calling model the
// operation is not safe to blindly retry (see mutateCart above).
const CART_MUTATION_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const

// Annotations for tools that only read from Picnic: they change nothing, so a failed call is
// safe to repeat.
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const

// Helper function to filter cart data for LLM consumption
function filterCartData(cart: unknown) {
  if (!cart || typeof cart !== "object") return cart

  const cartObj = cart as {
    type?: string
    id?: string
    items?: Array<{
      id?: string
      display_price?: number
      price?: number
      items?: Array<{
        id?: string
        name?: string
        unit_quantity?: string
        price?: number
        image_ids?: string[]
        max_count?: number
        decorators?: Array<{ type?: string; quantity?: number }>
      }>
    }>
    total_count?: number
    total_price?: number
    checkout_total_price?: number
    total_savings?: number
  }

  const filteredItems = cartObj.items?.map((orderLine) => ({
    order_line_id: orderLine.id,
    price: orderLine.display_price || orderLine.price,
    articles: orderLine.items?.map((article) => ({
      product_id: article.id,
      name: article.name,
      unit: article.unit_quantity,
      price: article.price,
      // How many of this article are in the cart. Picnic carries it in a QUANTITY decorator
      // rather than a plain field; without it a caller cannot tell one unit from three, so it
      // cannot check whether an ambiguous add actually landed (see mutateCart).
      quantity: article.decorators?.find((d) => d.type === "QUANTITY")?.quantity ?? 1,
      ...(article.image_ids?.length && { image_id: article.image_ids[0] }),
    })),
  }))

  return {
    type: cartObj.type,
    id: cartObj.id,
    items: filteredItems,
    total_count: cartObj.total_count,
    total_price: cartObj.total_price,
    checkout_total_price: cartObj.checkout_total_price,
    total_savings: cartObj.total_savings,
  }
}

type UnknownRecord = Record<string, unknown>

interface PicnicPromotionProduct {
  product_id: string
  promotion_id: string
  name: string
  price: number
  unit?: string
  promotion_label?: string
  original_price?: number
  discount_percent?: number
  image_id?: string
  max_count?: number
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function getRecordProperty(record: UnknownRecord, key: string): UnknownRecord | null {
  const value = record[key]
  return isRecord(value) ? value : null
}

function getPromotionContext(tile: UnknownRecord): UnknownRecord | null {
  const analytics = getRecordProperty(tile, "analytics")
  const contexts = analytics?.contexts
  if (!Array.isArray(contexts)) return null

  for (const context of contexts) {
    if (!isRecord(context)) continue
    const data = getRecordProperty(context, "data")
    if (typeof data?.promotion_id === "string") return data
  }

  return null
}

function toPromotionProduct(tile: UnknownRecord): PicnicPromotionProduct | null {
  const content = getRecordProperty(tile, "content")
  const sellingUnit = content ? getRecordProperty(content, "sellingUnit") : null
  const promotion = getPromotionContext(tile)

  if (!sellingUnit || !promotion) return null
  if (typeof sellingUnit.id !== "string" || typeof sellingUnit.name !== "string") return null
  if (typeof promotion.promotion_id !== "string") return null

  const price =
    typeof promotion.price === "number"
      ? promotion.price
      : typeof sellingUnit.display_price === "number"
        ? sellingUnit.display_price
        : null
  if (price === null) return null

  const originalPrice =
    typeof promotion.strikethrough_price === "number" &&
    promotion.show_strikethrough_price !== false
      ? promotion.strikethrough_price
      : undefined

  return {
    product_id: sellingUnit.id,
    promotion_id: promotion.promotion_id,
    name: sellingUnit.name,
    price,
    ...(typeof sellingUnit.unit_quantity === "string" && { unit: sellingUnit.unit_quantity }),
    ...(typeof promotion.promotion_label === "string" && {
      promotion_label: promotion.promotion_label,
    }),
    ...(originalPrice !== undefined && { original_price: originalPrice }),
    // Lets callers rank deals. Only computable when Picnic shows the old price, which it does
    // not for deals such as "1+1 gratis".
    ...(originalPrice !== undefined &&
      originalPrice > 0 && {
        discount_percent: Math.round((1 - price / originalPrice) * 100),
      }),
    ...(typeof sellingUnit.image_id === "string" && { image_id: sellingUnit.image_id }),
    ...(typeof sellingUnit.max_count === "number" && { max_count: sellingUnit.max_count }),
  }
}

function extractPromotionsFromPage(page: unknown): PicnicPromotionProduct[] {
  const promotions: PicnicPromotionProduct[] = []
  const seen = new Set<string>()

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }

    if (!isRecord(node)) return

    const promotion = toPromotionProduct(node)
    if (promotion) {
      const key = `${promotion.product_id}:${promotion.promotion_id}`
      if (!seen.has(key)) {
        seen.add(key)
        promotions.push(promotion)
      }
    }

    for (const value of Object.values(node)) visit(value)
  }

  visit(page)
  return promotions
}

/** Lowercases text and strips its accents, so "Crème" matches "creme". */
function normalizeText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
}

/** Orders promotions by discount, highest first; promotions without a known discount go last. */
function compareDiscountDescending(a: PicnicPromotionProduct, b: PicnicPromotionProduct): number {
  if (a.discount_percent === undefined) return b.discount_percent === undefined ? 0 : 1
  if (b.discount_percent === undefined) return -1
  return b.discount_percent - a.discount_percent
}

/**
 * Applies picnic_get_promotions' query filter and sort order. Runs before pagination, so
 * offset, limit and total all refer to the filtered list.
 */
function selectPromotions(
  promotions: PicnicPromotionProduct[],
  query: string | undefined,
  sort: "page" | "discount",
): PicnicPromotionProduct[] {
  const needle = query === undefined ? undefined : normalizeText(query)
  const selected =
    needle === undefined
      ? [...promotions]
      : promotions.filter((promotion) =>
          [promotion.name, promotion.promotion_label].some(
            (text) => text !== undefined && normalizeText(text).includes(needle),
          ),
        )
  // Array.prototype.sort is stable, so promotions with equal discounts keep the app's order.
  if (sort === "discount") selected.sort(compareDiscountDescending)
  return selected
}

// How many Picnic requests a batch tool keeps in flight at once: enough to get through a batch
// of 20-odd items quickly, without firing all of them at Picnic in the same instant.
const BATCH_CONCURRENCY = 5

/**
 * Returns a runner that lets at most `max` of the tasks given to it run at the same time; the
 * others wait, in order, for a free slot.
 */
function concurrencyLimit(max: number) {
  let active = 0
  const waiting: Array<() => void> = []
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < max) active++
    else await new Promise<void>((resolve) => waiting.push(resolve))
    try {
      return await task()
    } finally {
      // Hand the slot straight to the next waiting task instead of freeing it, so a task
      // arriving in between cannot take it as well.
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
}

// picnic-api does not export its domain types from the package root, so derive them.
type CatalogService = ReturnType<typeof getPicnicClient>["catalog"]
type SearchProduct = Awaited<ReturnType<CatalogService["search"]>>[number]

/** The compact product fields the search tools return. */
function toSearchResult(product: SearchProduct) {
  return {
    id: product.id,
    name: product.name,
    price: product.display_price,
    unit: product.unit_quantity,
    // Only include image_id if it exists, for potential image retrieval
    ...(product.image_id && { image_id: product.image_id }),
  }
}

// Search products tool
const searchInputSchema = z.object({
  query: z.string().describe("Search query for products"),
  limit: z
    .number()
    .min(1)
    .max(20)
    .default(5)
    .describe("Maximum number of results to return (1-20, default: 5)"),
  offset: z
    .number()
    .min(0)
    .default(0)
    .describe("Number of results to skip for pagination (default: 0)"),
})

toolRegistry.register({
  name: "picnic_search",
  description: "Search for products in Picnic with pagination and filtered results",
  inputSchema: searchInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const allResults = await client.catalog.search(args.query)

    // Apply pagination
    const startIndex = args.offset || 0
    const limit = args.limit || 5
    const paginatedResults = allResults.slice(startIndex, startIndex + limit)

    // Filter results to only include essential data for LLM
    const filteredResults = paginatedResults.map(toSearchResult)

    return {
      query: args.query,
      results: filteredResults,
      pagination: {
        offset: startIndex,
        limit,
        returned: filteredResults.length,
        total: allResults.length,
        hasMore: startIndex + limit < allResults.length,
      },
    }
  },
})

// Batch search tool
//
// Planning a week of meals means searching 20-odd ingredients; one call for all of them saves a
// round trip per ingredient. Each query is searched on its own, so one failure loses only its
// own results.
const SEARCH_MANY_MAX_QUERIES = 25

toolRegistry.register({
  name: "picnic_search_many",
  description:
    "Search Picnic for several products in one call, e.g. all ingredients of a weekly menu, " +
    "instead of calling picnic_search once per product. Returns the top results per query (id, " +
    "name, price, unit, image_id) plus the query's total hit count, in input order. A query " +
    "that fails gets an entry with its error and does not fail the others.",
  inputSchema: z.object({
    queries: z
      .array(z.string().trim().min(1))
      .min(1)
      .max(SEARCH_MANY_MAX_QUERIES)
      .describe(`Search queries, up to ${SEARCH_MANY_MAX_QUERIES}, e.g. ["kipfilet", "broccoli"].`),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe("Maximum number of results per query (1-20, default: 5)"),
  }),
  annotations: READ_ONLY_ANNOTATIONS,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const limit = args.limit ?? 5
    const run = concurrencyLimit(BATCH_CONCURRENCY)
    const settled = await Promise.allSettled(
      args.queries.map((query) => run(() => client.catalog.search(query))),
    )

    return {
      searches: settled.map((result, index) => {
        const query = args.queries[index]
        if (result.status === "rejected") return { query, error: getErrorMessage(result.reason) }
        return {
          query,
          results: result.value.slice(0, limit).map(toSearchResult),
          total: result.value.length,
        }
      }),
    }
  },
})

// Weekly promotions/deals tool
const promotionsInputSchema = z.object({
  limit: z
    .number()
    .min(1)
    .max(100)
    .default(25)
    .describe("Maximum number of promotions to return (1-100, default: 25)"),
  offset: z
    .number()
    .min(0)
    .default(0)
    .describe("Number of promotions to skip for pagination (default: 0)"),
  query: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Only return promotions whose name or promotion label contains this text, ignoring case " +
        "and accents, e.g. 'kip' or '1+1'.",
    ),
  sort: z
    .enum(["page", "discount"])
    .default("page")
    .describe(
      "'page' keeps the app's order (default). 'discount' puts the highest discount_percent " +
        "first; promotions without one, such as '1+1 gratis', come last.",
    ),
})

toolRegistry.register({
  name: "picnic_get_promotions",
  description:
    "Get Picnic's current weekly promotions/deals from the app's 'Alle acties' page. " +
    "Returns promoted products with current price, promotion label, original price and " +
    "discount_percent when Picnic shows the old price, and pagination. Filter with query and " +
    "sort by discount to find relevant deals without paging through all of them; total then " +
    "counts the matching promotions only.",
  inputSchema: promotionsInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const page = await client.sendRequest(
      "GET",
      "/pages/promo-page-all-promos-redirect",
      null,
      true,
    )
    const matching = selectPromotions(
      extractPromotionsFromPage(page),
      args.query,
      args.sort ?? "page",
    )

    const startIndex = args.offset ?? 0
    const limit = args.limit ?? 25
    const promotions = matching.slice(startIndex, startIndex + limit)

    return {
      source: {
        pageId: "promo-page-all-promos-redirect",
        endpoint: "/pages/promo-page-all-promos-redirect",
      },
      promotions,
      pagination: {
        offset: startIndex,
        limit,
        returned: promotions.length,
        total: matching.length,
        hasMore: startIndex + limit < matching.length,
      },
    }
  },
})

// Get product suggestions tool
const suggestionsInputSchema = z.object({
  query: z.string().describe("Query for product suggestions"),
})

toolRegistry.register({
  name: "picnic_get_suggestions",
  description: "Get product suggestions based on a query",
  inputSchema: suggestionsInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const suggestions = await client.catalog.getSuggestions(args.query)
    return {
      query: args.query,
      suggestions,
    }
  },
})

// Note: picnic_get_article tool removed - endpoint deprecated (GitHub issue #23)
// Use picnic_search instead for basic product information

// Get product details tool
const productDetailsInputSchema = z.object({
  productId: z
    .string()
    .describe("The product selling unit ID (e.g. 's1001524'), as returned by search or cart"),
  full: z
    .boolean()
    .default(false)
    .describe(
      "When false (default), returns essential fields only (id, name, brand, price, unit, image). " +
        "When true, returns full details including description, allergens, nutritional info, promotions, and similar products.",
    ),
})

toolRegistry.register({
  name: "picnic_get_product_details",
  description:
    "Look up product details by ID. Returns essential info by default (name, brand, price, unit, image). " +
    "Set full=true for complete details including description, allergens, ingredients, and similar products. " +
    "Use this to resolve opaque product IDs from cart or order history.",
  inputSchema: productDetailsInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const details = await client.catalog.getProductDetails(args.productId)

    if (args.full) {
      return details
    }

    return {
      id: details.id,
      name: details.name,
      brand: details.brand,
      price: details.displayPrice,
      unit: details.unitQuantity,
      ...(details.imageIds.length > 0 && { image_id: details.imageIds[0] }),
    }
  },
})

// Batch product check tool
//
// Checking a week's products for dietary needs (no pork, no lactose) otherwise takes a full
// details call per product. This returns only what such a check needs, for many at once.
const CHECK_PRODUCTS_MAX = 20
// Words reported per flagged keyword: enough to tell a real hit from an accidental one.
const FLAG_WORDS_MAX = 3

type ProductDetails = Awaited<ReturnType<CatalogService["getProductDetails"]>>

// Ingredients section titles after normalizeText: "Ingrediënten" (NL), "Ingrédients" (FR) and
// "Zutaten" (DE).
const INGREDIENTS_TITLE_RE = /ingredi|zutaten/
const WORD_CHAR_RE = /[\p{L}\p{N}]/u

/** The text of a product's ingredients section without markdown emphasis, or null if none. */
function getIngredientsText(details: ProductDetails): string | null {
  const text = (details.infoSections ?? [])
    .filter((section) => INGREDIENTS_TITLE_RE.test(normalizeText(section.title)))
    .map((section) => section.content.replace(/\*\*|__/g, "").trim())
    .filter(Boolean)
    .join("\n")
  return text || null
}

/**
 * Returns the words of `text` that contain `keyword`, ignoring case and accents. Matching inside
 * words catches Dutch compounds (varken in varkensvlees, boter in roomboter); returning the
 * whole word lets the caller dismiss accidental hits (ham in champignons).
 */
function findKeywordWords(text: string, keyword: string): string[] {
  const haystack = normalizeText(text)
  const needle = normalizeText(keyword)
  if (!needle) return []

  const words = new Set<string>()
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    let start = at
    let end = at + needle.length
    while (start > 0 && WORD_CHAR_RE.test(haystack[start - 1])) start--
    while (end < haystack.length && WORD_CHAR_RE.test(haystack[end])) end++
    words.add(haystack.slice(start, end))
  }
  return [...words]
}

/** The fields a dietary check needs, plus the keyword hits when keywords are given. */
function toProductCheck(details: ProductDetails, keywords: string[] | undefined) {
  const allergens = details.allergens ?? []
  const ingredients = getIngredientsText(details)
  const check = {
    id: details.id,
    name: details.name,
    ...(details.brand && { brand: details.brand }),
    allergens,
    // null rather than left out, so a missing ingredients list cannot pass for a clean one
    ingredients,
  }
  if (!keywords?.length) return check

  const texts = [details.name, ingredients ?? "", ...allergens]
  const flags: Record<string, string[]> = {}
  for (const keyword of keywords) {
    const words = [...new Set(texts.flatMap((text) => findKeywordWords(text, keyword)))]
    if (words.length > 0) flags[keyword] = words.slice(0, FLAG_WORDS_MAX)
  }
  return { ...check, flags }
}

toolRegistry.register({
  name: "picnic_check_products",
  description:
    "Check up to 20 products in one call, e.g. for dietary needs: returns each product's name, " +
    "brand, allergens and ingredients text. With flag_keywords it also lists, per product, " +
    "which keywords occur in its name, allergens or ingredients and in which words, so " +
    "accidental hits (ham in champignons) can be dismissed. No flags is no proof of absence: " +
    "ingredients is null when Picnic lists none. A product that fails gets an entry with its " +
    "error and does not fail the others.",
  inputSchema: z.object({
    product_ids: z
      .array(z.string().min(1))
      .min(1)
      .max(CHECK_PRODUCTS_MAX)
      .describe(
        `Product (selling unit) IDs, up to ${CHECK_PRODUCTS_MAX}, as returned by picnic_search.`,
      ),
    flag_keywords: z
      .array(z.string().trim().min(1))
      .max(20)
      .optional()
      .describe(
        'Words to look for, e.g. ["varken", "spek", "vis", "lactose", "melk"]. Matched ' +
          "ignoring case and accents, also inside longer words (varken finds varkensvlees).",
      ),
  }),
  annotations: READ_ONLY_ANNOTATIONS,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const run = concurrencyLimit(BATCH_CONCURRENCY)
    const settled = await Promise.allSettled(
      args.product_ids.map((id) => run(() => client.catalog.getProductDetails(id))),
    )

    return {
      products: settled.map((result, index) =>
        result.status === "fulfilled"
          ? toProductCheck(result.value, args.flag_keywords)
          : { id: args.product_ids[index], error: getErrorMessage(result.reason) },
      ),
    }
  },
})

// Get product image tool
const imageInputSchema = z.object({
  imageId: z.string().describe("The ID of the image to retrieve"),
  size: z
    .enum(["tiny", "small", "medium", "large", "extra-large"])
    .describe("The size of the image"),
})

toolRegistry.register({
  name: "picnic_get_image",
  description:
    "Get a product image by image ID and size. Returns the image itself as MCP image content.",
  inputSchema: imageInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const image = await client.catalog.getImage(args.imageId, args.size)
    // Picnic serves these as PNG (/static/images/<id>/<size>.png).
    return mcpContent([
      {
        type: "image",
        data: Buffer.from(image).toString("base64"),
        mimeType: "image/png",
      },
    ])
  },
})

// Raw app page tool
//
// Picnic's app is built from server-driven pages. Most are Fusion pages (JSON), but some are
// served as a React Server Components payload instead, depending on the page and app version.
// Page ids may carry query params but no path segments, so this cannot reach other endpoints.
const PAGE_ID_RE = /^[A-Za-z0-9_-]+(?:\?[A-Za-z0-9_\-=&%.]*)?$/

toolRegistry.register({
  name: "picnic_get_page",
  description:
    "Fetch a raw Picnic app page by page ID, as JSON text, for data no other tool covers. " +
    "Handles both page formats (Fusion and React Server Components). Known pages include " +
    "'category-tree-root' (product categories), 'profile-root', " +
    "'promo-group-deep-dive?promo_group_id=<id>', 'L2-category-page-root?category_id=<id>' and " +
    "'delivery-receipt-page?delivery_id=<id>'. Large pages are returned in chunks.",
  inputSchema: z.object({
    page_id: z
      .string()
      .regex(PAGE_ID_RE, "Use a page ID, optionally with query params, e.g. 'profile-root'.")
      .describe("Page ID, optionally with query params, e.g. 'category-tree-root'."),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Character offset into the page JSON, to read the next chunk (default 0)."),
    max_chars: z
      .number()
      .int()
      .min(1000)
      .max(100000)
      .default(20000)
      .describe("Maximum number of characters to return (1000-100000, default 20000)."),
  }),
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()

    let format: "fusion" | "rsc" = "fusion"
    let page: unknown
    try {
      page = await client.app.getPage(args.page_id)
    } catch (error) {
      if (!PicnicClient.isUnexpectedPageFormatError(error) || error.receivedFormat !== "rsc") {
        throw error
      }
      format = "rsc"
      page = await client.app.getRscPage(args.page_id)
    }

    const json = JSON.stringify(page)
    const offset = args.offset ?? 0
    const maxChars = args.max_chars ?? 20000
    const content = json.slice(offset, offset + maxChars)
    return {
      pageId: args.page_id,
      format,
      offset,
      returnedChars: content.length,
      totalChars: json.length,
      hasMore: offset + maxChars < json.length,
      content,
    }
  },
})

// Recipe tools
//
// Picnic recipes are "selling groups". Recipe detail comes from
// /pages/selling-group-details-page?selling_group_id=<id>, and the cookbook /
// recipe overview from /pages/cookbook-page-content. These page routes are
// called directly via sendRequest because the picnic-api recipe.* page methods
// target outdated ids (recipe-details-page-root) that the API answers with 404.

// picnic-api does not export its domain types from the package root, so derive them.
type RecipeService = ReturnType<typeof getPicnicClient>["recipe"]
type AssignSellingGroupToBasketResult = Awaited<
  ReturnType<RecipeService["assignSellingGroupToBasket"]>
>
type RemoveSellingGroupFromBasketResult = Awaited<
  ReturnType<RecipeService["removeSellingGroupFromBasket"]>
>
type RecipeDetails = Awaited<ReturnType<RecipeService["getRecipe"]>>
type SellingGroupSwapType = NonNullable<
  Parameters<RecipeService["updateUserDefinedRecipeIngredient"]>[4]
>

// Base URL for recipe/product image derivatives, derived from the API URL, e.g.
// https://storefront-prod.de.picnicinternational.com/static/images
function recipeImageBaseUrl(client: ReturnType<typeof getPicnicClient>): string {
  return client.url.replace(/\/api\/.*$/, "/static/images")
}

const RECIPE_CATEGORY_INPUT_RE = /^(?:recipe[_-]cattree[_-])?[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?$/i
const RECIPE_CATEGORY_PAGE_ID_RE = /recipe[_-]cattree[_-][a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?/gi
const RECIPE_CATEGORY_PREFIX_RE = /^recipe[_-]cattree[_-]/i

async function fetchRecipePage(client: ReturnType<typeof getPicnicClient>, pageId: string) {
  const page = await client.sendRequest("GET", `/pages/${pageId}`, null, true)
  return { pageId, page }
}

async function fetchRecipeListPage(client: ReturnType<typeof getPicnicClient>, category?: string) {
  if (!category) return fetchRecipePage(client, "cookbook-page-content")

  if (RECIPE_CATEGORY_PREFIX_RE.test(category)) {
    return fetchRecipePage(client, category)
  }

  const underscorePageId = `recipe_cattree_${category}`
  try {
    return await fetchRecipePage(client, underscorePageId)
  } catch (error) {
    const dashPageId = `recipe-cattree-${category}`
    try {
      return await fetchRecipePage(client, dashPageId)
    } catch {
      throw error
    }
  }
}

function extractRecipeCategoryIds(page: unknown): string[] {
  const ids = new Set<string>()

  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      for (const match of node.matchAll(RECIPE_CATEGORY_PAGE_ID_RE)) ids.add(match[0])
      return
    }
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    if (!node || typeof node !== "object") return
    for (const value of Object.values(node as Record<string, unknown>)) visit(value)
  }

  visit(page)
  return [...ids]
}

async function fetchCookbookRecipes(client: ReturnType<typeof getPicnicClient>) {
  const { page } = await fetchRecipeListPage(client)
  return parseRecipeList(page, { imageBaseUrl: recipeImageBaseUrl(client) })
}

function paginateRecipes(all: ReturnType<typeof parseRecipeList>, offset: number, limit: number) {
  const startIndex = offset || 0
  const recipes = all.slice(startIndex, startIndex + limit).map((recipe) => ({
    ...recipe,
    sourceUrl: buildRecipeSourceUrl(config.PICNIC_COUNTRY_CODE, recipe.recipeId),
  }))
  return {
    recipes,
    pagination: {
      offset: startIndex,
      limit,
      returned: recipes.length,
      total: all.length,
      hasMore: startIndex + limit < all.length,
    },
  }
}

// Get recipe tool
const getRecipeInputSchema = z.object({
  recipe_url_or_id: z
    .string()
    .min(1)
    .describe(
      "A Picnic recipe URL (any format) or a 24-character hex recipe ID. " +
        "Examples: 'https://picnic.app/de/go/abc123', " +
        "'https://picnic.app/de/rezepte/0123456789abcdef01234567/example-recipe', " +
        "'0123456789abcdef01234567'",
    ),
  portions: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Render the recipe for this many portions (defaults to the recipe's own count; own recipes accept only multiples of it).",
    ),
})

/** Builds the selling-group detail page route, optionally rendered for a portion count. */
function recipeDetailsPagePath(recipeId: string, portions?: number): string {
  const query = portions === undefined ? "" : `&portions=${portions}`
  return `/pages/selling-group-details-page?selling_group_id=${encodeURIComponent(recipeId)}${query}`
}

const PAGE_RENDER_ERROR_RE = /Error rendering page_id=/
const RECIPE_READ_ATTEMPTS = 3

/**
 * Reads a recipe page, retrying Picnic's page-rendering errors.
 *
 * Picnic briefly fails to render a recipe right after it was changed, so a read straight after
 * an edit can fail once and then succeed. It also persistently refuses own recipes at portion
 * counts that are not a multiple of their default count (verified live: a 4-portion recipe
 * renders at 4, 8 and 12 only); that error still surfaces after the retries, with a hint.
 */
async function readRecipe<T>(read: () => Promise<T>, portions?: number): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read()
    } catch (error) {
      if (!PAGE_RENDER_ERROR_RE.test(getErrorMessage(error))) throw error
      if (attempt < RECIPE_READ_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
        continue
      }
      if (portions === undefined) throw error
      throw new Error(
        `${getErrorMessage(error)}. Picnic renders own recipes only at multiples of their ` +
          `default portion count (e.g. 4, 8 or 12 for a 4-portion recipe); use such a count ` +
          `or omit portions.`,
      )
    }
  }
}

toolRegistry.register({
  name: "picnic_get_recipe",
  description:
    "Fetch a Picnic recipe by URL or recipe ID. Returns structured recipe data: name, " +
    "description, ingredients, preparation steps, timing, servings, image URL, saved state, " +
    "and the canonical source URL. Accepts short share links (picnic.app/de/go/xxx), full " +
    "recipe URLs, or bare recipe IDs. Optionally render it for a different number of portions.",
  inputSchema: getRecipeInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const recipeId = await resolveRecipeId(args.recipe_url_or_id)
    const page = await readRecipe(
      () => client.sendRequest("GET", recipeDetailsPagePath(recipeId, args.portions), null, true),
      args.portions,
    )
    const parsed = parseSellingGroupRecipe(page, { imageBaseUrl: recipeImageBaseUrl(client) })
    const sourceUrl = buildRecipeSourceUrl(config.PICNIC_COUNTRY_CODE, recipeId)
    return { recipeId, sourceUrl, ...parsed }
  },
})

// Browse / saved recipes
const recipeListInputSchema = z.object({
  category: z
    .string()
    .regex(
      RECIPE_CATEGORY_INPUT_RE,
      "Use a bare recipe category ID or a full recipe_cattree/recipe-cattree page ID.",
    )
    .optional()
    .describe(
      "Recipe category ID, such as '20minuten', or full page ID, such as 'recipe-cattree-jamie-oliver'.",
    ),
  limit: z
    .number()
    .min(1)
    .max(100)
    .default(25)
    .describe("Maximum number of recipes to return (1-100, default: 25)"),
  offset: z
    .number()
    .min(0)
    .default(0)
    .describe("Number of recipes to skip for pagination (default: 0)"),
})

toolRegistry.register({
  name: "picnic_browse_recipes",
  description:
    "Browse Picnic's recipe/cookbook overview or a specific recipe category. Returns a " +
    "paginated list of recipes (id, name, image URL, cookbook section, source URL) and " +
    "category page IDs when available. Use the recipeId with picnic_get_recipe for full details.",
  inputSchema: recipeListInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const { pageId, page } = await fetchRecipeListPage(client, args.category)
    const all = parseRecipeList(page, { imageBaseUrl: recipeImageBaseUrl(client) })
    const result = { pageId, ...paginateRecipes(all, args.offset ?? 0, args.limit ?? 25) }
    const categories = extractRecipeCategoryIds(page)
    if ((!args.category || all.length === 0) && categories.length > 0) {
      return { ...result, categories }
    }
    return result
  },
})

toolRegistry.register({
  name: "picnic_get_saved_recipes",
  description:
    "List the recipes the user has saved/favourited in their Picnic cookbook (the " +
    "'Gespeichert' tab), distinct from the public discovery feed. Returns id, name, image URL " +
    "and source URL — useful for importing saved recipes elsewhere.",
  inputSchema: recipeListInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const all = await fetchCookbookRecipes(client)
    const saved = all.filter((recipe) => recipe.segments.includes("SAVED_RECIPES"))
    return paginateRecipes(saved, args.offset ?? 0, args.limit ?? 25)
  },
})

toolRegistry.register({
  name: "picnic_get_own_recipes",
  description:
    "List the user's own recipes (the cookbook 'Eigene Rezepte' tab — user-created recipes). " +
    "Returns id, name, image URL and source URL.",
  inputSchema: recipeListInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const all = await fetchCookbookRecipes(client)
    const own = all.filter((recipe) => recipe.segments.includes("USER_DEFINED_RECIPES"))
    return paginateRecipes(own, args.offset ?? 0, args.limit ?? 25)
  },
})

// Save / unsave recipe
const recipeRefInputSchema = z.object({
  recipe_url_or_id: z
    .string()
    .min(1)
    .describe("A Picnic recipe URL (any format) or a 24-character hex recipe ID."),
})

toolRegistry.register({
  name: "picnic_save_recipe",
  description: "Save a recipe to the user's Picnic cookbook, by URL or recipe ID.",
  inputSchema: recipeRefInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const recipeId = await resolveRecipeId(args.recipe_url_or_id)
    await client.sendRequest(
      "POST",
      "/pages/task/recipe-saving",
      { payload: { recipe_id: recipeId, saved_at: new Date().toISOString() } },
      true,
    )
    return { message: "Recipe saved", recipeId }
  },
})

toolRegistry.register({
  name: "picnic_unsave_recipe",
  description: "Remove a recipe from the user's Picnic cookbook, by URL or recipe ID.",
  inputSchema: recipeRefInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const recipeId = await resolveRecipeId(args.recipe_url_or_id)
    await client.sendRequest(
      "POST",
      "/pages/task/recipe-saving",
      { payload: { recipe_id: recipeId, saved_at: null } },
      true,
    )
    return { message: "Recipe removed from cookbook", recipeId }
  },
})

// Add a recipe's ingredients to the basket by assigning the selling group.
const addRecipeToCartInputSchema = z.object({
  recipe_url_or_id: z
    .string()
    .min(1)
    .describe("A Picnic recipe URL (any format) or a 24-character hex recipe ID."),
  portions: z
    .number()
    .min(1)
    .optional()
    .describe("Number of portions to add (defaults to the recipe's default portions)."),
})

toolRegistry.register({
  name: "picnic_add_recipe_to_cart",
  description:
    "Add a recipe's ingredients to the shopping cart by assigning the recipe (selling group) " +
    "to the basket. Optionally set the number of portions. If this fails, call picnic_get_cart " +
    "to check whether the ingredients landed before retrying.",
  inputSchema: addRecipeToCartInputSchema,
  annotations: CART_MUTATION_ANNOTATIONS,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const recipeId = await resolveRecipeId(args.recipe_url_or_id)
    const payload: { selling_group_id: string; portions?: number } = { selling_group_id: recipeId }
    if (args.portions !== undefined) payload.portions = args.portions
    const result = await mutateCart("Adding the recipe to the cart", () =>
      client.sendRequest<unknown, Partial<AssignSellingGroupToBasketResult> | null>(
        "POST",
        "/pages/task/assign-selling-group-to-basket",
        { payload },
        true,
      ),
    )
    const assignedPortions = result?.assignedNumberOfPortions ?? args.portions
    return {
      message: "Recipe added to cart",
      recipeId,
      ...(assignedPortions !== undefined && { portions: assignedPortions }),
      ...(typeof result?.anyUnavailableIngredient === "boolean" && {
        anyUnavailableIngredient: result.anyUnavailableIngredient,
      }),
    }
  },
})

// Remove a recipe's ingredients from the basket (inverse of add_recipe_to_cart).
toolRegistry.register({
  name: "picnic_remove_recipe_from_cart",
  description:
    "Remove a recipe (selling group) from the basket, undoing picnic_add_recipe_to_cart. " +
    "Removes only that recipe's ingredients, leaving the rest of the cart untouched.",
  inputSchema: recipeRefInputSchema,
  annotations: CART_MUTATION_ANNOTATIONS,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const recipeId = await resolveRecipeId(args.recipe_url_or_id)
    const result = await mutateCart("Removing the recipe from the cart", () =>
      client.sendRequest<unknown, Partial<RemoveSellingGroupFromBasketResult> | null>(
        "POST",
        "/pages/task/remove-selling-group-from-basket",
        { payload: { selling_group_id: recipeId } },
        true,
      ),
    )
    return {
      message: "Recipe removed from cart",
      recipeId,
      ...(Array.isArray(result?.SURemoved) && {
        removedProducts: result.SURemoved.map((line) => ({
          productId: line.selling_unit_id,
          quantity: line.quantity,
        })),
      }),
    }
  },
})

// Own (user-defined) recipe tools
//
// The user's own recipes ("Eigen recepten") are selling groups with a 32-character id. Their
// ingredients are Picnic products (selling units) with a pack count for the recipe's portions,
// plus a free-text note for anything else (steps, non-Picnic ingredients).

// Creating a recipe or adding an ingredient is not idempotent: each call adds another one.
const RECIPE_CREATE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const

// Setting a name, portion count, note or image: repeating the call gives the same result.
const RECIPE_UPDATE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const

// Deleting or replacing recipe data cannot be undone.
const RECIPE_DELETE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const

// The app's limits for user-defined recipes.
const RECIPE_NAME_MAX_LENGTH = 43
const RECIPE_NOTE_MAX_LENGTH = 5000
const RECIPE_IMAGE_MAX_BYTES = 10 * 1024 * 1024

const recipeNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(RECIPE_NAME_MAX_LENGTH)
  .describe(`Recipe name (max ${RECIPE_NAME_MAX_LENGTH} characters, the app's limit).`)

const recipeNoteSchema = z
  .string()
  .min(1)
  .max(RECIPE_NOTE_MAX_LENGTH)
  .describe(
    "Free-text note, e.g. preparation steps or ingredients Picnic does not sell. Plain text; " +
      `each line becomes a paragraph. Max ${RECIPE_NOTE_MAX_LENGTH} characters.`,
  )

const recipePortionsSchema = z.number().int().min(1)

const productIdSchema = z
  .string()
  .min(1)
  .describe("Product (selling unit) ID, e.g. 's1001524', as returned by picnic_search.")

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** Converts a plain-text note to the paragraph HTML the app's note editor produces. */
function noteToHtml(note: string): string {
  return note
    .split(/\r?\n/)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("")
}

/** Converts a stored note (HTML) back to plain text, one line per paragraph. */
function noteHtmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|li|h[1-6])>\s*/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim()
}

function formatRecipeDetails(details: RecipeDetails) {
  return {
    recipeId: details.id,
    name: details.name,
    portions: details.portions,
    defaultPortions: details.defaultPortions,
    creatorType: details.creatorType,
    isRecipeOwner: details.isRecipeOwner,
    isSaved: details.isSaved,
    imageId: details.imageId,
    note: details.note === null ? null : noteHtmlToText(details.note),
    ingredients: details.ingredients.map((ingredient) => ({
      ingredientId: ingredient.ingredientId,
      productId: ingredient.sellingUnitId,
      name: ingredient.name,
      quantity: ingredient.quantity,
      status: ingredient.status,
      ...(ingredient.swapType && { swapType: ingredient.swapType }),
    })),
  }
}

/** Number of distinct ingredients, which the app sends as the position of a new one. */
function countIngredients(details: RecipeDetails): number {
  return new Set(details.ingredients.map((ingredient) => ingredient.ingredientId)).size
}

async function downloadRecipeImage(url: string): Promise<{ data: Uint8Array; type: string }> {
  const parsed = new URL(url)
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("image_url must be an http(s) URL")
  }
  const response = await fetch(parsed)
  if (!response.ok) throw new Error(`Downloading the image failed: HTTP ${response.status}`)

  const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? ""
  if (!type.startsWith("image/")) {
    throw new Error(`image_url did not return an image (content-type: ${type || "unknown"})`)
  }
  if (Number(response.headers.get("content-length")) > RECIPE_IMAGE_MAX_BYTES) {
    throw new Error("The image is larger than 10 MB")
  }
  const data = new Uint8Array(await response.arrayBuffer())
  if (data.byteLength > RECIPE_IMAGE_MAX_BYTES) throw new Error("The image is larger than 10 MB")
  return { data, type }
}

function decodeRecipeImage(base64: string, mimeType?: string): { data: Uint8Array; type: string } {
  // Accept both bare base64 and a data URL, whose media type wins over mime_type.
  const dataUrl = base64.match(/^data:([^;,]+);base64,(.*)$/s)
  const type = (dataUrl?.[1] ?? mimeType ?? "image/jpeg").toLowerCase()
  if (!type.startsWith("image/")) throw new Error(`Unsupported image type: ${type}`)

  const data = new Uint8Array(Buffer.from(dataUrl?.[2] ?? base64, "base64"))
  if (data.byteLength === 0) throw new Error("image_base64 is empty or not valid base64")
  if (data.byteLength > RECIPE_IMAGE_MAX_BYTES) throw new Error("The image is larger than 10 MB")
  return { data, type }
}

toolRegistry.register({
  name: "picnic_get_own_recipe",
  description:
    "Get one of the user's own recipes with its portions, note and ingredients (ingredientId, " +
    "productId, name, pack quantity). Use the ingredientIds with picnic_update_recipe_ingredient " +
    "and picnic_remove_recipe_ingredient. Also works for catalog recipes.",
  inputSchema: z.object({
    recipe_url_or_id: z
      .string()
      .min(1)
      .describe("A Picnic recipe URL or recipe ID, as returned by picnic_get_own_recipes."),
    portions: recipePortionsSchema
      .optional()
      .describe(
        "Return quantities for this many portions (defaults to the recipe's own count; own recipes accept only multiples of it).",
      ),
    resolve_names: z
      .boolean()
      .default(true)
      .describe(
        "Look up product names missing from the recipe page (one request per product). " +
          "Set to false if those lookups fail.",
      ),
  }),
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const recipeId = await resolveRecipeId(args.recipe_url_or_id)
    const details = await readRecipe(
      () =>
        client.recipe.getRecipe(recipeId, args.portions, {
          resolveIngredientNames: args.resolve_names ?? true,
        }),
      args.portions,
    )
    return formatRecipeDetails(details)
  },
})

toolRegistry.register({
  name: "picnic_create_recipe",
  description:
    "Create a new own recipe in the user's Picnic cookbook ('Eigen recepten') from Picnic " +
    "products. Look up product IDs with picnic_search first; put steps and anything Picnic does " +
    "not sell in the note. Not idempotent: every call creates another recipe. The returned " +
    "recipeId works with every recipe tool, e.g. picnic_add_recipe_to_cart.",
  inputSchema: z.object({
    name: recipeNameSchema,
    ingredients: z
      .array(
        z.object({
          product_id: productIdSchema,
          quantity: z
            .number()
            .int()
            .min(1)
            .default(1)
            .describe("Number of packs for the recipe's portions (default 1)."),
        }),
      )
      .min(1)
      .max(100)
      .describe("The Picnic products in the recipe."),
    portions: recipePortionsSchema
      .default(4)
      .describe("Number of portions the quantities are for (default 4)."),
    note: recipeNoteSchema.optional(),
  }),
  annotations: RECIPE_CREATE_ANNOTATIONS,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const portions = args.portions ?? 4

    // The create task keys quantities by product, so merge repeated products.
    const quantities = new Map<string, number>()
    for (const ingredient of args.ingredients) {
      const quantity = ingredient.quantity ?? 1
      quantities.set(ingredient.product_id, (quantities.get(ingredient.product_id) ?? 0) + quantity)
    }

    const { sellingGroupId } = await client.recipe.createUserDefinedRecipe(
      args.name,
      [...quantities].map(([sellingUnitId, quantity]) => ({ sellingUnitId, quantity })),
      portions,
    )
    const created = {
      message: "Recipe created",
      recipeId: sellingGroupId,
      name: args.name,
      portions,
    }
    if (args.note === undefined) return created

    // The recipe exists at this point, so report a failed note instead of failing the call;
    // a retry of the whole tool would create a duplicate recipe.
    try {
      await client.recipe.setUserDefinedRecipeNote(sellingGroupId, noteToHtml(args.note))
      return { ...created, noteSet: true }
    } catch (error) {
      return {
        ...created,
        noteSet: false,
        noteError: `${getErrorMessage(error)}. Set it with picnic_set_recipe_note.`,
      }
    }
  },
})

const ownRecipeRefSchema = z
  .string()
  .min(1)
  .describe("The user's own recipe: a Picnic recipe URL or 32-character recipe ID.")

toolRegistry.register({
  name: "picnic_rename_recipe",
  description: "Rename one of the user's own recipes.",
  inputSchema: z.object({ recipe_url_or_id: ownRecipeRefSchema, name: recipeNameSchema }),
  annotations: RECIPE_UPDATE_ANNOTATIONS,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const recipeId = await resolveRecipeId(args.recipe_url_or_id)
    await client.recipe.renameUserDefinedRecipe(recipeId, args.name)
    return { message: "Recipe renamed", recipeId, name: args.name }
  },
})

toolRegistry.register({
  name: "picnic_update_recipe_portions",
  description:
    "Change the default number of portions of one of the user's own recipes. Picnic scales " +
    "the ingredient quantities along.",
  inputSchema: z.object({
    recipe_url_or_id: ownRecipeRefSchema,
    portions: recipePortionsSchema.describe("The new default number of portions."),
  }),
  annotations: RECIPE_UPDATE_ANNOTATIONS,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const recipeId = await resolveRecipeId(args.recipe_url_or_id)
    await client.recipe.updateUserDefinedRecipePortions(recipeId, args.portions)
    return { message: "Recipe portions updated", recipeId, portions: args.portions }
  },
})

toolRegistry.register({
  name: "picnic_delete_recipe",
  description:
    "Permanently delete one of the user's own recipes, including its ingredients and note. " +
    "This does not touch the cart: if the recipe is in it, remove it first with " +
    "picnic_remove_recipe_from_cart.",
  inputSchema: z.object({ recipe_url_or_id: ownRecipeRefSchema }),
  annotations: RECIPE_DELETE_ANNOTATIONS,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const recipeId = await resolveRecipeId(args.recipe_url_or_id)
    await client.recipe.deleteUserDefinedRecipe(recipeId)
    return { message: "Recipe deleted", recipeId }
  },
})

toolRegistry.register({
  name: "picnic_add_recipe_ingredient",
  description:
    "Add a Picnic product as a new ingredient to one of the user's own recipes. Not " +
    "idempotent: each call adds another ingredient. To change the quantity of an existing " +
    "ingredient use picnic_update_recipe_ingredient instead.",
  inputSchema: z.object({
    recipe_url_or_id: ownRecipeRefSchema,
    product_id: productIdSchema,
    quantity: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe("Number of packs for `portions` portions (default 1)."),
    portions: recipePortionsSchema
      .optional()
      .describe(
        "Portion count the quantity is for (defaults to the recipe's own count; own recipes accept only multiples of it).",
      ),
  }),
  annotations: RECIPE_CREATE_ANNOTATIONS,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const recipeId = await resolveRecipeId(args.recipe_url_or_id)
    const quantity = args.quantity ?? 1
    // The app appends the new ingredient after the existing ones and states the portion count
    // its quantity is for, so read both from the recipe.
    const details = await readRecipe(
      () => client.recipe.getRecipe(recipeId, args.portions),
      args.portions,
    )
    const result = await client.recipe.addUserDefinedRecipeIngredient(
      recipeId,
      args.product_id,
      quantity,
      details.portions,
      countIngredients(details),
    )
    return {
      message: "Ingredient added",
      recipeId,
      ingredientId: result.newComponentId,
      productId: args.product_id,
      quantity,
      portions: details.portions,
    }
  },
})

toolRegistry.register({
  name: "picnic_update_recipe_ingredient",
  description:
    "Change the pack quantity of an ingredient in one of the user's own recipes, or swap it " +
    "for another product by passing product_id. Get ingredientIds from picnic_get_own_recipe. " +
    "If the recipe is in the cart, the cart is updated to match.",
  inputSchema: z.object({
    recipe_url_or_id: ownRecipeRefSchema,
    ingredient_id: z.string().min(1).describe("The ingredientId, from picnic_get_own_recipe."),
    quantity: z.number().int().min(1).describe("Number of packs for `portions` portions."),
    product_id: productIdSchema
      .optional()
      .describe("Swap the ingredient to this product (omit to keep the current product)."),
    portions: recipePortionsSchema
      .optional()
      .describe(
        "Portion count the quantity is for (defaults to the recipe's own count; own recipes accept only multiples of it).",
      ),
  }),
  annotations: RECIPE_DELETE_ANNOTATIONS,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const recipeId = await resolveRecipeId(args.recipe_url_or_id)
    const details = await readRecipe(
      () => client.recipe.getRecipe(recipeId, args.portions),
      args.portions,
    )

    const current = details.ingredients.filter(
      (ingredient) => ingredient.ingredientId === args.ingredient_id,
    )
    if (current.length === 0) {
      throw new Error(
        `Ingredient ${args.ingredient_id} is not part of recipe ${recipeId}. ` +
          `Call picnic_get_own_recipe to list its ingredientIds.`,
      )
    }
    const currentProductIds = current.map((ingredient) => ingredient.sellingUnitId).filter(Boolean)
    const productId =
      args.product_id ?? (currentProductIds.length === 1 ? currentProductIds[0] : undefined)
    if (!productId) {
      throw new Error(
        `Ingredient ${args.ingredient_id} has ${currentProductIds.length} products; ` +
          `pass product_id to choose which one to keep.`,
      )
    }

    // For an ingredient with several products, the app zeroes the ones not selected. For a
    // single-product ingredient Picnic fails to render the edit when the old product is sent
    // with quantity 0, so only the new selection is sent. The swap type reflects where the new
    // product came from: the ingredient's own products, or search.
    const quantities: Record<string, number> = { [productId]: args.quantity }
    if (currentProductIds.length > 1) {
      for (const id of currentProductIds) if (id !== productId) quantities[id] = 0
    }
    let swapType: SellingGroupSwapType | undefined
    if (!currentProductIds.includes(productId)) swapType = "SEARCH_SELECTION"
    else if (currentProductIds.length > 1) swapType = "WITHIN_SELLING_GROUP_COMPONENT"
    else swapType = current[0].swapType ?? undefined

    const result = await client.recipe.updateUserDefinedRecipeIngredient(
      recipeId,
      args.ingredient_id,
      quantities,
      details.portions,
      swapType,
    )

    // When the recipe is in the cart, the edit removes the replaced product but leaves adding
    // the new selection to a follow-up call, without which the cart lacks the ingredient.
    let cartUpdated = false
    if (result?.shouldUpdateCart) {
      await mutateCart("Updating the ingredient in the cart", () =>
        client.recipe.assignSellableComponentToDay(
          recipeId,
          args.ingredient_id,
          { [productId]: args.quantity },
          details.portions,
          swapType ?? "WITHIN_SELLING_GROUP_COMPONENT",
        ),
      )
      cartUpdated = true
    }

    return {
      message: "Ingredient updated",
      recipeId,
      ingredientId: args.ingredient_id,
      productId,
      quantity: args.quantity,
      portions: details.portions,
      cartUpdated,
    }
  },
})

toolRegistry.register({
  name: "picnic_remove_recipe_ingredient",
  description:
    "Remove an ingredient from one of the user's own recipes. Get ingredientIds from " +
    "picnic_get_own_recipe.",
  inputSchema: z.object({
    recipe_url_or_id: ownRecipeRefSchema,
    ingredient_id: z.string().min(1).describe("The ingredientId, from picnic_get_own_recipe."),
  }),
  annotations: RECIPE_DELETE_ANNOTATIONS,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const recipeId = await resolveRecipeId(args.recipe_url_or_id)
    await client.recipe.removeUserDefinedRecipeIngredient(recipeId, args.ingredient_id)
    return { message: "Ingredient removed", recipeId, ingredientId: args.ingredient_id }
  },
})

toolRegistry.register({
  name: "picnic_set_recipe_note",
  description:
    "Set or replace the free-text note of one of the user's own recipes, e.g. preparation " +
    "steps or ingredients Picnic does not sell.",
  inputSchema: z.object({ recipe_url_or_id: ownRecipeRefSchema, note: recipeNoteSchema }),
  annotations: RECIPE_UPDATE_ANNOTATIONS,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const recipeId = await resolveRecipeId(args.recipe_url_or_id)
    await client.recipe.setUserDefinedRecipeNote(recipeId, noteToHtml(args.note))
    return { message: "Recipe note set", recipeId }
  },
})

toolRegistry.register({
  name: "picnic_delete_recipe_note",
  description: "Delete the note of one of the user's own recipes.",
  inputSchema: z.object({ recipe_url_or_id: ownRecipeRefSchema }),
  annotations: RECIPE_DELETE_ANNOTATIONS,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const recipeId = await resolveRecipeId(args.recipe_url_or_id)
    await client.recipe.deleteUserDefinedRecipeNote(recipeId)
    return { message: "Recipe note deleted", recipeId }
  },
})

toolRegistry.register({
  name: "picnic_get_recipe_image_suggestions",
  description:
    "List the images Picnic suggests for one of the user's own recipes. Pick one with " +
    "picnic_set_recipe_image.",
  inputSchema: z.object({ recipe_url_or_id: ownRecipeRefSchema }),
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const recipeId = await resolveRecipeId(args.recipe_url_or_id)
    const suggestions = await client.recipe.getUserDefinedRecipeSuggestedImages(recipeId)
    return {
      recipeId,
      images: suggestions.map((suggestion) => ({
        imageId: suggestion.id,
        imageUrl: buildImageUrl(
          suggestion.id,
          suggestion.referenceImage.namespace,
          recipeImageBaseUrl(client),
        ),
      })),
    }
  },
})

toolRegistry.register({
  name: "picnic_set_recipe_image",
  description:
    "Set the image of one of the user's own recipes: a suggested image " +
    "(suggested_image_id, from picnic_get_recipe_image_suggestions) or an uploaded photo " +
    "(image_url to download, or image_base64). Pass exactly one of them.",
  inputSchema: z.object({
    recipe_url_or_id: ownRecipeRefSchema,
    suggested_image_id: z
      .string()
      .min(1)
      .optional()
      .describe("An imageId from picnic_get_recipe_image_suggestions."),
    image_url: z
      .string()
      .url()
      .optional()
      .describe("An http(s) URL of a photo to upload (max 10 MB)."),
    image_base64: z
      .string()
      .min(1)
      .optional()
      .describe("A photo to upload, as base64 or a data URL (max 10 MB)."),
    mime_type: z
      .string()
      .optional()
      .describe("MIME type of image_base64, e.g. 'image/png' (default image/jpeg)."),
  }),
  annotations: RECIPE_UPDATE_ANNOTATIONS,
  handler: async (args) => {
    const sources = [args.suggested_image_id, args.image_url, args.image_base64].filter(
      (source) => source !== undefined,
    )
    if (sources.length !== 1) {
      throw new Error("Pass exactly one of suggested_image_id, image_url or image_base64")
    }

    await ensureClientInitialized()
    const client = getPicnicClient()
    const recipeId = await resolveRecipeId(args.recipe_url_or_id)

    if (args.suggested_image_id !== undefined) {
      const suggestions = await client.recipe.getUserDefinedRecipeSuggestedImages(recipeId)
      const suggestion = suggestions.find((image) => image.id === args.suggested_image_id)
      if (!suggestion) {
        throw new Error(
          `${args.suggested_image_id} is not a suggested image for this recipe. ` +
            `Call picnic_get_recipe_image_suggestions for the current suggestions.`,
        )
      }
      await client.recipe.selectUserDefinedRecipeImage(
        recipeId,
        suggestion.id,
        suggestion.referenceImage,
      )
      return { message: "Recipe image set", recipeId, imageId: suggestion.id }
    }

    const image =
      args.image_url !== undefined
        ? await downloadRecipeImage(args.image_url)
        : decodeRecipeImage(args.image_base64 as string, args.mime_type)
    const upload = await client.recipe.uploadUserDefinedRecipeImage(recipeId, image)
    const imageId = upload.image_id ?? upload.imageId
    if (!imageId) {
      throw new Error(
        `Picnic accepted the upload but returned no image id: ${JSON.stringify(upload)}`,
      )
    }
    await client.recipe.selectUserDefinedRecipeImage(recipeId, imageId)
    return { message: "Recipe image uploaded and set", recipeId, imageId }
  },
})

// Recipe meal-planning tools
const recipeIngredientsInputSchema = z.object({
  recipe_url_or_id: z
    .string()
    .min(1)
    .describe("A Picnic recipe URL (any format) or a 24- or 32-character hex recipe ID."),
  portions: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Return ingredients for this many portions (defaults to the recipe's own count; own recipes accept only multiples of it).",
    ),
})

async function fetchRecipeIngredientsByRef(
  client: ReturnType<typeof getPicnicClient>,
  recipeUrlOrId: string,
  portions?: number,
) {
  const recipeId = await resolveRecipeId(recipeUrlOrId)
  const page = await readRecipe(
    () => client.sendRequest("GET", recipeDetailsPagePath(recipeId, portions), null, true),
    portions,
  )
  const parsed = parseRecipeIngredients(page)
  if (!parsed) throw new Error(`Could not find recipe ingredient data for ${recipeId}`)
  return parsed
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

toolRegistry.register({
  name: "picnic_get_recipe_ingredients",
  description:
    "Fetch structured Picnic recipe ingredients by recipe URL or ID. Returns selling-unit IDs, " +
    "quantities, pantry flags, package display text, and prices for meal planning.",
  inputSchema: recipeIngredientsInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    return fetchRecipeIngredientsByRef(getPicnicClient(), args.recipe_url_or_id, args.portions)
  },
})

toolRegistry.register({
  name: "picnic_get_multiple_recipe_ingredients",
  description:
    "Fetch structured ingredient lists for multiple Picnic recipes. Returns successful recipes " +
    "and per-input errors so one unavailable recipe does not discard the whole batch.",
  inputSchema: z.object({
    recipe_urls_or_ids: z
      .array(z.string().min(1))
      .min(1)
      .max(20)
      .describe("Picnic recipe URLs or 24-/32-character recipe IDs, up to 20."),
  }),
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const results = await Promise.allSettled(
      args.recipe_urls_or_ids.map((input) => fetchRecipeIngredientsByRef(client, input)),
    )

    return {
      recipes: results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
      errors: results.flatMap((result, index) =>
        result.status === "rejected"
          ? [{ input: args.recipe_urls_or_ids[index], error: getErrorMessage(result.reason) }]
          : [],
      ),
    }
  },
})

const recipeIngredientSchema = z.object({
  ingredientId: z.string(),
  sellingUnitId: z.string(),
  name: z.string(),
  packageInfo: z.string(),
  priceCents: z.number().nullable(),
  quantity: z.number(),
  isPantryItem: z.boolean(),
})

const structuredRecipeIngredientsSchema = z.object({
  recipeId: z.string(),
  recipeName: z.string(),
  portions: z.number(),
  ingredients: z.array(recipeIngredientSchema),
})

toolRegistry.register({
  name: "picnic_build_shopping_list",
  description:
    "Consolidate structured recipe ingredients into a shopping list. Skips pantry items, " +
    "deduplicates products per recipe, and totals priceCents times quantity.",
  inputSchema: z.object({
    recipes: z.array(structuredRecipeIngredientsSchema).min(1).max(20),
  }),
  handler: async (args) => buildShoppingList(args.recipes),
})

toolRegistry.register({
  name: "picnic_find_meal_combinations",
  description:
    "Rank combinations of structured Picnic recipes by shared non-pantry ingredients, " +
    "using the same conservative cost calculation as picnic_build_shopping_list.",
  inputSchema: z.object({
    recipes: z.array(structuredRecipeIngredientsSchema).min(2).max(50),
    count: z.number().int().min(2).describe("Number of recipes per combination."),
    topK: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe("Maximum number of combinations to return."),
    maxTotalBudgetCents: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Exclude combinations whose conservative shopping-list cost exceeds this."),
  }),
  handler: async (args) => findMealCombinations(args),
})

// Get shopping cart tool
toolRegistry.register({
  name: "picnic_get_cart",
  description: "Get the current shopping cart contents with filtered data",
  inputSchema: z.object({}),
  handler: async () => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const cart = await client.cart.getCart()
    return filterCartData(cart)
  },
})

// Add product to cart tool
const addToCartInputSchema = z.object({
  productId: z.string().describe("The ID of the product to add"),
  count: z.number().min(1).default(1).describe("Number of items to add"),
})

toolRegistry.register({
  name: "picnic_add_to_cart",
  description:
    "Add a product to the shopping cart. Not idempotent: each call adds another `count` " +
    "items. If this fails, call picnic_get_cart to check whether the add landed before retrying.",
  inputSchema: addToCartInputSchema,
  annotations: CART_MUTATION_ANNOTATIONS,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const cart = await mutateCart(`Adding ${args.count} item(s) to cart`, () =>
      client.cart.addProductToCart(args.productId, args.count),
    )
    return {
      message: `Added ${args.count} item(s) to cart`,
      cart: filterCartData(cart),
    }
  },
})

// Remove product from cart tool
const removeFromCartInputSchema = z.object({
  productId: z.string().describe("The ID of the product to remove"),
  count: z.number().min(1).default(1).describe("Number of items to remove"),
})

toolRegistry.register({
  name: "picnic_remove_from_cart",
  description:
    "Remove a product from the shopping cart. Not idempotent: each call removes another " +
    "`count` items. If this fails, call picnic_get_cart to check whether the removal landed " +
    "before retrying.",
  inputSchema: removeFromCartInputSchema,
  annotations: CART_MUTATION_ANNOTATIONS,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const cart = await mutateCart(`Removing ${args.count} item(s) from cart`, () =>
      client.cart.removeProductFromCart(args.productId, args.count),
    )
    return {
      message: `Removed ${args.count} item(s) from cart`,
      cart: filterCartData(cart),
    }
  },
})

// Clear cart tool
toolRegistry.register({
  name: "picnic_clear_cart",
  description: "Clear all items from the shopping cart",
  inputSchema: z.object({}),
  annotations: CART_MUTATION_ANNOTATIONS,
  handler: async () => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const cart = await mutateCart("Clearing the cart", () => client.cart.clearCart())
    return {
      message: "Shopping cart cleared",
      cart: filterCartData(cart),
    }
  },
})

// Get delivery slots tool
toolRegistry.register({
  name: "picnic_get_delivery_slots",
  description: "Get available delivery time slots",
  inputSchema: z.object({}),
  handler: async () => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const slots = await client.cart.getDeliverySlots()
    return slots
  },
})

// Set delivery slot tool
const setDeliverySlotInputSchema = z.object({
  slotId: z.string().describe("The ID of the delivery slot to select"),
})

toolRegistry.register({
  name: "picnic_set_delivery_slot",
  description: "Select a delivery time slot",
  inputSchema: setDeliverySlotInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const result = await client.cart.setDeliverySlot(args.slotId)
    return {
      message: "Delivery slot selected",
      slotId: args.slotId,
      order: result,
    }
  },
})

// Get deliveries tool
const deliveriesInputSchema = z.object({
  filter: z.array(z.string()).default([]).describe("Filter deliveries by status"),
  limit: z
    .number()
    .min(1)
    .max(50)
    .default(10)
    .describe("Maximum number of deliveries to return (1-50, default: 10)"),
  offset: z
    .number()
    .min(0)
    .default(0)
    .describe("Number of deliveries to skip for pagination (default: 0)"),
})

toolRegistry.register({
  name: "picnic_get_deliveries",
  description: "Get past and current deliveries with pagination",
  inputSchema: deliveriesInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const allDeliveries = await client.delivery.getDeliveries(args.filter as string[])

    // Apply pagination
    const startIndex = args.offset || 0
    const limit = args.limit || 10
    const paginatedDeliveries = allDeliveries.slice(startIndex, startIndex + limit)

    return {
      deliveries: paginatedDeliveries,
      pagination: {
        offset: startIndex,
        limit,
        returned: paginatedDeliveries.length,
        total: allDeliveries.length,
        hasMore: startIndex + limit < allDeliveries.length,
      },
    }
  },
})

// Get specific delivery tool
const deliveryInputSchema = z.object({
  deliveryId: z.string().describe("The ID of the delivery to get details for"),
})

toolRegistry.register({
  name: "picnic_get_delivery",
  description: "Get details of a specific delivery",
  inputSchema: deliveryInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const delivery = await client.delivery.getDelivery(args.deliveryId)
    return delivery
  },
})

// Get delivery position tool
toolRegistry.register({
  name: "picnic_get_delivery_position",
  description: "Get real-time position data for a delivery",
  inputSchema: deliveryInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const position = await client.delivery.getDeliveryPosition(args.deliveryId)
    return position
  },
})

// Get delivery scenario tool
toolRegistry.register({
  name: "picnic_get_delivery_scenario",
  description: "Get driver and route information for a delivery",
  inputSchema: deliveryInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const scenario = await client.delivery.getDeliveryScenario(args.deliveryId)
    return scenario
  },
})

// Cancel delivery tool
toolRegistry.register({
  name: "picnic_cancel_delivery",
  description: "Cancel a delivery order",
  inputSchema: deliveryInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const result = await client.delivery.cancelDelivery(args.deliveryId)
    return {
      message: "Delivery cancelled",
      deliveryId: args.deliveryId,
      result,
    }
  },
})

// Rate delivery tool
const rateDeliveryInputSchema = z.object({
  deliveryId: z.string().describe("The ID of the delivery to rate"),
  rating: z.number().min(0).max(10).describe("Rating from 0 to 10"),
})

toolRegistry.register({
  name: "picnic_rate_delivery",
  description: "Rate a completed delivery",
  inputSchema: rateDeliveryInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const result = await client.delivery.setDeliveryRating(args.deliveryId, args.rating)
    return {
      message: `Delivery rated ${args.rating}/10`,
      deliveryId: args.deliveryId,
      result,
    }
  },
})

// Send delivery invoice email tool
const sendInvoiceEmailInputSchema = z.object({
  deliveryId: z.string().describe("The ID of the delivery to send the invoice email for"),
})

toolRegistry.register({
  name: "picnic_send_delivery_invoice_email",
  description: "Send or resend the invoice email for a completed delivery",
  inputSchema: sendInvoiceEmailInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const result = await client.delivery.sendDeliveryInvoiceEmail(args.deliveryId)
    return {
      message: "Delivery invoice email sent",
      deliveryId: args.deliveryId,
      result,
    }
  },
})

// Get order status tool
const orderStatusInputSchema = z.object({
  orderId: z.string().describe("The ID of the order to get the status for"),
})

toolRegistry.register({
  name: "picnic_get_order_status",
  description: "Get the status of a specific order",
  inputSchema: orderStatusInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const orderStatus = await client.cart.getOrderStatus(args.orderId)
    return orderStatus
  },
})

// Get user details tool
toolRegistry.register({
  name: "picnic_get_user_details",
  description: "Get details of the current logged-in user",
  inputSchema: z.object({}),
  handler: async () => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const user = await client.user.getUserDetails()
    return user
  },
})

// Get user info tool
toolRegistry.register({
  name: "picnic_get_user_info",
  description: "Get user information including toggled features",
  inputSchema: z.object({}),
  handler: async () => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const userInfo = await client.user.getUserInfo()
    return userInfo
  },
})

// Get payment profile tool
toolRegistry.register({
  name: "picnic_get_payment_profile",
  description: "Get payment information and profile",
  inputSchema: z.object({}),
  handler: async () => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const paymentProfile = await client.payment.getPaymentProfile()
    return paymentProfile
  },
})

// Get wallet transactions tool
const walletTransactionsInputSchema = z.object({
  pageNumber: z.number().min(1).default(1).describe("Page number for transaction history"),
})

toolRegistry.register({
  name: "picnic_get_wallet_transactions",
  description: "Get wallet transaction history",
  inputSchema: walletTransactionsInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const pageNumber = args.pageNumber ?? 1
    const transactions = await client.payment.getWalletTransactions(pageNumber)
    return {
      pageNumber,
      transactions,
    }
  },
})

// Get wallet transaction details tool
const walletTransactionDetailsInputSchema = z.object({
  transactionId: z.string().describe("The ID of the transaction to get details for"),
})

toolRegistry.register({
  name: "picnic_get_wallet_transaction_details",
  description: "Get detailed information about a specific wallet transaction",
  inputSchema: walletTransactionDetailsInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const details = await client.payment.getWalletTransactionDetails(args.transactionId as string)
    return details
  },
})

// 2FA tools
const generate2FAInputSchema = z.object({
  channel: z.string().default("SMS").describe("Channel to send 2FA code (SMS, etc.)"),
})

toolRegistry.register({
  name: "picnic_generate_2fa_code",
  description: "Generate a 2FA code for verification",
  inputSchema: generate2FAInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    const client = getPicnicClient()
    const channel = args.channel || "SMS"
    try {
      const result = await client.auth.generate2FACode(channel)
      return {
        message: "2FA code generated and sent",
        channel,
        result,
      }
    } catch (error: unknown) {
      // The Picnic API returns empty bodies for 2FA endpoints, which causes JSON parse errors
      // but the actual request succeeds
      if (error instanceof SyntaxError && (error as Error).message.includes("JSON")) {
        return {
          message: "2FA code generated and sent",
          channel,
        }
      }
      throw error
    }
  },
})

const verify2FAInputSchema = z.object({
  code: z.string().describe("The 2FA code to verify"),
})

toolRegistry.register({
  name: "picnic_verify_2fa_code",
  description: "Verify a 2FA code",
  inputSchema: verify2FAInputSchema,
  handler: async (args) => {
    await ensureClientInitialized()
    await verifyPicnic2FACode(args.code)
    await saveSession()

    return {
      message: "2FA code verified",
      code: args.code,
    }
  },
})
