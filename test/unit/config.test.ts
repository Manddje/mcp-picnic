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

describe("Config Schema - HTTP transport settings", () => {
  const HTTP_SETTINGS = [
    "HTTP_ALLOWED_ORIGINS",
    "HTTP_RATE_LIMIT_WINDOW_MS",
    "HTTP_RATE_LIMIT_MAX_REQUESTS",
    "HTTP_REQUEST_TIMEOUT_MS",
  ]

  async function loadConfig(env: Record<string, string> = {}) {
    vi.resetModules()
    for (const name of HTTP_SETTINGS) {
      vi.stubEnv(name, env[name])
    }
    const { config } = await import("../../src/config.js")
    return config
  }

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("allows no extra browser origins by default", async () => {
    const config = await loadConfig()

    expect(config.HTTP_ALLOWED_ORIGINS).toEqual([])
  })

  it("reads allowed origins as a comma-separated list", async () => {
    const config = await loadConfig({
      HTTP_ALLOWED_ORIGINS: "https://app.example.com, http://192.168.1.20:8080,",
    })

    expect(config.HTTP_ALLOWED_ORIGINS).toEqual([
      "https://app.example.com",
      "http://192.168.1.20:8080",
    ])
  })

  it("keeps the previous limits when nothing is configured", async () => {
    const config = await loadConfig()

    expect(config.HTTP_RATE_LIMIT_WINDOW_MS).toBe(15 * 60 * 1000)
    expect(config.HTTP_RATE_LIMIT_MAX_REQUESTS).toBe(100)
    expect(config.HTTP_REQUEST_TIMEOUT_MS).toBe(10000)
  })

  it("reads the limits from the environment", async () => {
    const config = await loadConfig({
      HTTP_RATE_LIMIT_WINDOW_MS: "60000",
      HTTP_RATE_LIMIT_MAX_REQUESTS: "1000",
      HTTP_REQUEST_TIMEOUT_MS: "30000",
    })

    expect(config.HTTP_RATE_LIMIT_WINDOW_MS).toBe(60000)
    expect(config.HTTP_RATE_LIMIT_MAX_REQUESTS).toBe(1000)
    expect(config.HTTP_REQUEST_TIMEOUT_MS).toBe(30000)
  })

  it.each([
    ["HTTP_REQUEST_TIMEOUT_MS", "abc"],
    ["HTTP_REQUEST_TIMEOUT_MS", "0"],
    ["HTTP_RATE_LIMIT_MAX_REQUESTS", "-5"],
    ["HTTP_RATE_LIMIT_WINDOW_MS", "1.5"],
  ])("rejects %s=%s", async (name, value) => {
    await expect(loadConfig({ [name]: value })).rejects.toThrow(name)
  })
})
