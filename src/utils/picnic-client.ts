import PicnicClient from "picnic-api"
import fs from "fs/promises"
import { config } from "../config.js"
import { resolveDeviceId } from "./device-id.js"

type PicnicClientInstance = InstanceType<typeof PicnicClient>

// Singleton instance for caching
let picnicClientInstance: PicnicClientInstance | null = null

// Set while Picnic waits for a second factor: until picnic_verify_2fa_code succeeds, the auth
// key from login only unlocks the 2FA endpoints and Picnic rejects everything else.
let twoFactorPending = false

// The latest automatic re-login. Every request that finds the session expired waits on this one
// login instead of starting its own, and it is kept for RELOGIN_COOLDOWN_MS after it settles.
let recentRelogin: Promise<void> | null = null

// Credentials only change with a restart, so logging in again right after a failed attempt (or
// after a fresh key was rejected straight away) only piles failed logins onto the account.
const RELOGIN_COOLDOWN_MS = 30_000

// Bounds the session check, so an unresponsive Picnic API can't eat a tool's time budget.
const AUTH_PROBE_TIMEOUT_MS = 10_000

type PicnicCountryCode = "NL" | "DE" | "FR"
type PicnicClientOptions = NonNullable<ConstructorParameters<typeof PicnicClient>[0]> &
  Record<string, unknown>

interface LoginCredentials {
  username: string
  password: string
}

/**
 * Error for requests that can't proceed until the account holder completes 2FA.
 *
 * Tool errors reach the model verbatim, so the message names the tools that unblock it; an
 * opaque API error just makes the model retry or give up.
 */
export class PicnicTwoFactorRequiredError extends Error {
  constructor() {
    super(
      "Picnic requires two-factor authentication before this request can be made. " +
        "Call picnic_generate_2fa_code to send a verification code to the account holder, " +
        "then call picnic_verify_2fa_code with the code they receive.",
    )
    this.name = "PicnicTwoFactorRequiredError"
  }
}

/**
 * Headers for the hand-rolled 2FA verify request.
 *
 * Sourced from the client instance rather than redeclared here: Picnic gates several
 * endpoints on the `x-picnic-agent` client version, so a local copy that drifts behind
 * picnic-api's default silently breaks those calls. Reading the live values keeps this
 * request identical to every request the library sends.
 */
function buildPicnicHeaders(client: InstanceType<typeof PicnicClient>): HeadersInit {
  return {
    ...client.baseHeaders,
    ...client.picnicHeaders,
  }
}

function isTwoFactorAuthenticationError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false
  }

  const maybeError = error as {
    code?: unknown
    type?: unknown
    second_factor_authentication_required?: unknown
    message?: unknown
  }

  if (maybeError.second_factor_authentication_required === true) {
    return true
  }

  if (typeof maybeError.code === "string" && /2fa|mfa|second[_ ]factor/i.test(maybeError.code)) {
    return true
  }

  if (typeof maybeError.type === "string" && /2fa|mfa|second[_ ]factor/i.test(maybeError.type)) {
    return true
  }

  if (typeof maybeError.message !== "string") {
    return false
  }

  // NOTE: picnic-api does not currently expose a stable 2FA error shape in all failure paths.
  // Keep this message fallback to tolerate known wording variants from upstream.
  const normalizedMessage = maybeError.message.toLowerCase()
  return (
    normalizedMessage.includes("2fa") ||
    normalizedMessage.includes("mfa") ||
    normalizedMessage.includes("second_factor") ||
    normalizedMessage.includes("second factor") ||
    normalizedMessage.includes("totp")
  )
}

async function loadSession(): Promise<string | null> {
  try {
    const data = await fs.readFile(config.PICNIC_SESSION_FILE, "utf-8")
    const session = JSON.parse(data)
    return session.authKey || null
  } catch {
    return null
  }
}

// The session file holds the auth key, which grants full access to the Picnic account.
const SESSION_FILE_MODE = 0o600

/**
 * Restricts an existing session file to its owner.
 *
 * writeFile applies its `mode` only when it creates the file, so a session file written earlier
 * with default permissions (0644 under a normal umask) would stay readable by other users. A
 * failure is logged rather than thrown, so it never stops the session from being saved.
 */
async function restrictSessionFile(): Promise<void> {
  try {
    await fs.chmod(config.PICNIC_SESSION_FILE, SESSION_FILE_MODE)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    console.error(`Could not restrict the permissions of ${config.PICNIC_SESSION_FILE}:`, error)
  }
}

export async function saveSession(): Promise<void> {
  if (!picnicClientInstance) return
  const authKey = picnicClientInstance.authKey
  if (authKey) {
    // Tighten an existing file before the new key is written into it.
    await restrictSessionFile()
    await fs.writeFile(config.PICNIC_SESSION_FILE, JSON.stringify({ authKey }), {
      mode: SESSION_FILE_MODE,
    })
  }
}

