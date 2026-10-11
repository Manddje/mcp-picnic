import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ToolResult } from "../../../src/tools/registry.js"

const mocks = vi.hoisted(() => ({
  addProductToCart: vi.fn(),
  removeProductFromCart: vi.fn(),
  clearCart: vi.fn(),
  getCart: vi.fn(),
  getDeliveries: vi.fn(),
  initializePicnicClient: vi.fn(),
}))

vi.mock("../../../src/utils/picnic-client.js", () => ({
  getPicnicClient: () => ({
    cart: {
      addProductToCart: mocks.addProductToCart,
      removeProductFromCart: mocks.removeProductFromCart,
      clearCart: mocks.clearCart,
      getCart: mocks.getCart,
    },
    delivery: { getDeliveries: mocks.getDeliveries },
    sendRequest: vi.fn(),
  }),
  initializePicnicClient: mocks.initializePicnicClient,
  saveSession: vi.fn(),
  verifyPicnic2FACode: vi.fn(),
}))

function parseToolResult(result: ToolResult) {
  return JSON.parse(result.content[0].text ?? "")
}

const emptyCart = { type: "ORDER", id: "cart-1", items: [], total_count: 0 }

describe("picnic cart tools", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await import("../../../src/tools/picnic-tools.js")
  })

  describe("mutation failures", () => {
    // Picnic applies the write and renders the cart in one request, so a failure does not
    // mean the write was rejected. The error has to say so, or the caller retries and
    // double-applies the change.
    it("warns that the cart may have changed when add_to_cart fails", async () => {
      const { toolRegistry } = await import("../../../src/tools/registry.js")
      mocks.addProductToCart.mockRejectedValue(
        new Error("Client version is required to preview the cart page"),
      )

      await expect(
        toolRegistry.executeTool("picnic_add_to_cart", { productId: "s1032332", count: 1 }),
      ).rejects.toThrow(/cart may still have been modified/i)
    })

    it("points the caller at picnic_get_cart rather than a retry", async () => {
      const { toolRegistry } = await import("../../../src/tools/registry.js")
      mocks.removeProductFromCart.mockRejectedValue(new Error("boom"))

      await expect(
        toolRegistry.executeTool("picnic_remove_from_cart", { productId: "s1", count: 1 }),
      ).rejects.toThrow(/picnic_get_cart/)
    })

    it("preserves the upstream error message", async () => {
      const { toolRegistry } = await import("../../../src/tools/registry.js")
      mocks.clearCart.mockRejectedValue(new Error("upstream detail"))

      await expect(toolRegistry.executeTool("picnic_clear_cart", {})).rejects.toThrow(
        /upstream detail/,
      )
    })
  })

  describe("successful mutations", () => {
    it("returns the filtered cart on success", async () => {
      const { toolRegistry } = await import("../../../src/tools/registry.js")
      mocks.addProductToCart.mockResolvedValue(emptyCart)

      const result = await toolRegistry.executeTool("picnic_add_to_cart", {
        productId: "s1032332",
        count: 2,
      })

      expect(mocks.addProductToCart).toHaveBeenCalledWith("s1032332", 2)
      expect(parseToolResult(result).message).toBe("Added 2 item(s) to cart")
    })

    it("does not retry the mutation itself", async () => {
      const { toolRegistry } = await import("../../../src/tools/registry.js")
      mocks.addProductToCart.mockRejectedValue(new Error("nope"))

      await expect(
        toolRegistry.executeTool("picnic_add_to_cart", { productId: "s1", count: 1 }),
      ).rejects.toThrow()
      expect(mocks.addProductToCart).toHaveBeenCalledTimes(1)
    })
  })

  describe("annotations", () => {
    it("marks cart mutations as non-idempotent and destructive", async () => {
      const { toolRegistry } = await import("../../../src/tools/registry.js")
      const list = toolRegistry.getToolsList() as Array<{
        name: string
        annotations?: Record<string, boolean>
      }>

      for (const name of [
        "picnic_add_to_cart",
        "picnic_remove_from_cart",
        "picnic_clear_cart",
        "picnic_add_recipe_to_cart",
        "picnic_remove_recipe_from_cart",
      ]) {
        const tool = list.find((t) => t.name === name)
        expect(tool, `${name} should be registered`).toBeDefined()
        expect(tool?.annotations, `${name} should carry annotations`).toMatchObject({
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
        })
      }
    })

    it("leaves read-only tools unannotated", async () => {
      const { toolRegistry } = await import("../../../src/tools/registry.js")
      const list = toolRegistry.getToolsList() as Array<{
        name: string
        annotations?: Record<string, boolean>
      }>

      expect(list.find((t) => t.name === "picnic_get_cart")?.annotations).toBeUndefined()
    })
  })
})

