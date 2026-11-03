import { extractDeliverySummaries } from "picnic-api/lib/domains/delivery/summaries.js"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ToolResult } from "../../../src/tools/registry.js"

const mocks = vi.hoisted(() => ({
  cancelDelivery: vi.fn(),
  // Picnic's raw POST /deliveries/summary body, read by picnic-api's real mapping.
  deliverySummaries: vi.fn(),
}))

vi.mock("../../../src/utils/picnic-client.js", () => ({
  getPicnicClient: () => ({
    delivery: {
      cancelDelivery: mocks.cancelDelivery,
      getDeliverySummaries: async () => extractDeliverySummaries(await mocks.deliverySummaries()),
    },
  }),
  initializePicnicClient: vi.fn(),
  saveSession: vi.fn(),
  verifyPicnic2FACode: vi.fn(),
}))

/** Loads the tools with a fresh config read from the environment, as the server does at start. */
async function loadTools(enableCancelDelivery?: string) {
  if (enableCancelDelivery === undefined) delete process.env.PICNIC_ENABLE_CANCEL_DELIVERY
  else process.env.PICNIC_ENABLE_CANCEL_DELIVERY = enableCancelDelivery
  vi.resetModules()
  const { toolRegistry } = await import("../../../src/tools/registry.js")
  await import("../../../src/tools/picnic-tools.js")
  return toolRegistry
}

function toolNames(toolRegistry: Awaited<ReturnType<typeof loadTools>>): string[] {
  return toolRegistry.getToolsList().map((tool: { name: string }) => tool.name)
}

function parseToolResult(result: ToolResult) {
  return JSON.parse(result.content[0].text ?? "")
}

// A cancelled delivery cannot be restored, so cancelling is opt-in.
describe("picnic_cancel_delivery", () => {
  afterEach(() => {
    delete process.env.PICNIC_ENABLE_CANCEL_DELIVERY
    vi.clearAllMocks()
  })

  it("is not offered unless PICNIC_ENABLE_CANCEL_DELIVERY is true", async () => {
    for (const value of [undefined, "false", "1"]) {
      const names = toolNames(await loadTools(value))
      expect(names, `PICNIC_ENABLE_CANCEL_DELIVERY=${value}`).toContain("picnic_get_deliveries")
      expect(names, `PICNIC_ENABLE_CANCEL_DELIVERY=${value}`).not.toContain(
        "picnic_cancel_delivery",
      )
    }
  })

  it("is offered as destructive and not idempotent when enabled", async () => {
    const tool = (await loadTools("true"))
      .getToolsList()
      .find((t: { name: string }) => t.name === "picnic_cancel_delivery")

    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    })
  })

  it("cancels the given delivery when enabled", async () => {
    mocks.cancelDelivery.mockResolvedValue({ status: "CANCELLED" })
    const toolRegistry = await loadTools("true")

    const result = await toolRegistry.executeTool("picnic_cancel_delivery", { deliveryId: "d-1" })

    expect(mocks.cancelDelivery).toHaveBeenCalledWith("d-1")
    expect(parseToolResult(result)).toMatchObject({
      message: "Delivery cancelled",
      deliveryId: "d-1",
    })
  })
})

describe("picnic_get_deliveries", () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  // Picnic's summaries have no item counts, so picnic-api reports 0 items for every delivery,
  // which a caller would read as an empty delivery.
  it("leaves out the item count the summaries cannot fill", async () => {
    mocks.deliverySummaries.mockResolvedValue([
      {
        delivery_id: "d-1",
        creation_time: "2026-10-30T12:38:07.707+01:00",
        slot: {
          window_start: "2026-11-01T09:00:00.000+01:00",
          window_end: "2026-11-01T10:00:00.000+01:00",
        },
        status: "COMPLETED",
        orders: [{ id: "o-1", total_price: 5976 }],
      },
    ])
    const toolRegistry = await loadTools()

    const payload = parseToolResult(await toolRegistry.executeTool("picnic_get_deliveries", {}))

    expect(payload.deliveries).toEqual([
      {
        id: "d-1",
        status: "COMPLETED",
        creationTime: "2026-10-30T12:38:07.707+01:00",
        windowStart: "2026-11-01T09:00:00.000+01:00",
        windowEnd: "2026-11-01T10:00:00.000+01:00",
        orderCount: 1,
        totalPrice: 5976,
      },
    ])
    expect(payload.pagination).toMatchObject({ total: 1, hasMore: false })
  })
})
