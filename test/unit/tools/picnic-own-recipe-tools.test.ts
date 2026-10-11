import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ToolResult } from "../../../src/tools/registry.js"

const mocks = vi.hoisted(() => ({
  initializePicnicClient: vi.fn(),
  sendRequest: vi.fn(),
  getPage: vi.fn(),
  getRscPage: vi.fn(),
  recipe: {
    getRecipe: vi.fn(),
    createUserDefinedRecipe: vi.fn(),
    setUserDefinedRecipeNote: vi.fn(),
    addUserDefinedRecipeIngredient: vi.fn(),
    updateUserDefinedRecipeIngredient: vi.fn(),
    assignSellableComponentToDay: vi.fn(),
    getUserDefinedRecipeSuggestedImages: vi.fn(),
    selectUserDefinedRecipeImage: vi.fn(),
    uploadUserDefinedRecipeImage: vi.fn(),
  },
}))

vi.mock("../../../src/utils/picnic-client.js", () => ({
  getPicnicClient: () => ({
    url: "https://storefront-prod.nl.picnicinternational.com/api/15",
    sendRequest: mocks.sendRequest,
    recipe: mocks.recipe,
    app: { getPage: mocks.getPage, getRscPage: mocks.getRscPage },
  }),
  initializePicnicClient: mocks.initializePicnicClient,
  saveSession: vi.fn(),
  verifyPicnic2FACode: vi.fn(),
}))

const OWN_RECIPE = "0123456789abcdef0123456789abcdef"

function parseToolResult(result: ToolResult) {
  return JSON.parse(result.content[0].text ?? "")
}

function recipeDetails() {
  return {
    id: OWN_RECIPE,
    name: "Pasta pesto",
    imageType: "COMPOSED",
    portions: 2,
    defaultPortions: 2,
    displayedPortions: 2,
    creatorType: "USER",
    isRecipeOwner: true,
    isSaved: false,
    imageId: null,
    note: "<p>Kook de pasta.</p><p>Roer &amp; serveer</p>",
    ingredients: [
      {
        ingredientId: "c1",
        name: "Pasta",
        sellingUnitId: "s100",
        quantity: 1,
        status: "ACTIVE",
        swapType: null,
        checked: true,
      },
      {
        ingredientId: "c2",
        name: "Pesto",
        sellingUnitId: "s200",
        quantity: 1,
        status: "ACTIVE",
        swapType: null,
        checked: true,
      },
    ],
  }
}

async function loadTools() {
  vi.resetModules()
  const { toolRegistry } = await import("../../../src/tools/registry.js")
  await import("../../../src/tools/picnic-tools.js")
  return toolRegistry
}

