import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "fs/promises"

// The real picnic-api client runs against a fake Picnic API (a stubbed fetch), so these tests
// cover the errors the library actually throws, not a hand-written mock of them.

vi.mock("fs/promises", () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn(),
  },
}))

vi.mock("../../../src/config.js", () => ({
  config: {
    PICNIC_USERNAME: "test-user",
    PICNIC_PASSWORD: "test-pass",
    PICNIC_COUNTRY_CODE: "NL",
    PICNIC_API_VERSION: "15",
    PICNIC_DEVICE_ID: "TESTDEVICE",
    PICNIC_SESSION_FILE: "picnic-session.json",
    PICNIC_DEVICE_FILE: "picnic-device.json",
  },
}))

const EMPTY_CART = { type: "ORDER", items: [] }
const USER = { user_id: "user-1" }
const DELIVERY_SLOTS = { delivery_slots: [] }

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

// Picnic answers with a localized message; picnic-api keeps only that text and drops the status.
const sessionExpired = () =>
  jsonResponse(401, { error: { code: "AUTH_ERROR", message: "Je sessie is verlopen" } })

/**
 * Minimal stand-in for the Picnic API. It hands out a new auth key on every login and turns
 * away requests whose key it no longer accepts, the way an expired or revoked session does.
 */
function createFakePicnic() {
  const holds = new Map<string, Promise<void>>()
  const picnic = {
    acceptedKey: null as string | null,
    secondFactorKey: null as string | null,
    requireSecondFactor: false,
    loginError: null as string | null,
    keysIssued: 0,
    cartAdds: 0,
    requests: [] as Array<{ method: string; path: string; authKey: string | null }>,

    /** Revokes the current session, like an auth key that expired. */
    expireSession() {
      picnic.acceptedKey = null
    },

    /** Delays the response to the next request for `path` until the returned release is called. */
    hold(path: string): () => void {
      let release!: () => void
      holds.set(path, new Promise<void>((resolve) => (release = resolve)))
      return () => release()
    },

    count(path: string): number {
      return picnic.requests.filter((request) => request.path === path).length
    },

    fetch: vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const path = new URL(String(input)).pathname.replace(/^\/api\/15/, "")
      const method = init.method ?? "GET"
      const authKey = new Headers(init.headers).get("x-picnic-auth")
      picnic.requests.push({ method, path, authKey })

      const response = route(method, path, authKey, init.body)
      const held = holds.get(path)
      if (held) {
        holds.delete(path)
        await held
      }
      return response
    }),
  }

  function route(method: string, path: string, authKey: string | null, body: unknown): Response {
    if (path === "/user/login") {
      if (picnic.loginError) {
        return jsonResponse(401, {
          error: { code: "AUTH_INVALID_CRED", message: picnic.loginError },
        })
      }
      const key = `key-${++picnic.keysIssued}`
      if (picnic.requireSecondFactor) {
        picnic.secondFactorKey = key
      } else {
        picnic.acceptedKey = key
      }
      return jsonResponse(
        200,
        {
          user_id: "user-1",
          second_factor_authentication_required: picnic.requireSecondFactor,
        },
        { "x-picnic-auth": key },
      )
    }

    if (path.startsWith("/user/2fa/")) {
      if (!authKey || authKey !== picnic.secondFactorKey) {
        return sessionExpired()
      }
      if (path === "/user/2fa/verify") {
        if (JSON.parse(String(body)).otp !== "123456") {
          return jsonResponse(400, { error: { code: "OTP_INVALID", message: "Ongeldige code" } })
        }
        picnic.acceptedKey = "key-verified"
        picnic.secondFactorKey = null
        return new Response(null, { status: 204, headers: { "x-picnic-auth": "key-verified" } })
      }
      return new Response(null, { status: 204 })
    }

    if (!authKey || authKey !== picnic.acceptedKey) {
      return sessionExpired()
    }
    if (path === "/user") return jsonResponse(200, USER)
    if (path === "/cart") return jsonResponse(200, EMPTY_CART)
    if (path === "/cart/delivery_slots") return jsonResponse(200, DELIVERY_SLOTS)
    if (path === "/cart/add_product" && method === "POST") {
      picnic.cartAdds++
      return jsonResponse(200, EMPTY_CART)
    }
    return jsonResponse(404, { error: { code: "NOT_FOUND", message: "Pagina niet gevonden" } })
  }

  return picnic
}

