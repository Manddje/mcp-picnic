import { describe, it, expect, beforeEach, vi } from "vitest"
import fs from "fs/promises"

// Mock fs/promises
vi.mock("fs/promises", () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    chmod: vi.fn(),
    unlink: vi.fn(),
  },
}))

// Mock picnic-api (v4 domain-based structure)
const mockLogin = vi.fn()
const mockGetCart = vi.fn()
vi.mock("picnic-api", () => {
  return {
    default: vi.fn().mockImplementation((opts: any) => ({
      auth: { login: mockLogin },
      cart: { getCart: mockGetCart },
      sendRequest: vi.fn(),
      authKey: opts?.authKey ?? "fresh-auth-key",
      url: "https://example.test/api/15",
      baseHeaders: { "x-picnic-auth": opts?.authKey ?? "fresh-auth-key" },
      picnicHeaders: { "x-picnic-agent": "agent", "x-picnic-did": "device" },
    })),
  }
})

// Mock config
vi.mock("../../../src/config.js", () => ({
  config: {
    PICNIC_USERNAME: "test-user",
    PICNIC_PASSWORD: "test-pass",
    PICNIC_COUNTRY_CODE: "NL",
    PICNIC_SESSION_FILE: "picnic-session.json",
    PICNIC_DEVICE_FILE: "picnic-device.json",
  },
}))