describe("own recipe tools", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("returns an own recipe with ingredient ids and the note as plain text", async () => {
    mocks.recipe.getRecipe.mockResolvedValue(recipeDetails())

    const toolRegistry = await loadTools()
    const payload = parseToolResult(
      await toolRegistry.executeTool("picnic_get_own_recipe", { recipe_url_or_id: OWN_RECIPE }),
    )

    expect(mocks.recipe.getRecipe).toHaveBeenCalledWith(OWN_RECIPE, undefined, {
      resolveIngredientNames: true,
    })
    expect(payload.note).toBe("Kook de pasta.\nRoer & serveer")
    expect(payload.ingredients[0]).toEqual({
      ingredientId: "c1",
      productId: "s100",
      name: "Pasta",
      quantity: 1,
      status: "ACTIVE",
    })
  })

  describe("picnic_create_recipe", () => {
    it("merges repeated products and stores the note as escaped paragraphs", async () => {
      mocks.recipe.createUserDefinedRecipe.mockResolvedValue({ sellingGroupId: OWN_RECIPE })

      const toolRegistry = await loadTools()
      const payload = parseToolResult(
        await toolRegistry.executeTool("picnic_create_recipe", {
          name: "Pasta pesto",
          ingredients: [
            { product_id: "s100" },
            { product_id: "s200", quantity: 2 },
            { product_id: "s100" },
          ],
          portions: 2,
          note: "Kook <al dente>\nServeer",
        }),
      )

      expect(mocks.recipe.createUserDefinedRecipe).toHaveBeenCalledWith(
        "Pasta pesto",
        [
          { sellingUnitId: "s100", quantity: 2 },
          { sellingUnitId: "s200", quantity: 2 },
        ],
        2,
      )
      expect(mocks.recipe.setUserDefinedRecipeNote).toHaveBeenCalledWith(
        OWN_RECIPE,
        "<p>Kook &lt;al dente&gt;</p><p>Serveer</p>",
      )
      expect(payload).toMatchObject({ recipeId: OWN_RECIPE, portions: 2, noteSet: true })
    })

    // The recipe already exists when the note fails, so failing the call would invite a
    // retry that creates a duplicate recipe.
    it("still returns the new recipe when setting the note fails", async () => {
      mocks.recipe.createUserDefinedRecipe.mockResolvedValue({ sellingGroupId: OWN_RECIPE })
      mocks.recipe.setUserDefinedRecipeNote.mockRejectedValue(new Error("boom"))

      const toolRegistry = await loadTools()
      const payload = parseToolResult(
        await toolRegistry.executeTool("picnic_create_recipe", {
          name: "Pasta pesto",
          ingredients: [{ product_id: "s100" }],
          note: "Kook de pasta",
        }),
      )

      expect(payload.recipeId).toBe(OWN_RECIPE)
      expect(payload.noteSet).toBe(false)
      expect(payload.noteError).toMatch(/picnic_set_recipe_note/)
    })

    it("rejects names over the app's 43 character limit before calling Picnic", async () => {
      const toolRegistry = await loadTools()

      await expect(
        toolRegistry.executeTool("picnic_create_recipe", {
          name: "x".repeat(44),
          ingredients: [{ product_id: "s100" }],
        }),
      ).rejects.toThrow(/Invalid input/)
      expect(mocks.recipe.createUserDefinedRecipe).not.toHaveBeenCalled()
    })
  })

  it("adds an ingredient after the existing ones, for the recipe's portions", async () => {
    mocks.recipe.getRecipe.mockResolvedValue(recipeDetails())
    mocks.recipe.addUserDefinedRecipeIngredient.mockResolvedValue({ newComponentId: "c3" })

    const toolRegistry = await loadTools()
    const payload = parseToolResult(
      await toolRegistry.executeTool("picnic_add_recipe_ingredient", {
        recipe_url_or_id: OWN_RECIPE,
        product_id: "s300",
      }),
    )

    expect(mocks.recipe.addUserDefinedRecipeIngredient).toHaveBeenCalledWith(
      OWN_RECIPE,
      "s300",
      1,
      2,
      2,
    )
    expect(payload.ingredientId).toBe("c3")
  })

  describe("picnic_update_recipe_ingredient", () => {
    it("changes only the quantity when no product is given", async () => {
      mocks.recipe.getRecipe.mockResolvedValue(recipeDetails())
      mocks.recipe.updateUserDefinedRecipeIngredient.mockResolvedValue({})

      const toolRegistry = await loadTools()
      const payload = parseToolResult(
        await toolRegistry.executeTool("picnic_update_recipe_ingredient", {
          recipe_url_or_id: OWN_RECIPE,
          ingredient_id: "c1",
          quantity: 3,
        }),
      )

      expect(mocks.recipe.updateUserDefinedRecipeIngredient).toHaveBeenCalledWith(
        OWN_RECIPE,
        "c1",
        { s100: 3 },
        2,
        undefined,
      )
      expect(mocks.recipe.assignSellableComponentToDay).not.toHaveBeenCalled()
      expect(payload.cartUpdated).toBe(false)
    })

    // The edit removes the replaced product from the cart; without the follow-up the cart
    // lacks the ingredient altogether.
    it("swaps the product and pushes the new selection to the cart when asked to", async () => {
      mocks.recipe.getRecipe.mockResolvedValue(recipeDetails())
      mocks.recipe.updateUserDefinedRecipeIngredient.mockResolvedValue({ shouldUpdateCart: true })

      const toolRegistry = await loadTools()
      const payload = parseToolResult(
        await toolRegistry.executeTool("picnic_update_recipe_ingredient", {
          recipe_url_or_id: OWN_RECIPE,
          ingredient_id: "c1",
          quantity: 1,
          product_id: "s999",
        }),
      )

      // Picnic fails to render the edit when a single-product ingredient's old product is
      // sent with quantity 0, so only the new selection goes out.
      expect(mocks.recipe.updateUserDefinedRecipeIngredient).toHaveBeenCalledWith(
        OWN_RECIPE,
        "c1",
        { s999: 1 },
        2,
        "SEARCH_SELECTION",
      )
      expect(mocks.recipe.assignSellableComponentToDay).toHaveBeenCalledWith(
        OWN_RECIPE,
        "c1",
        { s999: 1 },
        2,
        "SEARCH_SELECTION",
      )
      expect(payload.cartUpdated).toBe(true)
    })

    it("zeroes the other products of an ingredient that has several", async () => {
      const details = recipeDetails()
      details.ingredients.push({ ...details.ingredients[0], sellingUnitId: "s101", quantity: 1 })
      mocks.recipe.getRecipe.mockResolvedValue(details)
      mocks.recipe.updateUserDefinedRecipeIngredient.mockResolvedValue({})

      const toolRegistry = await loadTools()
      await toolRegistry.executeTool("picnic_update_recipe_ingredient", {
        recipe_url_or_id: OWN_RECIPE,
        ingredient_id: "c1",
        quantity: 2,
        product_id: "s100",
      })

      expect(mocks.recipe.updateUserDefinedRecipeIngredient).toHaveBeenCalledWith(
        OWN_RECIPE,
        "c1",
        { s100: 2, s101: 0 },
        2,
        "WITHIN_SELLING_GROUP_COMPONENT",
      )
    })

    it("rejects an ingredient id that is not part of the recipe", async () => {
      mocks.recipe.getRecipe.mockResolvedValue(recipeDetails())

      const toolRegistry = await loadTools()

      await expect(
        toolRegistry.executeTool("picnic_update_recipe_ingredient", {
          recipe_url_or_id: OWN_RECIPE,
          ingredient_id: "unknown",
          quantity: 1,
        }),
      ).rejects.toThrow(/picnic_get_own_recipe/)
      expect(mocks.recipe.updateUserDefinedRecipeIngredient).not.toHaveBeenCalled()
    })
  })

  describe("picnic_set_recipe_image", () => {
    it("requires exactly one image source", async () => {
      const toolRegistry = await loadTools()

      await expect(
        toolRegistry.executeTool("picnic_set_recipe_image", { recipe_url_or_id: OWN_RECIPE }),
      ).rejects.toThrow(/exactly one/)
      await expect(
        toolRegistry.executeTool("picnic_set_recipe_image", {
          recipe_url_or_id: OWN_RECIPE,
          suggested_image_id: "img1",
          image_base64: "aGk=",
        }),
      ).rejects.toThrow(/exactly one/)
    })

    it("selects a suggested image together with its reference metadata", async () => {
      const referenceImage = {
        id: "img1",
        namespace: "recipes",
        primary_image: true,
        rank_value: 1,
        sellable_id: OWN_RECIPE,
        type: "SUGGESTED",
      }
      mocks.recipe.getUserDefinedRecipeSuggestedImages.mockResolvedValue([
        { id: "img1", referenceImage },
      ])

      const toolRegistry = await loadTools()
      await toolRegistry.executeTool("picnic_set_recipe_image", {
        recipe_url_or_id: OWN_RECIPE,
        suggested_image_id: "img1",
      })

      expect(mocks.recipe.selectUserDefinedRecipeImage).toHaveBeenCalledWith(
        OWN_RECIPE,
        "img1",
        referenceImage,
      )
    })

    it("uploads a data URL photo and selects the returned image", async () => {
      mocks.recipe.uploadUserDefinedRecipeImage.mockResolvedValue({ image_id: "upload-1" })

      const toolRegistry = await loadTools()
      const payload = parseToolResult(
        await toolRegistry.executeTool("picnic_set_recipe_image", {
          recipe_url_or_id: OWN_RECIPE,
          image_base64: "data:image/png;base64,aGVsbG8=",
        }),
      )

      const [recipeId, image] = mocks.recipe.uploadUserDefinedRecipeImage.mock.calls[0]
      expect(recipeId).toBe(OWN_RECIPE)
      expect(image.type).toBe("image/png")
      expect(Buffer.from(image.data).toString()).toBe("hello")
      expect(mocks.recipe.selectUserDefinedRecipeImage).toHaveBeenCalledWith(OWN_RECIPE, "upload-1")
      expect(payload.imageId).toBe("upload-1")
    })
  })
})

