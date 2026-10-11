import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ToolResult } from "../../../src/tools/registry.js"

const mocks = vi.hoisted(() => ({
  initializePicnicClient: vi.fn(),
  sendRequest: vi.fn(),
  verifyPicnic2FACode: vi.fn(),
}))

vi.mock("../../../src/utils/picnic-client.js", () => ({
  getPicnicClient: () => ({
    sendRequest: mocks.sendRequest,
  }),
  initializePicnicClient: mocks.initializePicnicClient,
  saveSession: vi.fn(),
  verifyPicnic2FACode: mocks.verifyPicnic2FACode,
}))

function parseToolResult(result: ToolResult) {
  return JSON.parse(result.content[0].text ?? "")
}

function promoTile({
  productId,
  promotionId,
  name,
  label,
  price,
  originalPrice,
}: {
  productId: string
  promotionId: string
  name: string
  label: string
  price: number
  originalPrice?: number
}) {
  return {
    type: "PML",
    id: `selling-unit-${productId}-tile`,
    analytics: {
      contexts: [
        {
          data: { product_id: productId },
          schema: "iglu:tech.picnic.snowplow.analytics/product/jsonschema/1-0-0",
        },
        {
          data: {
            promotion_id: promotionId,
            promotion_label: label,
            price,
            ...(originalPrice !== undefined && {
              strikethrough_price: originalPrice,
              show_strikethrough_price: true,
            }),
          },
          schema: "iglu:tech.picnic.snowplow.analytics/promotion/jsonschema/1-1-0",
        },
      ],
    },
    content: {
      type: "SELLING_UNIT_TILE",
      sellingUnit: {
        id: productId,
        display_price: price,
        image_id: `image-${productId}`,
        max_count: 12,
        name,
        unit_quantity: "1 stuk",
      },
    },
  }
}

function regularTile() {
  return {
    type: "PML",
    id: "selling-unit-s999-tile",
    analytics: { contexts: [{ data: { product_id: "s999" } }] },
    content: {
      type: "SELLING_UNIT_TILE",
      sellingUnit: {
        id: "s999",
        display_price: 399,
        name: "Regular product",
        unit_quantity: "1 stuk",
      },
    },
  }
}

async function loadTools() {
  vi.resetModules()
  const { toolRegistry } = await import("../../../src/tools/registry.js")
  await import("../../../src/tools/picnic-tools.js")
  return toolRegistry
}