describe("picnic-client session persistence", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    // Reset the module to clear the singleton between tests
    vi.resetModules()
  })

  async function importClient() {
    // Re-import to get a fresh singleton state
    return await import("../../../src/utils/picnic-client.js")
  }

  describe("initializePicnicClient", () => {
    it("should load and reuse a valid saved session", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ authKey: "saved-key" }))
      mockGetCart.mockResolvedValue({ user: "info" })

      const { initializePicnicClient } = await importClient()
      await initializePicnicClient()

      expect(fs.readFile).toHaveBeenCalledWith("picnic-session.json", "utf-8")
      expect(mockGetCart).toHaveBeenCalled()
      expect(mockLogin).not.toHaveBeenCalled()
    })

    it("should fall back to login when saved session is invalid", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ authKey: "expired-key" }))
      mockGetCart.mockRejectedValue(new Error("Unauthorized"))
      mockLogin.mockResolvedValue(undefined)
      vi.mocked(fs.writeFile).mockResolvedValue(undefined)

      const { initializePicnicClient } = await importClient()
      await initializePicnicClient()

      expect(mockGetCart).toHaveBeenCalled()
      expect(mockLogin).toHaveBeenCalledWith("test-user", "test-pass")
    })

    it("should login fresh when no session file exists", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
      mockLogin.mockResolvedValue(undefined)
      vi.mocked(fs.writeFile).mockResolvedValue(undefined)

      const { initializePicnicClient } = await importClient()
      await initializePicnicClient()

      expect(mockLogin).toHaveBeenCalledWith("test-user", "test-pass")
      expect(mockGetCart).not.toHaveBeenCalled()
    })

    it("should save session after fresh login", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
      mockLogin.mockResolvedValue(undefined)
      vi.mocked(fs.writeFile).mockResolvedValue(undefined)

      const { initializePicnicClient } = await importClient()
      await initializePicnicClient()

      expect(fs.writeFile).toHaveBeenCalledWith(
        "picnic-session.json",
        expect.stringContaining("authKey"),
        { mode: 0o600 },
      )
    })

    it("should keep running when login throws a 2FA/MFA challenge error", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
      mockLogin.mockRejectedValue(new Error("MFA is required for this account"))

      const { initializePicnicClient, getPicnicClient } = await importClient()

      await expect(initializePicnicClient()).resolves.toBeUndefined()
      expect(() => getPicnicClient()).not.toThrow()
      // The device-id resolver may persist a generated id, but no session
      // should be written while 2FA is still pending.
      expect(vi.mocked(fs.writeFile).mock.calls.map(([file]) => file)).not.toContain(
        "picnic-session.json",
      )
    })

    it("should keep running when login throws a TOTP wording variant", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
      mockLogin.mockRejectedValue(new Error("TOTP verification required"))

      const { initializePicnicClient, getPicnicClient } = await importClient()

      await expect(initializePicnicClient()).resolves.toBeUndefined()
      expect(() => getPicnicClient()).not.toThrow()
      expect(vi.mocked(fs.writeFile).mock.calls.map(([file]) => file)).not.toContain(
        "picnic-session.json",
      )
    })

    it("should keep running when login throws a structured 2FA error", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
      mockLogin.mockRejectedValue({ second_factor_authentication_required: true })

      const { initializePicnicClient, getPicnicClient } = await importClient()

      await expect(initializePicnicClient()).resolves.toBeUndefined()
      expect(() => getPicnicClient()).not.toThrow()
      expect(vi.mocked(fs.writeFile).mock.calls.map(([file]) => file)).not.toContain(
        "picnic-session.json",
      )
    })

    it("should not re-initialize if already initialized", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
      mockLogin.mockResolvedValue(undefined)
      vi.mocked(fs.writeFile).mockResolvedValue(undefined)

      const { initializePicnicClient } = await importClient()
      await initializePicnicClient()
      await initializePicnicClient()

      expect(mockLogin).toHaveBeenCalledTimes(1)
    })
  })

  describe("saveSession", () => {
    it("should not write if client is not initialized", async () => {
      const { saveSession } = await importClient()
      await saveSession()

      expect(fs.writeFile).not.toHaveBeenCalled()
    })

    // The auth key must never land in a file other users can read, even for one write.
    it("should restrict an existing session file before writing the new key into it", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
      mockLogin.mockResolvedValue(undefined)
      vi.mocked(fs.writeFile).mockResolvedValue(undefined)

      const { initializePicnicClient } = await importClient()
      await initializePicnicClient()

      expect(fs.chmod).toHaveBeenCalledWith("picnic-session.json", 0o600)
      const sessionWrite = vi
        .mocked(fs.writeFile)
        .mock.calls.findIndex(([file]) => file === "picnic-session.json")
      expect(vi.mocked(fs.chmod).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(fs.writeFile).mock.invocationCallOrder[sessionWrite],
      )
    })

    it("should still save the session when its permissions cannot be changed", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
      mockLogin.mockResolvedValue(undefined)
      vi.mocked(fs.writeFile).mockResolvedValue(undefined)
      vi.mocked(fs.chmod).mockRejectedValueOnce(
        Object.assign(new Error("operation not permitted"), { code: "EPERM" }),
      )
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})

      try {
        const { initializePicnicClient } = await importClient()
        await initializePicnicClient()

        expect(consoleError).toHaveBeenCalledWith(
          expect.stringContaining("Could not restrict the permissions of picnic-session.json"),
          expect.any(Error),
        )
        expect(fs.writeFile).toHaveBeenCalledWith(
          "picnic-session.json",
          expect.stringContaining("authKey"),
          { mode: 0o600 },
        )
      } finally {
        consoleError.mockRestore()
      }
    })
  })

  describe("verifyPicnic2FACode", () => {
    it("should timeout a stalled 2FA verification request", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
      mockLogin.mockResolvedValue(undefined)

      const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          )
        })
      })
      vi.stubGlobal("fetch", fetchMock)

      const { initializePicnicClient, verifyPicnic2FACode } = await importClient()
      await initializePicnicClient()

      await expect(verifyPicnic2FACode("123456", 1)).rejects.toThrow(
        "2FA verification timed out after 1ms",
      )
    })
  })

  describe("getPicnicClient", () => {
    it("should throw if client is not initialized", async () => {
      const { getPicnicClient } = await importClient()

      expect(() => getPicnicClient()).toThrow("Picnic client has not been initialized")
    })

    it("should return the client after initialization", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
      mockLogin.mockResolvedValue(undefined)
      vi.mocked(fs.writeFile).mockResolvedValue(undefined)

      const { initializePicnicClient, getPicnicClient } = await importClient()
      await initializePicnicClient()

      const client = getPicnicClient()
      expect(client).toBeDefined()
      expect(client.auth.login).toBeDefined()
    })
  })

  describe("resetPicnicClient", () => {
    it("should clear the singleton and delete session file", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
      mockLogin.mockResolvedValue(undefined)
      vi.mocked(fs.writeFile).mockResolvedValue(undefined)
      vi.mocked(fs.unlink).mockResolvedValue(undefined)

      const { initializePicnicClient, getPicnicClient, resetPicnicClient } = await importClient()
      await initializePicnicClient()

      expect(() => getPicnicClient()).not.toThrow()

      await resetPicnicClient()

      expect(fs.unlink).toHaveBeenCalledWith("picnic-session.json")
      expect(() => getPicnicClient()).toThrow()
    })

    it("should not throw if session file does not exist", async () => {
      vi.mocked(fs.unlink).mockRejectedValue(new Error("ENOENT"))

      const { resetPicnicClient } = await importClient()
      await expect(resetPicnicClient()).resolves.not.toThrow()
    })
  })
})