describe("recipe page render errors", () => {
  const renderError = () =>
    new Error("Error rendering page_id='selling-group-details-page' for bundle_version='abc'")

  beforeEach(() => {
    vi.clearAllMocks()
  })

  // Picnic briefly fails to render a recipe right after it was changed.
  it("retries a read that fails to render once", async () => {
    mocks.recipe.getRecipe.mockRejectedValueOnce(renderError()).mockResolvedValue(recipeDetails())

    const toolRegistry = await loadTools()
    vi.useFakeTimers()
    try {
      const pending = toolRegistry.executeTool("picnic_get_own_recipe", {
        recipe_url_or_id: OWN_RECIPE,
      })
      await vi.runAllTimersAsync()
      const payload = parseToolResult(await pending)

      expect(mocks.recipe.getRecipe).toHaveBeenCalledTimes(2)
      expect(payload.recipeId).toBe(OWN_RECIPE)
    } finally {
      vi.useRealTimers()
    }
  })

  it("explains a portion count that Picnic keeps refusing", async () => {
    mocks.recipe.getRecipe.mockRejectedValue(renderError())

    const toolRegistry = await loadTools()
    vi.useFakeTimers()
    try {
      const pending = toolRegistry.executeTool("picnic_get_own_recipe", {
        recipe_url_or_id: OWN_RECIPE,
        portions: 3,
      })
      const assertion = expect(pending).rejects.toThrow(/multiples of their default portion count/)
      await vi.runAllTimersAsync()
      await assertion

      expect(mocks.recipe.getRecipe).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("recipe cart and detail options", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("reports unavailable ingredients and the assigned portions when adding to the cart", async () => {
    mocks.sendRequest.mockResolvedValue({
      anyUnavailableIngredient: true,
      assignedNumberOfPortions: 4,
      cart: {},
    })

    const toolRegistry = await loadTools()
    const payload = parseToolResult(
      await toolRegistry.executeTool("picnic_add_recipe_to_cart", { recipe_url_or_id: OWN_RECIPE }),
    )

    expect(payload).toMatchObject({ portions: 4, anyUnavailableIngredient: true })
  })

  it("lists the products removed with a recipe", async () => {
    mocks.sendRequest.mockResolvedValue({
      SURemoved: [{ selling_unit_id: "s100", quantity: 2 }],
    })

    const toolRegistry = await loadTools()
    const payload = parseToolResult(
      await toolRegistry.executeTool("picnic_remove_recipe_from_cart", {
        recipe_url_or_id: OWN_RECIPE,
      }),
    )

    expect(payload.removedProducts).toEqual([{ productId: "s100", quantity: 2 }])
  })

  it("requests the recipe page for the given number of portions", async () => {
    // An empty page has no ingredients to parse; only the requested route matters here.
    mocks.sendRequest.mockResolvedValue({})

    const toolRegistry = await loadTools()
    await expect(
      toolRegistry.executeTool("picnic_get_recipe_ingredients", {
        recipe_url_or_id: OWN_RECIPE,
        portions: 6,
      }),
    ).rejects.toThrow(/Could not find recipe ingredient data/)

    expect(mocks.sendRequest).toHaveBeenCalledWith(
      "GET",
      `/pages/selling-group-details-page?selling_group_id=${OWN_RECIPE}&portions=6`,
      null,
      true,
    )
  })
})

describe("picnic_get_page", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("falls back to the RSC route when Picnic serves the page in that format", async () => {
    const toolRegistry = await loadTools()
    const { default: PicnicClient } = await import("picnic-api")
    mocks.getPage.mockRejectedValue(
      new PicnicClient.UnexpectedPageFormatError("profile-root", "rsc"),
    )
    mocks.getRscPage.mockResolvedValue({ rows: { "0": ["$", "div", null, {}] }, modules: {} })

    const payload = parseToolResult(
      await toolRegistry.executeTool("picnic_get_page", { page_id: "profile-root" }),
    )

    expect(mocks.getRscPage).toHaveBeenCalledWith("profile-root")
    expect(payload.format).toBe("rsc")
    expect(JSON.parse(payload.content).rows["0"][1]).toBe("div")
  })

  it("returns large pages in chunks", async () => {
    mocks.getPage.mockResolvedValue({ body: "x".repeat(5000) })

    const toolRegistry = await loadTools()
    const payload = parseToolResult(
      await toolRegistry.executeTool("picnic_get_page", { page_id: "big", max_chars: 1000 }),
    )

    expect(payload).toMatchObject({ format: "fusion", returnedChars: 1000, hasMore: true })
  })

  it("rejects page ids that could reach other API paths", async () => {
    const toolRegistry = await loadTools()

    for (const page_id of ["../cart", "a/b", "profile-root#x"]) {
      await expect(toolRegistry.executeTool("picnic_get_page", { page_id })).rejects.toThrow(
        /Invalid input/,
      )
    }
    expect(mocks.getPage).not.toHaveBeenCalled()
  })
})

// Placing orders is deliberately not supported: no tool may start a checkout or a payment.
describe("ordering", () => {
  it("exposes no checkout, order or payment tools", async () => {
    const toolRegistry = await loadTools()
    const names = toolRegistry.getToolsList().map((tool: { name: string }) => tool.name)

    expect(names).toContain("picnic_create_recipe")
    expect(
      names.filter((name) => /checkout|confirm_order|place_order|pay$|payment$/.test(name)),
    ).toEqual([])
  })
})
