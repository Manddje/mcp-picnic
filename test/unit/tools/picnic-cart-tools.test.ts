import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ToolResult } from "../../../src/tools/registry.js"

const mocks = vi.hoisted(() => ({
  addProductToCart: vi.fn(),
  removeProductFromCart: vi.fn(),
  clearCart: vi.fn(),
  getCart: vi.fn(),
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

    async function annotationsByTool() {
      const { toolRegistry } = await import("../../../src/tools/registry.js")
      const list = toolRegistry.getToolsList() as Array<{
        name: string
        annotations?: Record<string, boolean>
      }>
      return new Map(list.map((tool) => [tool.name, tool.annotations]))
    }

    // Without an explicit hint a client has to treat every tool as a possibly destructive write.
    it("declares readOnlyHint on every tool", async () => {
      for (const [name, annotations] of await annotationsByTool()) {
        expect(typeof annotations?.readOnlyHint, `${name} should declare readOnlyHint`).toBe(
          "boolean",
        )
      }
    })

    it("marks lookups as read-only and safe to retry", async () => {
      const annotations = await annotationsByTool()
      const lookups = [...annotations.keys()].filter((name) => name.startsWith("picnic_get_"))
      expect(lookups).toContain("picnic_get_cart")

      for (const name of [...lookups, "picnic_search", "picnic_browse_recipes"]) {
        expect(annotations.get(name), name).toMatchObject({
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: true,
        })
      }
    })

    it("marks the local meal-planning tools as read-only and closed-world", async () => {
      const annotations = await annotationsByTool()

      for (const name of ["picnic_build_shopping_list", "picnic_find_meal_combinations"]) {
        expect(annotations.get(name), name).toMatchObject({
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        })
      }
    })

    it("marks cancelling a delivery as destructive and not idempotent", async () => {
      expect((await annotationsByTool()).get("picnic_cancel_delivery")).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      })
    })

    it("annotates the other delivery and recipe-saving writes by their side effects", async () => {
      const annotations = await annotationsByTool()

      expect(annotations.get("picnic_set_delivery_slot")).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      })
      expect(annotations.get("picnic_rate_delivery")).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      })
      // Every call sends another email.
      expect(annotations.get("picnic_send_delivery_invoice_email")).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      })
      expect(annotations.get("picnic_save_recipe")).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      })
      expect(annotations.get("picnic_unsave_recipe")).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      })
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
