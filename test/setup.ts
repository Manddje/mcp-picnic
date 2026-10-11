import { beforeAll, expect } from "vitest"
import dotenv from "dotenv"

// Load environment variables from .env file
dotenv.config()

// Make sure we have the required environment variables for tests
// For tests, we'll set these programmatically so we don't require them in setup
beforeAll(() => {
  // Set default test environment variables if not present
  if (!process.env.PICNIC_USERNAME) {
    process.env.PICNIC_USERNAME = "test-username"
  }
  if (!process.env.PICNIC_PASSWORD) {
    process.env.PICNIC_PASSWORD = "test-password"
  }
})

// Add custom matcher for error responses
expect.extend({
  toBeErrorResponse(received, message) {
    const pass =
      received.isError === true &&
      received.content &&
      received.content[0] &&
      received.content[0].text.includes(message)

    if (pass) {
      return {
        message: () => `expected ${received} not to be an error response containing "${message}"`,
        pass: true,
      }
    } else {
      return {
        message: () => `expected ${received} to be an error response containing "${message}"`,
        pass: false,
      }
    }
  },
})

export { expect }
