import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Unlike picnic-client.test.ts this runs against the real filesystem, in a temporary directory,
// so the assertions check the permissions the operating system actually applied.

const mockConfig = vi.hoisted(() => ({
  PICNIC_USERNAME: "test-user",
  PICNIC_PASSWORD: "test-pass",
  PICNIC_COUNTRY_CODE: "NL",
  // An explicit device id keeps the device-id resolver off the filesystem.
  PICNIC_DEVICE_ID: "3C417201548B2E3B",
  PICNIC_SESSION_FILE: "",
}))
vi.mock("../../../src/config.js", () => ({ config: mockConfig }))

const mockGetCart = vi.hoisted(() => vi.fn())
vi.mock("picnic-api", () => ({
  default: vi.fn().mockImplementation((opts: { authKey?: string }) => {
    const client = {
      authKey: opts?.authKey ?? null,
      auth: {
        login: vi.fn(async () => {
          client.authKey = "fresh-auth-key"
        }),
      },
      cart: { getCart: mockGetCart },
      // Wrapped by the client's session recovery; these tests never send through it.
      sendRequest: vi.fn(),
    }
    return client
  }),
}))

/** The file's permission bits in octal, e.g. "600", for readable failure messages. */
async function modeOf(file: string): Promise<string> {
  return ((await fs.stat(file)).mode & 0o777).toString(8)
}

// POSIX permissions only; Windows does not report them.
describe.skipIf(process.platform === "win32")("session file permissions", () => {
  let dir: string

  beforeEach(async () => {
    vi.resetModules()
    mockGetCart.mockReset()
    vi.spyOn(console, "error").mockImplementation(() => {})
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "picnic-session-"))
    mockConfig.PICNIC_SESSION_FILE = path.join(dir, "picnic-session.json")
  })

  afterEach(async () => {
    vi.mocked(console.error).mockRestore()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("creates the session file readable by its owner only", async () => {
    const { initializePicnicClient } = await import("../../../src/utils/picnic-client.js")
    await initializePicnicClient()

    expect(await modeOf(mockConfig.PICNIC_SESSION_FILE)).toBe("600")
  })

  it("restricts a session file that an older version left world-readable", async () => {
    await fs.writeFile(mockConfig.PICNIC_SESSION_FILE, JSON.stringify({ authKey: "expired-key" }))
    await fs.chmod(mockConfig.PICNIC_SESSION_FILE, 0o644)
    mockGetCart.mockRejectedValue(new Error("Unauthorized"))

    const { initializePicnicClient } = await import("../../../src/utils/picnic-client.js")
    await initializePicnicClient()

    expect(await modeOf(mockConfig.PICNIC_SESSION_FILE)).toBe("600")
    expect(JSON.parse(await fs.readFile(mockConfig.PICNIC_SESSION_FILE, "utf-8"))).toEqual({
      authKey: "fresh-auth-key",
    })
  })
})
