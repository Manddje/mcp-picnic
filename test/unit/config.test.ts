import { afterEach, describe, expect, it, vi } from "vitest"

// Keep a local .env from leaking into the config these tests load.
vi.mock("dotenv", () => ({ default: { config: vi.fn() } }))

/**
 * Loads src/config.ts afresh, as the server does at start, after setting the given environment
 * variables. A value of undefined removes the variable.
 */
async function loadConfig(env: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(env)) {
    vi.stubEnv(name, value)
  }
  vi.resetModules()
  const { config } = await import("../../src/config.js")
  return config
}

afterEach(() => {
  vi.unstubAllEnvs()
})

/**
 * Regression tests for issue #10: the country code was hardcoded to NL, so logins failed for
 * accounts from other countries (e.g. Germany with "DE").
 */
describe("PICNIC_COUNTRY_CODE", () => {
  it("defaults to NL, so setups without it keep working", async () => {
    const config = await loadConfig({ PICNIC_COUNTRY_CODE: undefined })

    expect(config.PICNIC_COUNTRY_CODE).toBe("NL")
  })

  it.each(["NL", "DE", "FR"])("accepts %s", async (code) => {
    const config = await loadConfig({ PICNIC_COUNTRY_CODE: code })

    expect(config.PICNIC_COUNTRY_CODE).toBe(code)
  })

  // Codes are uppercase only, and an empty value does not fall back to NL.
  it.each(["BE", "nl", "", "123"])("rejects %j", async (code) => {
    await expect(loadConfig({ PICNIC_COUNTRY_CODE: code })).rejects.toThrow("PICNIC_COUNTRY_CODE")
  })
})

describe("Picnic credentials", () => {
  it.each(["PICNIC_USERNAME", "PICNIC_PASSWORD"])("requires %s", async (name) => {
    await expect(loadConfig({ [name]: undefined })).rejects.toThrow(name)
  })
})

// A cancelled delivery cannot be restored, so only an explicit "true" offers the cancel tool.
describe("PICNIC_ENABLE_CANCEL_DELIVERY", () => {
  it("defaults to false", async () => {
    const config = await loadConfig({ PICNIC_ENABLE_CANCEL_DELIVERY: undefined })

    expect(config.PICNIC_ENABLE_CANCEL_DELIVERY).toBe(false)
  })

  it.each([
    ["true", true],
    ["false", false],
    ["TRUE", false],
    ["1", false],
    ["yes", false],
    ["", false],
  ])("reads %j as %s", async (value, expected) => {
    const config = await loadConfig({ PICNIC_ENABLE_CANCEL_DELIVERY: value })

    expect(config.PICNIC_ENABLE_CANCEL_DELIVERY).toBe(expected)
  })
})

describe("HTTP authentication", () => {
  it("does not require HTTP_AUTH_TOKEN", async () => {
    const config = await loadConfig({ HTTP_AUTH_TOKEN: undefined })

    expect(config.HTTP_AUTH_TOKEN).toBeUndefined()
  })

  it("defaults HTTP_AUTH_HEADER_NAME to x-mcp-token", async () => {
    const config = await loadConfig({ HTTP_AUTH_HEADER_NAME: undefined })

    expect(config.HTTP_AUTH_HEADER_NAME).toBe("x-mcp-token")
  })
})
