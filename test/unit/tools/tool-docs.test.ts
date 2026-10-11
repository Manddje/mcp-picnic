import { readFileSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("../../../src/utils/picnic-client.js", () => ({
  getPicnicClient: vi.fn(),
  initializePicnicClient: vi.fn(),
  saveSession: vi.fn(),
  verifyPicnic2FACode: vi.fn(),
}))

interface ToolInputSchema {
  properties?: Record<string, { type?: unknown }>
  required?: string[]
}

interface ToolSection {
  name: string
  text: string
}

// A struck-through "#### ~~`name`~~ (REMOVED)" heading documents a removed tool, so it does not match.
const TOOL_HEADING = /^#### `([^`]+)`$/m
const PARAMETER_LIST = /^\*\*Parameters:\*\*\n+((?:- .*\n?)+)/m
const PARAMETER_LINE = /^- `([^`]+)` \(([^)]+)\): \S/

/** Each "#### `tool_name`" section of PICNIC_TOOLS.md, up to the next heading. */
function toolSections(markdown: string): ToolSection[] {
  return markdown.split(/^(?=#+ )/m).flatMap((text) => {
    const name = TOOL_HEADING.exec(text)?.[1]
    return name ? [{ name, text }] : []
  })
}

function signature(name: string, type: string, optional: boolean): string {
  return `\`${name}\` (${optional ? `${type}, optional` : type})`
}

/** The parameters a section lists under "**Parameters:**", as sorted signatures. */
function documentedParams(section?: ToolSection): string[] {
  const list = PARAMETER_LIST.exec(section?.text ?? "")?.[1] ?? ""
  return list
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = PARAMETER_LINE.exec(line)
      // Kept verbatim, so a line that is not "- `param` (type): ..." shows up in the diff.
      if (!match) return line
      const [type, ...flags] = match[2].split(", ")
      // Only the first word is compared, so "array of strings" matches an array schema.
      return signature(match[1], type.split(" ")[0], flags.includes("optional"))
    })
    .sort()
}

/** The parameters of a tool's JSON input schema, as sorted signatures. */
function schemaParams(schema: ToolInputSchema): string[] {
  return Object.entries(schema.properties ?? {})
    .map(([name, property]) =>
      signature(
        name,
        // PICNIC_TOOLS.md calls integers numbers.
        property.type === "integer" ? "number" : String(property.type),
        !schema.required?.includes(name),
      ),
    )
    .sort()
}

// PICNIC_TOOLS.md is the per-tool reference, and tool changes kept leaving it behind.
describe("PICNIC_TOOLS.md", () => {
  let tools: Array<{ name: string; inputSchema: ToolInputSchema }>
  let sections: ToolSection[]

  beforeAll(async () => {
    // picnic_cancel_delivery is opt-in, and its entry has to stay in sync as well. The config
    // is read when the tools are imported, so the flag is set before a fresh import.
    vi.stubEnv("PICNIC_ENABLE_CANCEL_DELIVERY", "true")
    vi.resetModules()
    const { toolRegistry } = await import("../../../src/tools/registry.js")
    await import("../../../src/tools/picnic-tools.js")
    tools = toolRegistry.getToolsList() as typeof tools
    sections = toolSections(
      readFileSync(new URL("../../../PICNIC_TOOLS.md", import.meta.url), "utf8"),
    )
  })

  afterAll(() => {
    vi.unstubAllEnvs()
  })

  it("has a heading for every registered tool", () => {
    const documented = new Set(sections.map((section) => section.name))

    expect(tools.map((tool) => tool.name).filter((name) => !documented.has(name))).toEqual([])
  })

  it("only has headings for registered tools, one per tool", () => {
    const registered = new Set(tools.map((tool) => tool.name))
    const documented = sections.map((section) => section.name)

    expect(
      documented.filter((name) => !registered.has(name)),
      "not registered",
    ).toEqual([])
    expect(
      documented.filter((name, index) => documented.indexOf(name) !== index),
      "documented twice",
    ).toEqual([])
  })

  it("lists each tool's parameters as its input schema defines them", () => {
    for (const tool of tools) {
      const section = sections.find((candidate) => candidate.name === tool.name)

      expect.soft(documentedParams(section), tool.name).toEqual(schemaParams(tool.inputSchema))
    }
  })
})
