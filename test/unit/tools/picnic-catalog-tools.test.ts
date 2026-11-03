import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ToolResult } from "../../../src/tools/registry.js"

const mocks = vi.hoisted(() => ({
  // The product sections of a search, each a list of product tiles.
  searchSections: vi.fn(),
  getProduct: vi.fn(),
  initializePicnicClient: vi.fn(),
}))

vi.mock("../../../src/utils/picnic-client.js", () => ({
  getPicnicClient: () => ({
    catalog: {
      getSearchResults: async (query: string) => {
        const sections: unknown[][] = await mocks.searchSections(query)
        return {
          query,
          correctedQuery: null,
          products: {
            sections: sections.map((products, index) => ({
              id: `section-${index}`,
              type: "VISUAL",
              title: null,
              products,
            })),
          },
          recipes: [],
        }
      },
      getProduct: mocks.getProduct,
    },
    sendRequest: vi.fn(),
  }),
  initializePicnicClient: mocks.initializePicnicClient,
  saveSession: vi.fn(),
  verifyPicnic2FACode: vi.fn(),
}))

function parseToolResult(result: ToolResult) {
  return JSON.parse(result.content[0].text ?? "")
}

function productTile(id: string, name: string) {
  return {
    id,
    name,
    namePrefix: null,
    brand: null,
    qualityCue: null,
    imageId: `image-${id}`,
    displayPrice: 199,
    originalPrice: null,
    unitPrice: null,
    priceRanges: null,
    unitQuantity: "500 gram",
    labels: [],
    isUnavailable: false,
    numberOfOrders: null,
  }
}

/** A search whose results come in one section. */
function searchResults(products: unknown[]) {
  return [products]
}

async function loadTools() {
  vi.resetModules()
  const { toolRegistry } = await import("../../../src/tools/registry.js")
  await import("../../../src/tools/picnic-tools.js")
  return toolRegistry
}

describe("picnic_search_many", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns the top results per query, in input order, with each query's total", async () => {
    mocks.searchSections.mockImplementation(async (query: string) =>
      query === "broccoli"
        ? searchResults([productTile("s1", "Broccoli")])
        : searchResults([productTile("s2", "Kipfilet"), productTile("s3", "Kipdijfilet")]),
    )

    const toolRegistry = await loadTools()
    const payload = parseToolResult(
      await toolRegistry.executeTool("picnic_search_many", {
        queries: ["kipfilet", "broccoli"],
        limit: 1,
      }),
    )

    expect(mocks.searchSections.mock.calls).toEqual([["kipfilet"], ["broccoli"]])
    expect(payload.searches).toEqual([
      {
        query: "kipfilet",
        results: [
          { id: "s2", name: "Kipfilet", price: 199, unit: "500 gram", image_id: "image-s2" },
        ],
        total: 2,
      },
      {
        query: "broccoli",
        results: [
          { id: "s1", name: "Broccoli", price: 199, unit: "500 gram", image_id: "image-s1" },
        ],
        total: 1,
      },
    ])
  })

  it("returns the same compact fields as picnic_search", async () => {
    mocks.searchSections.mockResolvedValue(searchResults([productTile("s1", "Broccoli")]))

    const toolRegistry = await loadTools()
    const single = parseToolResult(
      await toolRegistry.executeTool("picnic_search", { query: "broccoli" }),
    )
    const many = parseToolResult(
      await toolRegistry.executeTool("picnic_search_many", { queries: ["broccoli"] }),
    )

    expect(many.searches[0].results).toEqual(single.results)
  })

  it("reports a failed query in its own entry without failing the others", async () => {
    mocks.searchSections.mockImplementation(async (query: string) => {
      if (query === "kapot") throw new Error("Picnic search failed")
      return searchResults([productTile("s1", "Ui")])
    })

    const toolRegistry = await loadTools()
    const payload = parseToolResult(
      await toolRegistry.executeTool("picnic_search_many", { queries: ["ui", "kapot", "ui rood"] }),
    )

    expect(payload.searches).toEqual([
      expect.objectContaining({ query: "ui", total: 1 }),
      { query: "kapot", error: "Picnic search failed" },
      expect.objectContaining({ query: "ui rood", total: 1 }),
    ])
  })

  // Concurrent to keep a 25-query batch fast, but capped so it is not one burst at Picnic.
  it("runs the searches concurrently, at most five at a time", async () => {
    let inFlight = 0
    let maxInFlight = 0
    mocks.searchSections.mockImplementation(async (query: string) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight--
      return searchResults([productTile(query, query)])
    })

    const toolRegistry = await loadTools()
    const queries = Array.from({ length: 12 }, (_, index) => `query ${index}`)
    const payload = parseToolResult(
      await toolRegistry.executeTool("picnic_search_many", { queries }),
    )

    expect(mocks.searchSections).toHaveBeenCalledTimes(12)
    expect(maxInFlight).toBe(5)
    expect(payload.searches.map((search: { query: string }) => search.query)).toEqual(queries)
  })

  // Picnic lists products bought before in a section of their own, ahead of the product groups
  // that hold them too.
  it("lists a product that appears in several sections once, at its first place", async () => {
    mocks.searchSections.mockResolvedValue([
      [productTile("s2", "Kipfilet")],
      [productTile("s1", "Kipfilet bio"), productTile("s2", "Kipfilet")],
    ])

    const toolRegistry = await loadTools()
    const payload = parseToolResult(
      await toolRegistry.executeTool("picnic_search", { query: "kipfilet" }),
    )

    expect(payload.results.map((result: { id: string }) => result.id)).toEqual(["s2", "s1"])
    expect(payload.pagination.total).toBe(2)
  })

  it("rejects an empty batch, a blank query and more than 25 queries before calling Picnic", async () => {
    const toolRegistry = await loadTools()

    for (const queries of [[], ["ui", "  "], Array.from({ length: 26 }, () => "ui")]) {
      await expect(toolRegistry.executeTool("picnic_search_many", { queries })).rejects.toThrow(
        /Invalid input/,
      )
    }
    expect(mocks.searchSections).not.toHaveBeenCalled()
  })

  it("is marked read-only", async () => {
    const toolRegistry = await loadTools()
    const tool = toolRegistry
      .getToolsList()
      .find((candidate) => candidate.name === "picnic_search_many")

    expect(tool?.annotations).toMatchObject({ readOnlyHint: true })
  })
})