describe("picnic_get_cart quantities", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await import("../../../src/tools/picnic-tools.js")
  })

  // Without this the caller cannot verify whether an ambiguous add landed once or twice,
  // which is exactly what the mutation error message tells it to go and check.
  it("surfaces the QUANTITY decorator as a quantity field", async () => {
    const { toolRegistry } = await import("../../../src/tools/registry.js")
    mocks.getCart.mockResolvedValue({
      type: "ORDER",
      id: "shopping_cart",
      total_count: 2,
      items: [
        {
          type: "ORDER_LINE",
          id: "1871",
          price: 510,
          items: [
            {
              id: "s1032332",
              name: "Frosch Cremeseife",
              unit_quantity: "500ml",
              price: 255,
              decorators: [
                { type: "QUANTITY", quantity: 2 },
                { type: "UNIT_QUANTITY", unit_quantity_text: "500ml" },
              ],
            },
          ],
        },
      ],
    })

    const cart = parseToolResult(await toolRegistry.executeTool("picnic_get_cart", {}))
    expect(cart.items[0].articles[0].quantity).toBe(2)
  })

  it("defaults to 1 when no QUANTITY decorator is present", async () => {
    const { toolRegistry } = await import("../../../src/tools/registry.js")
    mocks.getCart.mockResolvedValue({
      type: "ORDER",
      id: "shopping_cart",
      items: [{ id: "1", price: 255, items: [{ id: "s1", name: "x", price: 255 }] }],
    })

    const cart = parseToolResult(await toolRegistry.executeTool("picnic_get_cart", {}))
    expect(cart.items[0].articles[0].quantity).toBe(1)
  })
})