export async function verifyPicnic2FACode(
  code: string,
  timeoutMs: number = 30000,
): Promise<{ authKey: string }> {
  const client = getPicnicClient()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(`${client.url}/user/2fa/verify`, {
      method: "POST",
      headers: new Headers(buildPicnicHeaders(client)),
      body: JSON.stringify({ otp: code }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const body = await response.text()
      try {
        const errorData = JSON.parse(body)
        const message = errorData.error?.message || response.statusText
        throw new Error(`2FA verification failed: ${message}`)
      } catch (error) {
        if (error instanceof Error && !(error instanceof SyntaxError)) {
          throw error
        }
        throw new Error(`2FA verification failed: ${response.status} ${response.statusText}`)
      }
    }

    const authKey = response.headers.get("x-picnic-auth")
    if (!authKey) {
      throw new Error("2FA verification failed: No auth key received.")
    }

    client.authKey = authKey
    twoFactorPending = false
    // A re-login that ended in this 2FA challenge must not answer for the verified session.
    recentRelogin = null
    return { authKey }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`2FA verification timed out after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Logs the client in with the account credentials.
 *
 * Resolves to true when Picnic asks for a second factor: the new auth key then only works for
 * the 2FA endpoints until picnic_verify_2fa_code succeeds.
 */
async function login(
  client: PicnicClientInstance,
  credentials: LoginCredentials,
): Promise<boolean> {
  try {
    const loginResult = await client.auth.login(credentials.username, credentials.password)
    return Boolean(loginResult?.second_factor_authentication_required)
  } catch (error) {
    // Some 2FA challenges surface as a failed login; the client stays usable for the 2FA tools.
    if (isTwoFactorAuthenticationError(error)) {
      return true
    }
    throw error
  }
}

/**
 * Replaces a rejected auth key with a fresh login and persists it.
 *
 * Throws PicnicTwoFactorRequiredError when the login asks for a second factor, because no
 * request can succeed until the account holder completes it.
 */
async function relogin(client: PicnicClientInstance, credentials: LoginCredentials): Promise<void> {
  console.error("Picnic rejected the session (expired or revoked), logging in again...")
  // The rejected key must not ride along on the login request.
  client.authKey = null

  let needsSecondFactor: boolean
  try {
    needsSecondFactor = await login(client, credentials)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Picnic session expired and logging in again failed: ${reason}`, {
      cause: error,
    })
  }

  if (needsSecondFactor) {
    twoFactorPending = true
    console.error(
      "Logging in again requires 2FA. Call picnic_generate_2fa_code and picnic_verify_2fa_code.",
    )
    throw new PicnicTwoFactorRequiredError()
  }

  try {
    await saveSession()
  } catch (error) {
    // The new key works in memory regardless; failing the request over a disk write would
    // throw away a recovered session.
    console.error("Could not persist the refreshed Picnic session:", error)
  }
  console.error("Picnic session restored.")
}

/**
 * Tells whether a failed request was turned away because its auth key is no longer valid.
 *
 * picnic-api drops the HTTP status from the errors it throws and keeps only Picnic's localized
 * message, so the error alone can't tell an expired session from any other failure. Instead,
 * replay the key on a cheap authenticated read. Only failed requests pay for the extra call, and
 * because the probe carries the key the failed request used, a request that raced a concurrent
 * re-login is still recognized.
 */
async function isAuthKeyRejected(
  client: PicnicClientInstance,
  error: unknown,
  authKey: string | null,
): Promise<boolean> {
  // picnic-api reports HTTP failures as plain Errors. Network failures (TypeError), unparsable
  // bodies (SyntaxError) and its typed errors say nothing about the session.
  if (!(error instanceof Error) || error.name !== "Error") {
    return false
  }
  // Without a key, the request can only have been turned away for lacking one.
  if (!authKey) {
    return true
  }

  try {
    const response = await fetch(`${client.url}/user`, {
      headers: { ...client.baseHeaders, "x-picnic-auth": authKey },
      signal: AbortSignal.timeout(AUTH_PROBE_TIMEOUT_MS),
    })
    if (response.ok) {
      return false
    }
    if (response.status === 401) {
      return true
    }
    // Picnic also flags session errors by code (AUTH_ERROR, AUTH_INVALID_CRED) in the body.
    const body: { error?: { code?: unknown } } | null = await response.json().catch(() => null)
    const code = body?.error?.code
    return typeof code === "string" && code.startsWith("AUTH_")
  } catch {
    // Picnic unreachable: report the original failure rather than guess.
    return false
  }
}

