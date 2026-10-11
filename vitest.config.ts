import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/unit/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    env: {
      PICNIC_USERNAME: "test-username",
      PICNIC_PASSWORD: "test-password",
    },
  },
})