/** Allergens as the product page shows them: badges under "Bevat" and "Bevat mogelijk". */
function allergenGroups(contains: string[], mayContain: string[] = []) {
  const badge = (text: string) => ({ text, textColor: "#000000", backgroundColor: "#ffffff" })
  return { contains: contains.map(badge), mayContain: mayContain.map(badge) }
}

function productDetails(overrides: Record<string, unknown> = {}) {
  return {
    id: "s100",
    name: "Kipfilet",
    brand: "Picnic",
    unitQuantity: "300 gram",
    unitPrice: "€13,30/kg",
    displayPrice: 399,
    maxCount: 50,
    imageIds: ["image-s100"],
    description: null,
    highlightItems: [],
    allergenGroups: allergenGroups([]),
    infoSections: [
      { title: "Ingrediënten", content: "kipfilet (100%)" },
      { title: "Voedingswaarde", content: "Energie 450 kJ" },
    ],
    promotion: null,
    priceRanges: null,
    similarProducts: [],
    ...overrides,
  }
}

describe("picnic_check_products", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns name, brand, allergens and the ingredients text for each product", async () => {
    mocks.getProduct.mockResolvedValue(
      productDetails({
        id: "s200",
        name: "Pesto verde",
        brand: "Barilla",
        allergenGroups: allergenGroups(["Melk", "Cashewnoten"]),
        infoSections: [
          { title: "Extra informatie", content: "Na openen gekoeld bewaren" },
          { title: "Ingrediënten", content: "basilicum (38%), zonnebloemolie, **kaas** (melk)" },
        ],
      }),
    )

    const toolRegistry = await loadTools()
    const payload = parseToolResult(
      await toolRegistry.executeTool("picnic_check_products", { product_ids: ["s200"] }),
    )

    expect(mocks.getProduct).toHaveBeenCalledWith("s200")
    // Without flag_keywords there is nothing to flag, so no flags field.
    expect(payload.products).toEqual([
      {
        id: "s200",
        name: "Pesto verde",
        brand: "Barilla",
        allergens: ["Melk", "Cashewnoten"],
        ingredients: "basilicum (38%), zonnebloemolie, kaas (melk)",
      },
    ])
  })

  it("flags keywords in name, ingredients and allergens, ignoring case and accents", async () => {
    mocks.getProduct.mockImplementation(async (id: string) => {
      if (id === "s1") {
        return productDetails({
          id,
          name: "Saucijzenbroodje",
          infoSections: [
            { title: "Ingrediënten", content: "Bladerdeeg, VARKENSVLEES (40%), roomboter, ui" },
          ],
        })
      }
      if (id === "s2") {
        return productDetails({
          id,
          name: "Crème fraîche",
          allergenGroups: allergenGroups(["Melk"]),
        })
      }
      return productDetails({ id, name: "Broccoli", infoSections: [] })
    })

    const toolRegistry = await loadTools()
    const payload = parseToolResult(
      await toolRegistry.executeTool("picnic_check_products", {
        product_ids: ["s1", "s2", "s3"],
        flag_keywords: ["varken", "boter", "creme", "melk"],
      }),
    )

    expect(payload.products.map((product: { flags: unknown }) => product.flags)).toEqual([
      { varken: ["varkensvlees"], boter: ["roomboter"] },
      { creme: ["creme"], melk: ["melk"] },
      {},
    ])
  })

  // Matching inside words is what catches compounds like varkensvlees, so it also hits words
  // that merely contain the keyword. Reporting the word lets the caller see that.
  it("reports the words a keyword was found in, so accidental hits are recognisable", async () => {
    mocks.getProduct.mockResolvedValue(
      productDetails({
        name: "Roerbakgroente",
        infoSections: [{ title: "Ingrediënten", content: "champignons, paprika, ui" }],
      }),
    )

    const toolRegistry = await loadTools()
    const payload = parseToolResult(
      await toolRegistry.executeTool("picnic_check_products", {
        product_ids: ["s100"],
        flag_keywords: ["ham"],
      }),
    )

    expect(payload.products[0].flags).toEqual({ ham: ["champignons"] })
  })

  // An empty flags object must not read as "clean" when there was nothing to search.
  it("returns ingredients as null when the product has no ingredients section", async () => {
    mocks.getProduct.mockResolvedValue(
      productDetails({
        brand: null,
        infoSections: [{ title: "Voedingswaarde", content: "Energie 450 kJ" }],
      }),
    )

    const toolRegistry = await loadTools()
    const payload = parseToolResult(
      await toolRegistry.executeTool("picnic_check_products", {
        product_ids: ["s100"],
        flag_keywords: ["varken"],
      }),
    )

    expect(payload.products[0]).toEqual({
      id: "s100",
      name: "Kipfilet",
      allergens: [],
      ingredients: null,
      flags: {},
    })
  })

  it("lists traces apart from the allergens and flags keywords in them too", async () => {
    mocks.getProduct.mockResolvedValue(
      productDetails({ allergenGroups: allergenGroups(["Melk"], ["Noten", "Pinda's"]) }),
    )

    const toolRegistry = await loadTools()
    const payload = parseToolResult(
      await toolRegistry.executeTool("picnic_check_products", {
        product_ids: ["s100"],
        flag_keywords: ["noten"],
      }),
    )

    expect(payload.products[0]).toMatchObject({
      allergens: ["Melk"],
      may_contain: ["Noten", "Pinda's"],
      flags: { noten: ["noten"] },
    })
  })

  it("reports a failing product in its own entry without failing the others", async () => {
    mocks.getProduct.mockImplementation(async (id: string) => {
      if (id === "s404") throw new Error("Product not found")
      return productDetails({ id })
    })

    const toolRegistry = await loadTools()
    const payload = parseToolResult(
      await toolRegistry.executeTool("picnic_check_products", {
        product_ids: ["s100", "s404", "s300"],
      }),
    )

    expect(payload.products).toEqual([
      expect.objectContaining({ id: "s100", name: "Kipfilet" }),
      { id: "s404", error: "Product not found" },
      expect.objectContaining({ id: "s300", name: "Kipfilet" }),
    ])
  })

  it("rejects more than 20 products before calling Picnic", async () => {
    const toolRegistry = await loadTools()

    await expect(
      toolRegistry.executeTool("picnic_check_products", {
        product_ids: Array.from({ length: 21 }, (_, index) => `s${index}`),
      }),
    ).rejects.toThrow(/Invalid input/)
    expect(mocks.getProduct).not.toHaveBeenCalled()
  })

  it("is marked read-only", async () => {
    const toolRegistry = await loadTools()
    const tool = toolRegistry
      .getToolsList()
      .find((candidate) => candidate.name === "picnic_check_products")

    expect(tool?.annotations).toMatchObject({ readOnlyHint: true })
  })
})
