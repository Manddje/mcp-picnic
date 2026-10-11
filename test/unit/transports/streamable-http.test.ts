import http from "http"
import { Socket } from "net"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  StreamableHttpServer,
  StreamableHttpServerOptions,
} from "../../../src/transports/streamable-http"
import { createMCPServer } from "../../../src/utils/server-factory"

// Mock dependencies
vi.mock("../../../src/utils/server-factory")
vi.mock("crypto", () => ({
  randomUUID: vi.fn(() => "test-session-id"),
  timingSafeEqual: vi.fn((a: Buffer, b: Buffer) => Buffer.compare(a, b) === 0),
}))

const mockTransport = {
  sessionId: "test-session-id",
  close: vi.fn().mockResolvedValue(undefined),
  onclose: undefined,
  handleRequest: vi.fn().mockResolvedValue(undefined),
}

vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  StreamableHTTPServerTransport: vi.fn().mockImplementation((options) => {
    const transport = {
      ...mockTransport,
      sessionId: "test-session-id",
      close: vi.fn().mockResolvedValue(undefined),
      onclose: undefined,
      handleRequest: vi.fn().mockResolvedValue(undefined),
    }

    if (options?.onsessioninitialized) {
      const sessionId = options.sessionIdGenerator
        ? options.sessionIdGenerator()
        : transport.sessionId
      transport.sessionId = sessionId
      options.onsessioninitialized(sessionId)
    }
    return transport
  }),
}))

