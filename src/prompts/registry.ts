export interface PromptResult {
  // MCP prompt messages have no "system" role: the SDK client validates the result against
  // the protocol schema and rejects a prompt that uses one.
  messages: Array<{
    role: "user" | "assistant"
    content: {
      type: "text"
      text: string
    }
  }>
  tools?: unknown[]
}

export interface PromptDefinition {
  name: string
  description: string
  arguments?: Array<{
    name: string
    description: string
    required?: boolean
  }>
  handler: (args?: Record<string, unknown>) => Promise<PromptResult>
}

class PromptRegistry {
  private prompts = new Map<string, PromptDefinition>()

  register(prompt: PromptDefinition) {
    this.prompts.set(prompt.name, prompt)
  }

  getPromptDefinitions() {
    const definitions: Record<string, unknown> = {}
    for (const [name, prompt] of this.prompts) {
      definitions[name.toUpperCase()] = {
        name: prompt.name,
        description: prompt.description,
        arguments: prompt.arguments || [],
      }
    }
    return definitions
  }

  getPromptsList() {
    return Array.from(this.prompts.values()).map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      arguments: prompt.arguments || [],
    }))
  }

  async executePrompt(name: string, args?: Record<string, unknown>): Promise<PromptResult> {
    const prompt = this.prompts.get(name)
    if (!prompt) {
      throw new Error(`Unknown prompt: ${name}`)
    }

    return await prompt.handler(args)
  }
}

export const promptRegistry = new PromptRegistry()