describe("promotions tools", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("fetches weekly Picnic promotions from the all-promos page", async () => {
    const firstTile = promoTile({
      productId: "s100",
      promotionId: "promo-1",
      name: "Discount tomatoes",
      label: "nu €1.99",
      price: 199,
      originalPrice: 249,
    })
    mocks.sendRequest.mockResolvedValue({
      layout: {
        body: {
          children: [
            firstTile,
            regularTile(),
            [
              promoTile({
                productId: "s200",
                promotionId: "promo-2",
                name: "Bonus pasta",
                label: "1+1 gratis",
                price: 239,
              }),
              firstTile,
            ],
          ],
        },
      },
    })

    const toolRegistry = await loadTools()
    const result = await toolRegistry.executeTool("picnic_get_promotions", {})
    const payload = parseToolResult(result)

    expect(mocks.sendRequest).toHaveBeenCalledWith(
      "GET",
      "/pages/promo-page-all-promos-redirect",
      null,
      true,
    )
    expect(payload.promotions).toEqual([
      {
        product_id: "s100",
        promotion_id: "promo-1",
        name: "Discount tomatoes",
        price: 199,
        unit: "1 stuk",
        promotion_label: "nu €1.99",
        original_price: 249,
        discount_percent: 20,
        image_id: "image-s100",
        max_count: 12,
      },
      {
        product_id: "s200",
        promotion_id: "promo-2",
        name: "Bonus pasta",
        price: 239,
        unit: "1 stuk",
        promotion_label: "1+1 gratis",
        image_id: "image-s200",
        max_count: 12,
      },
    ])
    expect(payload.pagination).toEqual({
      offset: 0,
      limit: 25,
      returned: 2,
      total: 2,
      hasMore: false,
    })
  })

  it("paginates promotions after deduplicating repeated tiles", async () => {
    mocks.sendRequest.mockResolvedValue({
      layout: {
        body: [
          promoTile({
            productId: "s100",
            promotionId: "promo-1",
            name: "Discount tomatoes",
            label: "nu €1.99",
            price: 199,
          }),
          promoTile({
            productId: "s200",
            promotionId: "promo-2",
            name: "Bonus pasta",
            label: "1+1 gratis",
            price: 239,
          }),
          promoTile({
            productId: "s300",
            promotionId: "promo-3",
            name: "Deal soap",
            label: "2 voor €5",
            price: 279,
          }),
        ],
      },
    })

    const toolRegistry = await loadTools()
    const result = await toolRegistry.executeTool("picnic_get_promotions", {
      offset: 1,
      limit: 1,
    })
    const payload = parseToolResult(result)

    expect(payload.promotions).toEqual([
      expect.objectContaining({
        product_id: "s200",
        promotion_id: "promo-2",
      }),
    ])
    expect(payload.pagination).toEqual({
      offset: 1,
      limit: 1,
      returned: 1,
      total: 3,
      hasMore: true,
    })
  })

  describe("filtering and sorting", () => {
    function promotionsPage() {
      return {
        layout: {
          body: [
            promoTile({
              productId: "s100",
              promotionId: "promo-1",
              name: "Kipfilet",
              label: "nu €4.99",
              price: 499,
              originalPrice: 599,
            }),
            promoTile({
              productId: "s200",
              promotionId: "promo-2",
              name: "Crème fraîche",
              label: "1+1 gratis",
              price: 129,
            }),
            promoTile({
              productId: "s300",
              promotionId: "promo-3",
              name: "Kippendijen",
              label: "nu €3.49",
              price: 349,
              originalPrice: 699,
            }),
            promoTile({
              productId: "s400",
              promotionId: "promo-4",
              name: "Bonus pasta",
              label: "1+1 gratis",
              price: 239,
            }),
          ],
        },
      }
    }

    function productIds(payload: { promotions: Array<{ product_id: string }> }) {
      return payload.promotions.map((promotion) => promotion.product_id)
    }

    it("filters on name and promotion label, ignoring case and accents", async () => {
      mocks.sendRequest.mockResolvedValue(promotionsPage())

      const toolRegistry = await loadTools()
      const byName = parseToolResult(
        await toolRegistry.executeTool("picnic_get_promotions", { query: "KIP" }),
      )
      const byAccentlessName = parseToolResult(
        await toolRegistry.executeTool("picnic_get_promotions", { query: "creme" }),
      )
      const byLabel = parseToolResult(
        await toolRegistry.executeTool("picnic_get_promotions", { query: "1+1" }),
      )

      expect(productIds(byName)).toEqual(["s100", "s300"])
      expect(productIds(byAccentlessName)).toEqual(["s200"])
      expect(productIds(byLabel)).toEqual(["s200", "s400"])
    })

    it("sorts by discount, highest first, with promotions without a discount last", async () => {
      mocks.sendRequest.mockResolvedValue(promotionsPage())

      const toolRegistry = await loadTools()
      const payload = parseToolResult(
        await toolRegistry.executeTool("picnic_get_promotions", { sort: "discount" }),
      )

      expect(
        payload.promotions.map(({ product_id, discount_percent }: Record<string, unknown>) => [
          product_id,
          discount_percent,
        ]),
      ).toEqual([
        ["s300", 50],
        ["s100", 17],
        ["s200", undefined],
        ["s400", undefined],
      ])
    })

    // Paginating first would make total count promotions the caller never asked for, and
    // could hide matches on pages the caller would not think to fetch.
    it("filters and sorts before paginating, so total counts only the matches", async () => {
      mocks.sendRequest.mockResolvedValue(promotionsPage())

      const toolRegistry = await loadTools()
      const payload = parseToolResult(
        await toolRegistry.executeTool("picnic_get_promotions", {
          query: "kip",
          sort: "discount",
          limit: 1,
        }),
      )

      expect(productIds(payload)).toEqual(["s300"])
      expect(payload.pagination).toEqual({
        offset: 0,
        limit: 1,
        returned: 1,
        total: 2,
        hasMore: true,
      })
    })
  })
})