describe("StreamableHttpServer", () => {
  let server: StreamableHttpServer
  const mockCreateMCPServer = vi.mocked(createMCPServer)
  const mockUnderlyingServer = {
    setRequestHandler: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
  }
  const mockSDKServer = {
    server: mockUnderlyingServer,
    connect: vi.fn().mockResolvedValue(undefined),
    handleRequest: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateMCPServer.mockReturnValue(mockSDKServer as any)
    mockSDKServer.connect.mockResolvedValue(undefined)
    vi.useFakeTimers()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    if (server) {
      try {
        await server.stop()
      } catch (error) {
        // Ignore errors during test cleanup
      }
    }
  })

  it("should create a server with default options", () => {
    server = new StreamableHttpServer()
    // @ts-expect-error - private property access
    expect(server.port).toBe(3000)
    // @ts-expect-error - private property access
    expect(server.host).toBe("localhost")
  })

  it("should create a server with custom options", () => {
    const options: StreamableHttpServerOptions = {
      port: 4000,
      host: "0.0.0.0",
      enableRequestLogging: true,
      rateLimitConfig: { windowMs: 1000, maxRequests: 10 },
    }
    server = new StreamableHttpServer(options)
    // @ts-expect-error - private property access
    expect(server.port).toBe(4000)
    // @ts-expect-error - private property access
    expect(server.host).toBe("0.0.0.0")
    // @ts-expect-error - private property access
    expect(server.rateLimiter).toBeDefined()
  })

  it("should start and stop the server", async () => {
    server = new StreamableHttpServer()
    const listenSpy = vi.spyOn(http.Server.prototype, "listen").mockImplementation(function (
      this: any,
      ...args: any[]
    ) {
      const callback = args[args.length - 1]
      if (typeof callback === "function") {
        callback()
      }
      return this
    })
    const closeSpy = vi.spyOn(http.Server.prototype, "close").mockImplementation(function (
      this: any,
      callback?: any,
    ) {
      if (typeof callback === "function") {
        callback()
      }
      return this
    })

    await server.start()
    // @ts-expect-error - private property access
    expect(server.server).toBeInstanceOf(http.Server)
    expect(listenSpy).toHaveBeenCalledWith(3000, "localhost", expect.any(Function))

    await server.stop()
    expect(closeSpy).toHaveBeenCalled()
  })

  it("should cleanup sessions on stop", async () => {
    server = new StreamableHttpServer()
    vi.spyOn(http.Server.prototype, "listen").mockImplementation(function (
      this: any,
      ...args: any[]
    ) {
      const callback = args[args.length - 1]
      if (typeof callback === "function") callback()
      return this
    })
    vi.spyOn(http.Server.prototype, "close").mockImplementation(function (
      this: any,
      callback: any,
    ) {
      if (callback) callback()
      return this
    })

    await server.start()
    await server.createNewSession()
    await server.stop()

    expect(server.getActiveSessions()).toHaveLength(0)
  })

  it("should provide a health check", async () => {
    vi.useRealTimers()
    server = new StreamableHttpServer({ port: 0, host: "127.0.0.1", enableRequestLogging: false })
    await server.start()

    // @ts-expect-error - private property access
    const httpServer = server.server as http.Server
    const address = httpServer.address() as { port: number }

    const res = await new Promise<{ statusCode: number; body: any }>((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port: address.port, path: "/health", method: "GET" },
        (response) => {
          let data = ""
          response.on("data", (chunk: string) => (data += chunk))
          response.on("end", () => {
            resolve({ statusCode: response.statusCode!, body: JSON.parse(data) })
          })
        },
      )
      req.on("error", reject)
      req.end()
    })

    expect(res.statusCode).toBe(200)
    expect(res.body).toEqual(
      expect.objectContaining({
        sessions: {
          active: 0,
          max: 100,
        },
      }),
    )
  })

  it("should setup routes", async () => {
    vi.useRealTimers()
    server = new StreamableHttpServer({ port: 0, host: "127.0.0.1", enableRequestLogging: false })
    await server.start()

    // @ts-expect-error - private property access
    const httpServer = server.server as http.Server
    const address = httpServer.address() as { port: number }

    const res = await new Promise<{ statusCode: number }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path: "/mcp",
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        (response) => {
          let data = ""
          response.on("data", (chunk: string) => (data += chunk))
          response.on("end", () => {
            resolve({ statusCode: response.statusCode! })
          })
        },
      )
      req.on("error", reject)
      req.write("{}")
      req.end()
    })

    // We get a response (not 404), meaning the /mcp route exists
    expect(res.statusCode).not.toBe(404)
  })

  it("should require authentication when authToken is configured", async () => {
    vi.useRealTimers()
    server = new StreamableHttpServer({
      port: 0,
      host: "127.0.0.1",
      enableRequestLogging: false,
      authToken: "secret",
    })
    await server.start()

    // @ts-expect-error - private property access
    const httpServer = server.server as http.Server
    const address = httpServer.address() as { port: number }

    const res = await new Promise<{ statusCode: number; body: any }>((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port: address.port, path: "/sessions", method: "GET" },
        (response) => {
          let data = ""
          response.on("data", (chunk: string) => (data += chunk))
          response.on("end", () => {
            resolve({ statusCode: response.statusCode!, body: JSON.parse(data) })
          })
        },
      )
      req.on("error", reject)
      req.end()
    })

    expect(res.statusCode).toBe(401)
    expect(res.body).toEqual(
      expect.objectContaining({
        error: "Unauthorized",
      }),
    )
  })

  it("should require auth for /mcp POST when authToken is configured", async () => {
    vi.useRealTimers()
    server = new StreamableHttpServer({
      port: 0,
      host: "127.0.0.1",
      enableRequestLogging: false,
      authToken: "secret",
    })
    await server.start()

    // @ts-expect-error - private property access
    const httpServer = server.server as http.Server
    const address = httpServer.address() as { port: number }

    const mcpRes = await new Promise<{ statusCode: number }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path: "/mcp",
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
        (response) => {
          response.on("data", () => {})
          response.on("end", () => {
            resolve({ statusCode: response.statusCode! })
          })
        },
      )
      req.on("error", reject)
      req.write("{}")
      req.end()
    })

    const healthRes = await new Promise<{ statusCode: number }>((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port: address.port, path: "/health", method: "GET" },
        (response) => {
          response.on("data", () => {})
          response.on("end", () => {
            resolve({ statusCode: response.statusCode! })
          })
        },
      )
      req.on("error", reject)
      req.end()
    })

    expect(mcpRes.statusCode).toBe(401)
    expect(healthRes.statusCode).toBe(200)
  })

  it("should reject wrong auth header token", async () => {
    vi.useRealTimers()
    server = new StreamableHttpServer({
      port: 0,
      host: "127.0.0.1",
      enableRequestLogging: false,
      authToken: "secret",
      authHeaderName: "x-api-token",
    })
    await server.start()

    // @ts-expect-error - private property access
    const httpServer = server.server as http.Server
    const address = httpServer.address() as { port: number }

    const sessionsRes = await new Promise<{ statusCode: number }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path: "/sessions",
          method: "GET",
          headers: { "x-api-token": "wrong" },
        },
        (response) => {
          response.on("data", () => {})
          response.on("end", () => {
            resolve({ statusCode: response.statusCode! })
          })
        },
      )
      req.on("error", reject)
      req.end()
    })

    expect(sessionsRes.statusCode).toBe(401)
  })

  it("should allow custom header token authentication", async () => {
    vi.useRealTimers()
    server = new StreamableHttpServer({
      port: 0,
      host: "127.0.0.1",
      enableRequestLogging: false,
      authToken: "secret",
      authHeaderName: "x-api-token",
    })
    await server.start()

    // @ts-expect-error - private property access
    const httpServer = server.server as http.Server
    const address = httpServer.address() as { port: number }

    const sessionsRes = await new Promise<{ statusCode: number }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path: "/sessions",
          method: "GET",
          headers: { "x-api-token": "secret" },
        },
        (response) => {
          response.on("data", () => {})
          response.on("end", () => {
            resolve({ statusCode: response.statusCode! })
          })
        },
      )
      req.on("error", reject)
      req.end()
    })

    expect(sessionsRes.statusCode).toBe(200)
  })

  it("should allow authorization bearer token authentication", async () => {
    vi.useRealTimers()
    server = new StreamableHttpServer({
      port: 0,
      host: "127.0.0.1",
      enableRequestLogging: false,
      authToken: "secret",
    })
    await server.start()

    // @ts-expect-error - private property access
    const httpServer = server.server as http.Server
    const address = httpServer.address() as { port: number }

    const sessionsRes = await new Promise<{ statusCode: number }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path: "/sessions",
          method: "GET",
          headers: { Authorization: "Bearer secret" },
        },
        (response) => {
          response.on("data", () => {})
          response.on("end", () => {
            resolve({ statusCode: response.statusCode! })
          })
        },
      )
      req.on("error", reject)
      req.end()
    })

    expect(sessionsRes.statusCode).toBe(200)
  })

  it("should not recurse when transport close fires onclose during session cleanup", () => {
    server = new StreamableHttpServer({ enableRequestLogging: false })
    const sessionId = "regression-session"

    const transport: {
      sessionId: string
      closeCalls: number
      onclose?: () => void
      close: () => void
    } = {
      sessionId,
      closeCalls: 0,
      close() {
        this.closeCalls++
        this.onclose?.()
      },
    }

    transport.onclose = () => {
      if (transport.sessionId) {
        server.cleanupSession(transport.sessionId)
      }
    }

    // @ts-expect-error - private property access
    server.transports[sessionId] = transport

    expect(() => server.cleanupSession(sessionId)).not.toThrow()
    expect(transport.closeCalls).toBe(1)
    expect(server.getActiveSessions()).toEqual([])
  })
})