// The 2FA endpoints are meant to work on a half-authenticated session. Recovering there would
// start a login that asks for the same second factor all over again.
function isTwoFactorEndpoint(path: string): boolean {
  return path.startsWith("/user/2fa/")
}

/**
 * Makes the client recover from an expired or revoked session on its own.
 *
 * The client logs in once at startup, but a long-running server outlives its auth key, after
 * which every tool failed until a restart. All picnic-api services, and the tools that call the
 * client directly, send through the instance's sendRequest, so shadowing it covers every tool
 * without touching their handlers: a request rejected for its auth key triggers one fresh
 * login and is retried once. The retry is safe for mutations too, because Picnic rejected the
 * request rather than applying it.
 */
function withSessionRecovery(
  client: PicnicClientInstance,
  credentials: LoginCredentials,
): PicnicClientInstance {
  const sendRequest = client.sendRequest.bind(client)

  // Joins the recent re-login, or starts one unless the key was already replaced after the
  // failed request went out (by 2FA verification, or a re-login that has since been forgotten).
  const recoverSession = (rejectedAuthKey: string | null): Promise<void> => {
    if (recentRelogin) {
      return recentRelogin
    }
    if (client.authKey !== rejectedAuthKey) {
      return Promise.resolve()
    }

    const attempt = relogin(client, credentials)
    recentRelogin = attempt
    const forget = () => {
      if (recentRelogin === attempt) {
        recentRelogin = null
      }
    }
    const forgetLater = () => setTimeout(forget, RELOGIN_COOLDOWN_MS).unref()
    attempt.then(forgetLater, forgetLater)
    return attempt
  }

  client.sendRequest = async function <TRequestData, TResponseData>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    data?: TRequestData | null,
    includePicnicHeaders?: boolean,
    isImageRequest?: boolean,
    contentType?: string,
  ): Promise<TResponseData> {
    const send = () =>
      sendRequest<TRequestData, TResponseData>(
        method,
        path,
        data,
        includePicnicHeaders,
        isImageRequest,
        contentType,
      )

    if (isTwoFactorEndpoint(path)) {
      return send()
    }
    if (twoFactorPending) {
      throw new PicnicTwoFactorRequiredError()
    }

    const authKey = client.authKey
    try {
      return await send()
    } catch (error) {
      if (!(await isAuthKeyRejected(client, error, authKey))) {
        throw error
      }
      await recoverSession(authKey)
      if (twoFactorPending) {
        throw new PicnicTwoFactorRequiredError()
      }
      return send()
    }
  }

  return client
}

export async function initializePicnicClient(
  username?: string,
  password?: string,
  countryCode?: PicnicCountryCode,
  apiVersion?: string,
): Promise<void> {
  if (picnicClientInstance) {
    return
  }

  console.error("Initializing Picnic client...")
  const credentials: LoginCredentials = {
    username: username || config.PICNIC_USERNAME,
    password: password || config.PICNIC_PASSWORD,
  }
  const loginCountryCode = countryCode || config.PICNIC_COUNTRY_CODE

  const savedAuthKey = await loadSession()
  const deviceId = await resolveDeviceId()

  const clientOptions: PicnicClientOptions = {
    countryCode: loginCountryCode as PicnicClientOptions["countryCode"],
    apiVersion: apiVersion || config.PICNIC_API_VERSION,
    authKey: savedAuthKey ?? undefined,
    deviceId,
    agent: config.PICNIC_AGENT,
  }
  const client = new PicnicClient(clientOptions)

  if (savedAuthKey) {
    try {
      console.error("Testing saved auth key...")
      await client.cart.getCart()
      picnicClientInstance = withSessionRecovery(client, credentials)
      console.error("Successfully reused saved session.")
      return
    } catch {
      console.error("Saved session invalid, performing fresh login...")
      client.authKey = null // Clear invalid key before login
    }
  }

  const needsSecondFactor = await login(client, credentials)
  picnicClientInstance = withSessionRecovery(client, credentials)

  if (needsSecondFactor) {
    // Keep the partially authenticated client in memory so the 2FA tools can be called.
    twoFactorPending = true
    console.error(
      "Picnic login requires 2FA. Server will stay running so you can call picnic_generate_2fa_code and picnic_verify_2fa_code.",
    )
    return
  }

  await saveSession()
  console.error("Picnic client initialized successfully.")
}

export function getPicnicClient(): PicnicClientInstance {
  if (!picnicClientInstance) {
    throw new Error("Picnic client has not been initialized. Call initializePicnicClient() first.")
  }
  return picnicClientInstance
}

export async function resetPicnicClient(): Promise<void> {
  picnicClientInstance = null
  twoFactorPending = false
  recentRelogin = null
  try {
    await fs.unlink(config.PICNIC_SESSION_FILE)
  } catch {
    // Session file may not exist, ignore
  }
}