describe("picnic_get_overview", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await import("../../../src/tools/picnic-tools.js")
  })

  function slot(overrides: Record<string, unknown> = {}) {
    return {
      slot_id: "slot-1",
      hub_id: "hub",
      fc_id: "fc",
      window_start: "2026-10-14T17:00:00.000+02:00",
      window_end: "2026-10-14T19:00:00.000+02:00",
      cut_off_time: "2026-10-13T22:00:00.000+02:00",
      is_available: true,
      selected: false,
      reserved: false,
      minimum_order_value: 3500,
      slot_characteristics: [],
      ...overrides,
    }
  }

  function cart(overrides: Record<string, unknown> = {}) {
    return {
      type: "ORDER",
      id: "shopping_cart",
      items: [{ id: "line-1", items: [{ id: "s1", name: "Kipfilet", price: 499 }] }],
      delivery_slots: [
        slot(),
        slot({
          slot_id: "slot-2",
          window_start: "2026-10-15T18:00:00.000+02:00",
          window_end: "2026-10-15T20:00:00.000+02:00",
          cut_off_time: "2026-10-14T22:00:00.000+02:00",
          minimum_order_value: 5000,
        }),
      ],
      selected_slot: { slot_id: "slot-2", state: "EXPLICIT" },
      total_count: 7,
      total_price: 2890,
      checkout_total_price: 2990,
      total_savings: 150,
      ...overrides,
    }
  }

  it("summarizes the cart, the selected slot and current deliveries in one call", async () => {
    const { toolRegistry } = await import("../../../src/tools/registry.js")
    mocks.getCart.mockResolvedValueOnce(cart())
    mocks.getDeliveries.mockResolvedValueOnce([
      {
        delivery_id: "d1",
        creation_time: "2026-10-10T09:00:00.000+02:00",
        slot: slot({
          window_start: "2026-10-12T17:00:00.000+02:00",
          window_end: "2026-10-12T19:00:00.000+02:00",
        }),
        eta2: { start: "2026-10-12T17:40:00.000+02:00", end: "2026-10-12T18:00:00.000+02:00" },
        status: "CURRENT",
        orders: [{ id: "o1", total_price: 6420 }],
      },
      {
        delivery_id: "d2",
        creation_time: "2026-10-11T09:00:00.000+02:00",
        slot: slot({
          window_start: "2026-10-16T17:00:00.000+02:00",
          window_end: "2026-10-16T19:00:00.000+02:00",
        }),
        status: "CURRENT",
        orders: [],
      },
    ])

    const payload = parseToolResult(await toolRegistry.executeTool("picnic_get_overview", {}))

    expect(mocks.getDeliveries).toHaveBeenCalledWith(["CURRENT"])
    // Totals only: the cart's lines and the full slot list stay out of the overview.
    expect(payload).toEqual({
      cart: { total_count: 7, total_price: 2890, total_savings: 150 },
      selected_slot: {
        slot_id: "slot-2",
        state: "EXPLICIT",
        window_start: "2026-10-15T18:00:00.000+02:00",
        window_end: "2026-10-15T20:00:00.000+02:00",
        cut_off_time: "2026-10-14T22:00:00.000+02:00",
        minimum_order_value: 5000,
        missing_for_minimum: 2110,
      },
      current_deliveries: [
        {
          delivery_id: "d1",
          status: "CURRENT",
          window_start: "2026-10-12T17:00:00.000+02:00",
          window_end: "2026-10-12T19:00:00.000+02:00",
          eta_start: "2026-10-12T17:40:00.000+02:00",
          eta_end: "2026-10-12T18:00:00.000+02:00",
        },
        {
          delivery_id: "d2",
          status: "CURRENT",
          window_start: "2026-10-16T17:00:00.000+02:00",
          window_end: "2026-10-16T19:00:00.000+02:00",
        },
      ],
    })
  })

  it("reports nothing missing once the cart reaches the minimum order value", async () => {
    const { toolRegistry } = await import("../../../src/tools/registry.js")
    mocks.getCart.mockResolvedValueOnce(cart({ total_price: 6200 }))
    mocks.getDeliveries.mockResolvedValueOnce([])

    const payload = parseToolResult(await toolRegistry.executeTool("picnic_get_overview", {}))

    expect(payload.selected_slot.missing_for_minimum).toBe(0)
    expect(payload.current_deliveries).toEqual([])
  })

  it("falls back to the slot flagged as selected, and to null when there is none", async () => {
    const { toolRegistry } = await import("../../../src/tools/registry.js")
    mocks.getDeliveries.mockResolvedValue([])
    mocks.getCart
      .mockResolvedValueOnce(
        cart({ selected_slot: undefined, delivery_slots: [slot({ selected: true })] }),
      )
      .mockResolvedValueOnce(cart({ selected_slot: undefined, delivery_slots: [slot()] }))

    const flagged = parseToolResult(await toolRegistry.executeTool("picnic_get_overview", {}))
    const none = parseToolResult(await toolRegistry.executeTool("picnic_get_overview", {}))

    expect(flagged.selected_slot).toMatchObject({ slot_id: "slot-1", missing_for_minimum: 610 })
    expect(none.selected_slot).toBeNull()
  })

  it("is marked read-only", async () => {
    const { toolRegistry } = await import("../../../src/tools/registry.js")
    const list = toolRegistry.getToolsList() as Array<{
      name: string
      annotations?: Record<string, boolean>
    }>

    expect(list.find((tool) => tool.name === "picnic_get_overview")?.annotations).toMatchObject({
      readOnlyHint: true,
    })
  })
})