interface InjectedResponse {
  status: number
  headers: http.OutgoingHttpHeaders
  body: string
}

/**
 * Runs a request through the server's Express app in-process, the way Node's HTTP server would
 * hand it over, so these tests don't need to bind a port.
 */
function inject(
  target: StreamableHttpServer,
  request: { method?: string; path?: string; headers?: Record<string, string> } = {},
): Promise<InjectedResponse> {
  const { method = "GET", path = "/health", headers = {} } = request
  return new Promise((resolve) => {
    const req = new http.IncomingMessage(new Socket())
    req.method = method
    req.url = path
    req.headers = Object.fromEntries(
      Object.entries({ host: "localhost:3000", ...headers }).map(([name, value]) => [
        name.toLowerCase(),
        value,
      ]),
    )
    req.push(null)

    const res = new http.ServerResponse(req)
    const chunks: Buffer[] = []
    res.write = ((chunk: string | Buffer) => {
      chunks.push(Buffer.from(chunk))
      return true
    }) as typeof res.write
    res.end = ((chunk?: unknown) => {
      if (typeof chunk === "string" || Buffer.isBuffer(chunk)) {
        chunks.push(Buffer.from(chunk))
      }
      resolve({
        status: res.statusCode,
        headers: res.getHeaders(),
        body: Buffer.concat(chunks).toString(),
      })
      res.emit("finish")
      return res
    }) as typeof res.end

    // @ts-expect-error - private property access
    target.app(req, res)
  })
}