let picnic: ReturnType<typeof createFakePicnic>

async function startClient() {
  const picnicClient = await import("../../../src/utils/picnic-client.js")
  await picnicClient.initializePicnicClient()
  return { ...picnicClient, client: picnicClient.getPicnicClient() }
}

describe("picnic-client session recovery", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    picnic = createFakePicnic()
    vi.stubGlobal("fetch", picnic.fetch)
    vi.mocked(fs.readFile).mockRejectedValue(new Error("ENOENT"))
    vi.mocked(fs.writeFile).mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  describe("when Picnic rejects an expired session", () => {
    it("logs in again, persists the new session and retries the request", async () => {
      const { client } = await startClient()
      picnic.expireSession()

      await expect(client.cart.getCart()).resolves.toEqual(EMPTY_CART)

      expect(picnic.count("/user/login")).toBe(2)
      expect(picnic.requests.filter((request) => request.path === "/cart")).toEqual([
        { method: "GET", path: "/cart", authKey: "key-1" },
        { method: "GET", path: "/cart", authKey: "key-2" },
      ])
      expect(fs.writeFile).toHaveBeenLastCalledWith(
        "picnic-session.json",
        JSON.stringify({ authKey: "key-2" }),
      )
    })

    it("also recovers a session restored from the session file", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ authKey: "key-saved" }))
      picnic.acceptedKey = "key-saved"
      const { client } = await startClient()
      picnic.expireSession()

      await expect(client.cart.getCart()).resolves.toEqual(EMPTY_CART)
      expect(picnic.count("/user/login")).toBe(1)
    })

    it("applies a rejected cart mutation exactly once", async () => {
      const { client } = await startClient()
      picnic.expireSession()

      await client.cart.addProductToCart("s1001", 1)

      expect(picnic.count("/cart/add_product")).toBe(2)
      expect(picnic.cartAdds).toBe(1)
    })

    it("recovers requests that tools send through the client directly", async () => {
      const { client } = await startClient()
      picnic.expireSession()

      await expect(client.sendRequest("GET", "/cart", null, true)).resolves.toEqual(EMPTY_CART)
      expect(picnic.count("/user/login")).toBe(2)
    })

    it("shares one re-login between requests that find the session expired together", async () => {
      const { client } = await startClient()
      picnic.expireSession()

      await expect(
        Promise.all([
          client.cart.getCart(),
          client.user.getUserDetails(),
          client.cart.getDeliverySlots(),
        ]),
      ).resolves.toEqual([EMPTY_CART, USER, DELIVERY_SLOTS])

      expect(picnic.count("/user/login")).toBe(2)
    })

    it("retries a request rejected with the old key after another request logged in again", async () => {
      const { client } = await startClient()
      picnic.expireSession()

      const release = picnic.hold("/cart/delivery_slots")
      const lateRequest = client.cart.getDeliverySlots()
      await expect(client.cart.getCart()).resolves.toEqual(EMPTY_CART)
      release()

      await expect(lateRequest).resolves.toEqual(DELIVERY_SLOTS)
      expect(picnic.count("/user/login")).toBe(2)
    })

    it("asks for 2FA instead of retrying when logging in again needs a second factor", async () => {
      const { client, PicnicTwoFactorRequiredError } = await startClient()
      picnic.expireSession()
      picnic.requireSecondFactor = true

      await expect(client.cart.addProductToCart("s1001", 1)).rejects.toThrow(
        /picnic_generate_2fa_code.*picnic_verify_2fa_code/,
      )
      expect(picnic.count("/cart/add_product")).toBe(1)
      expect(fs.writeFile).not.toHaveBeenCalledWith(
        "picnic-session.json",
        JSON.stringify({ authKey: "key-2" }),
      )

      // Until 2FA is completed, other requests fail the same way without reaching Picnic.
      await expect(client.cart.getCart()).rejects.toBeInstanceOf(PicnicTwoFactorRequiredError)
      expect(picnic.count("/cart")).toBe(0)
    })

    it("reports a failed re-login and does not retry it during the cooldown", async () => {
      const { client } = await startClient()
      picnic.expireSession()
      picnic.loginError = "Ongeldige inloggegevens"

      await expect(client.cart.getCart()).rejects.toThrow(
        "Picnic session expired and logging in again failed: Login failed: Ongeldige inloggegevens",
      )
      await expect(client.cart.getCart()).rejects.toThrow("logging in again failed")

      expect(picnic.count("/user/login")).toBe(2)
      // The second request went out without a key, so there was no session left to check.
      expect(picnic.count("/user")).toBe(1)
    })

    it("does not retry a late request once logging in again asked for 2FA", async () => {
      vi.useFakeTimers()
      const { client, PicnicTwoFactorRequiredError } = await startClient()
      picnic.expireSession()
      picnic.requireSecondFactor = true

      const release = picnic.hold("/cart/delivery_slots")
      const lateRequest = client.cart.getDeliverySlots()
      await expect(client.cart.getCart()).rejects.toBeInstanceOf(PicnicTwoFactorRequiredError)
      // Outlast the cooldown, so the late request can't simply reuse that failed re-login.
      vi.advanceTimersByTime(30_000)
      release()

      await expect(lateRequest).rejects.toBeInstanceOf(PicnicTwoFactorRequiredError)
      expect(picnic.count("/cart/delivery_slots")).toBe(1)
    })

    it("logs in again at most once per cooldown while Picnic keeps rejecting new sessions", async () => {
      vi.useFakeTimers()
      const { client } = await startClient()
      picnic.expireSession()
      // Every new key is revoked at once, so a retry can never succeed.
      picnic.fetch.mockImplementation(async (input, init) => {
        const path = new URL(String(input)).pathname.replace(/^\/api\/15/, "")
        picnic.requests.push({ method: init?.method ?? "GET", path, authKey: null })
        return path === "/user/login"
          ? jsonResponse(200, { user_id: "user-1" }, { "x-picnic-auth": "key-revoked" })
          : sessionExpired()
      })

      await expect(client.cart.getCart()).rejects.toThrow("Je sessie is verlopen")
      await expect(client.cart.getCart()).rejects.toThrow("Je sessie is verlopen")
      expect(picnic.count("/user/login")).toBe(2)

      vi.advanceTimersByTime(30_000)
      await expect(client.cart.getCart()).rejects.toThrow("Je sessie is verlopen")
      expect(picnic.count("/user/login")).toBe(3)
    })
  })

  describe("when a request fails for another reason", () => {
    it("passes the error through without logging in again", async () => {
      const { client } = await startClient()

      await expect(client.sendRequest("GET", "/pages/unknown-page", null, true)).rejects.toThrow(
        "Pagina niet gevonden",
      )
      expect(picnic.count("/user/login")).toBe(1)
    })

    it("does not check the session when Picnic is unreachable", async () => {
      const { client } = await startClient()
      picnic.fetch.mockRejectedValueOnce(new TypeError("fetch failed"))

      await expect(client.cart.getCart()).rejects.toThrow("fetch failed")
      expect(picnic.count("/user")).toBe(0)
      expect(picnic.count("/user/login")).toBe(1)
    })
  })

  describe("while two-factor authentication is pending", () => {
    beforeEach(() => {
      picnic.requireSecondFactor = true
    })

    it("fails fast with instructions instead of calling Picnic", async () => {
      const { client, PicnicTwoFactorRequiredError } = await startClient()

      await expect(client.cart.getCart()).rejects.toBeInstanceOf(PicnicTwoFactorRequiredError)
      await expect(client.cart.getCart()).rejects.toThrow(
        /picnic_generate_2fa_code.*picnic_verify_2fa_code/,
      )
      expect(picnic.count("/cart")).toBe(0)
    })

    it("keeps the 2FA endpoints out of session recovery", async () => {
      const { client } = await startClient()
      picnic.secondFactorKey = null

      await expect(client.auth.generate2FACode("SMS")).rejects.toThrow("Je sessie is verlopen")
      expect(picnic.count("/user")).toBe(0)
      expect(picnic.count("/user/login")).toBe(1)
    })

    it("never logs in again because verification failed", async () => {
      const { verifyPicnic2FACode } = await startClient()

      await expect(verifyPicnic2FACode("000000")).rejects.toThrow("2FA verification failed")
      expect(picnic.count("/user/login")).toBe(1)
    })

    it("resumes normal requests once the code is verified", async () => {
      const { client, verifyPicnic2FACode } = await startClient()

      await client.auth.generate2FACode("SMS")
      await verifyPicnic2FACode("123456")

      await expect(client.cart.getCart()).resolves.toEqual(EMPTY_CART)
    })
  })
})
