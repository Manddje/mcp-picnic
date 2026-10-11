import { describe, expect, it } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { GetPromptResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { promptRegistry } from "../../../src/prompts/index.js"
import { NO_ORDERING_NOTE } from "../../../src/prompts/picnic-prompts.js"
import { toolRegistry } from "../../../src/tools/index.js"
import { BaseTransportServer } from "../../../src/transports/base.js"

// A server wired exactly like the real transports, for an in-process client to talk to.
class InMemoryServer extends BaseTransportServer {
  readonly mcpServer = this.createConfiguredServer()

  async start(): Promise<void> {}

  async stop(): Promise<void> {}
}

function promptNames(): string[] {
  return promptRegistry.getPromptsList().map((prompt) => prompt.name)
}

/** A value for every argument the prompt declares, so it also renders with all of them set. */
function sampleArguments(name: string): Record<string, string> {
  const prompt = promptRegistry.getPromptsList().find((p) => p.name === name)
  return Object.fromEntries(
    (prompt?.arguments ?? []).map((arg) => [arg.name, `sample ${arg.name}`]),
  )
}

async function promptText(name: string): Promise<string> {
  const { messages } = await promptRegistry.executePrompt(name, sampleArguments(name))
  return messages.map((message) => message.content.text).join("\n")
}

describe("picnic prompts", () => {
  it("registers the Picnic prompts", () => {
    expect(promptNames()).toContain("picnic_meal_planner")
  })

  // MCP has no "system" role; a result that fails the protocol schema is rejected by clients.
  it("returns results that match the MCP GetPromptResult schema", async () => {
    for (const name of promptNames()) {
      for (const args of [undefined, sampleArguments(name)]) {
        const result = GetPromptResultSchema.safeParse(
          await promptRegistry.executePrompt(name, args),
        )
        expect(result.success, `${name}: ${result.error?.message}`).toBe(true)
      }
    }
  })

  it("serves every prompt to the official SDK client", async () => {
    const server = new InMemoryServer()
    const client = new Client({ name: "prompt-test", version: "1.0.0" })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.mcpServer.connect(serverTransport)
    await client.connect(clientTransport)

    try {
      const { prompts } = await client.listPrompts()
      expect(prompts.map((prompt) => prompt.name)).toEqual(promptNames())

      // getPrompt validates the result against the protocol schema and throws when it fails.
      for (const { name } of prompts) {
        const result = await client.getPrompt({ name, arguments: sampleArguments(name) })
        expect(result.messages.length, name).toBeGreaterThan(0)
      }
    } finally {
      await client.close()
    }
  })

  it("only points to tools the server registers", async () => {
    const toolNames = new Set(toolRegistry.getToolsList().map((tool) => tool.name))

    for (const name of promptNames()) {
      const referenced = (await promptText(name)).match(/\bpicnic_[a-z0-9_]+/g) ?? []
      expect(referenced.length, `${name} should point to Picnic tools`).toBeGreaterThan(0)
      expect(
        referenced.filter((tool) => !toolNames.has(tool)),
        name,
      ).toEqual([])
    }
  })

  // Placing orders is deliberately not supported, so no prompt may steer the model towards it.
  it("leaves ordering, checkout and payment to the Picnic app", async () => {
    for (const name of promptNames()) {
      const text = await promptText(name)
      expect(text, name).toContain(NO_ORDERING_NOTE)
      expect(text.replace(NO_ORDERING_NOTE, ""), name).not.toMatch(
        /check ?out|place (?:an |the |my |your )?orders?|ordering|payment|\bpay\b|purchase/i,
      )
    }
  })
})