describe("StreamableHttpServer request validation", () => {
  let server: StreamableHttpServer | undefined

  afterEach(async () => {
    vi.restoreAllMocks()
    await server?.stop().catch(() => {})
    server = undefined
  })

  describe("when bound to a loopback host", () => {
    it.each(["localhost:3000", "127.0.0.1:3000", "[::1]:3000"])("accepts Host %s", async (host) => {
      server = new StreamableHttpServer({ enableRequestLogging: false })

      const res = await inject(server, { headers: { host } })

      expect(res.status).toBe(200)
    })

    it("rejects any other Host, which is what a DNS rebinding attack sends", async () => {
      server = new StreamableHttpServer({ enableRequestLogging: false })

      const res = await inject(server, { headers: { host: "attacker.example:3000" } })

      expect(res.status).toBe(403)
      expect(JSON.parse(res.body).error.message).toBe("Invalid Host: attacker.example")
    })
  })

  it("leaves Host alone when a non-loopback bind is protected by the auth token", async () => {
    server = new StreamableHttpServer({
      host: "0.0.0.0",
      authToken: "secret",
      enableRequestLogging: false,
    })

    const res = await inject(server, { headers: { host: "192.168.1.20:3000" } })

    expect(res.status).toBe(200)
  })

  describe("browser origins", () => {
    it("rejects requests from other websites", async () => {
      server = new StreamableHttpServer({ enableRequestLogging: false })

      const res = await inject(server, { headers: { origin: "https://attacker.example" } })

      expect(res.status).toBe(403)
      expect(JSON.parse(res.body).error.message).toBe("Invalid Origin: https://attacker.example")
      expect(res.headers["access-control-allow-origin"]).toBeUndefined()
    })

    it("lets loopback pages in and exposes the session header to them", async () => {
      server = new StreamableHttpServer({ enableRequestLogging: false })

      const res = await inject(server, { headers: { origin: "http://localhost:6274" } })

      expect(res.status).toBe(200)
      expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:6274")
      expect(res.headers["access-control-expose-headers"]).toBe("Mcp-Session-Id")
    })

    it("sends no CORS headers to clients that are not browsers", async () => {
      server = new StreamableHttpServer({ enableRequestLogging: false })

      const res = await inject(server)

      expect(res.status).toBe(200)
      expect(res.headers["access-control-allow-origin"]).toBeUndefined()
    })

    it("answers preflights before asking for the auth token", async () => {
      server = new StreamableHttpServer({ enableRequestLogging: false, authToken: "secret" })

      const res = await inject(server, {
        method: "OPTIONS",
        path: "/mcp",
        headers: {
          origin: "http://127.0.0.1:6274",
          "access-control-request-method": "POST",
          "access-control-request-headers":
            "content-type,authorization,mcp-session-id,mcp-protocol-version",
        },
      })

      expect(res.status).toBe(204)
      expect(res.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:6274")
      expect(String(res.headers["access-control-allow-headers"]).split(",")).toEqual(
        expect.arrayContaining([
          "Content-Type",
          "Authorization",
          "Mcp-Session-Id",
          "Mcp-Protocol-Version",
          "x-mcp-token",
        ]),
      )
    })

    it("lets in configured origins, whatever URL form they are given in", async () => {
      server = new StreamableHttpServer({
        enableRequestLogging: false,
        allowedOrigins: ["https://app.example.com/"],
      })

      const allowed = await inject(server, { headers: { origin: "https://app.example.com" } })
      const other = await inject(server, { headers: { origin: "https://other.example.com" } })

      expect(allowed.status).toBe(200)
      expect(allowed.headers["access-control-allow-origin"]).toBe("https://app.example.com")
      expect(other.status).toBe(403)
    })

    it("lets in every origin when configured with *", async () => {
      server = new StreamableHttpServer({ enableRequestLogging: false, allowedOrigins: ["*"] })

      const res = await inject(server, { headers: { origin: "https://anywhere.example" } })

      expect(res.status).toBe(200)
    })

    it("rejects a configured origin that is not a URL", () => {
      expect(() => new StreamableHttpServer({ allowedOrigins: ["app.example.com"] })).toThrow(
        'Invalid allowed origin "app.example.com"',
      )
    })
  })

  describe("start", () => {
    it("refuses a non-loopback host without an auth token", async () => {
      server = new StreamableHttpServer({ host: "0.0.0.0", enableRequestLogging: false })
      const listenSpy = vi.spyOn(http.Server.prototype, "listen")

      await expect(server.start()).rejects.toThrow(
        "Refusing to start the HTTP server on 0.0.0.0 without HTTP_AUTH_TOKEN",
      )
      expect(listenSpy).not.toHaveBeenCalled()
    })

    it("binds to a non-loopback host when an auth token is set", async () => {
      server = new StreamableHttpServer({
        host: "0.0.0.0",
        authToken: "secret",
        enableRequestLogging: false,
      })
      const listenSpy = vi.spyOn(http.Server.prototype, "listen").mockImplementation(function (
        this: any,
        ...args: any[]
      ) {
        args[args.length - 1]()
        return this
      })

      await server.start()

      expect(listenSpy).toHaveBeenCalledWith(3000, "0.0.0.0", expect.any(Function))
    })

    it("fails when the port can't be bound", async () => {
      server = new StreamableHttpServer({ enableRequestLogging: false })
      vi.spyOn(http.Server.prototype, "listen").mockImplementation(function (this: any) {
        this.emit("error", new Error("listen EADDRINUSE: address already in use 127.0.0.1:3000"))
        return this
      })

      await expect(server.start()).rejects.toThrow("EADDRINUSE")
    })
  })
})
