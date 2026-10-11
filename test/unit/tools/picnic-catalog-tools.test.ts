import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ToolResult } from "../../../src/tools/registry.js"

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  initializePicnicClient: vi.fn(),
}))

vi.mock("../../../src/utils/picnic-client.js", () => ({
  getPicnicClient: () => ({
    catalog: { search: mocks.search },
    sendRequest: vi.fn(),
  }),
  initializePicnicClient: mocks.initializePicnicClient,
  saveSession: vi.fn(),
  verifyPicnic2FACode: vi.fn(),
}))

function parseToolResult(result: ToolResult) {
  return JSON.parse(result.content[0].text ?? "")
}

function sellingUnit(id: string, name: string) {
  return {
    id,
    name,
    image_id: `image-${id}`,
    display_price: 199,
    unit_quantity: "500 gram",
    max_count: 50,
    decorators: [],
    price_ranges: null,
  }
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
    mocks.search.mockImplementation(async (query: string) =>
      query === "broccoli"
        ? [sellingUnit("s1", "Broccoli")]
        : [sellingUnit("s2", "Kipfilet"), sellingUnit("s3", "Kipdijfilet")],
    )

    const toolRegistry = await loadTools()
    const payload = parseToolResult(
      await toolRegistry.executeTool("picnic_search_many", {
        queries: ["kipfilet", "broccoli"],
        limit: 1,
      }),
    )

    expect(mocks.search.mock.calls).toEqual([["kipfilet"], ["broccoli"]])
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
    mocks.search.mockResolvedValue([sellingUnit("s1", "Broccoli")])

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
    mocks.search.mockImplementation(async (query: string) => {
      if (query === "kapot") throw new Error("Picnic search failed")
      return [sellingUnit("s1", "Ui")]
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
    mocks.search.mockImplementation(async (query: string) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight--
      return [sellingUnit(query, query)]
    })

    const toolRegistry = await loadTools()
    const queries = Array.from({ length: 12 }, (_, index) => `query ${index}`)
    const payload = parseToolResult(
      await toolRegistry.executeTool("picnic_search_many", { queries }),
    )

    expect(mocks.search).toHaveBeenCalledTimes(12)
    expect(maxInFlight).toBe(5)
    expect(payload.searches.map((search: { query: string }) => search.query)).toEqual(queries)
  })

  it("rejects an empty batch, a blank query and more than 25 queries before calling Picnic", async () => {
    const toolRegistry = await loadTools()

    for (const queries of [[], ["ui", "  "], Array.from({ length: 26 }, () => "ui")]) {
      await expect(toolRegistry.executeTool("picnic_search_many", { queries })).rejects.toThrow(
        /Invalid input/,
      )
    }
    expect(mocks.search).not.toHaveBeenCalled()
  })

  it("is marked read-only", async () => {
    const toolRegistry = await loadTools()
    const tool = toolRegistry
      .getToolsList()
      .find((candidate) => candidate.name === "picnic_search_many")

    expect(tool?.annotations).toMatchObject({ readOnlyHint: true })
  })
})
