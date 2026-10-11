import { promptRegistry, PromptResult } from "./registry.js"

/**
 * Closing line of every prompt. Placing orders was removed on purpose, so the model is told up
 * front that its work ends at the cart instead of offering a checkout it cannot do.
 */
export const NO_ORDERING_NOTE =
  "These tools cannot place the order: once the cart is ready, I check out and pay in the Picnic app myself."

/**
 * Builds a prompt result as a single user message: the role-setting context, the request and
 * the no-ordering note.
 *
 * MCP prompt messages only have "user" and "assistant" roles, so the context that would be a
 * system message elsewhere opens the user message instead.
 */
function userPrompt(context: string, request: string): PromptResult {
  return {
    messages: [
      {
        role: "user",
        content: { type: "text", text: [context, request, NO_ORDERING_NOTE].join("\n\n") },
      },
    ],
  }
}

// Meal planning prompt
promptRegistry.register({
  name: "picnic_meal_planner",
  description: "Create a meal plan and generate a shopping list for Picnic",
  arguments: [
    {
      name: "days",
      description: "Number of days to plan meals for",
      required: false,
    },
    {
      name: "people",
      description: "Number of people to cook for",
      required: false,
    },
    {
      name: "dietary_restrictions",
      description: "Any dietary restrictions or preferences",
      required: false,
    },
  ],
  handler: async (args) => {
    const days = args?.days || "7"
    const people = args?.people || "2"
    const dietaryRestrictions = args?.dietary_restrictions || "none"

    return userPrompt(
      "You are a meal planning expert with access to Picnic's grocery delivery service. Help create practical meal plans and shopping lists.",
      `Create a ${days}-day meal plan for ${people} people. Dietary restrictions: ${dietaryRestrictions}. ` +
        "Find recipes with picnic_browse_recipes, picnic_get_saved_recipes and picnic_get_own_recipes, check picnic_get_promotions for deals worth planning around, and read promising recipes with picnic_get_recipe. " +
        "Fetch the ingredients of the shortlist in one call with picnic_get_multiple_recipe_ingredients, use picnic_find_meal_combinations to pick recipes that share ingredients, and summarize the shopping list with picnic_build_shopping_list. " +
        `Add the chosen recipes with picnic_add_recipe_to_cart for ${people} portions. For a meal that is not a Picnic recipe, find its products with picnic_search and add them with picnic_add_to_cart, or offer to save it as an own recipe with picnic_create_recipe first. ` +
        "Finish by reviewing the cart with picnic_get_cart.",
    )
  },
})

// Budget shopping prompt
promptRegistry.register({
  name: "picnic_budget_shopping",
  description: "Help create a budget-conscious shopping list with Picnic",
  arguments: [
    {
      name: "budget",
      description: "Weekly grocery budget in euros",
      required: true,
    },
    {
      name: "household_size",
      description: "Number of people in the household",
      required: false,
    },
  ],
  handler: async (args) => {
    const budget = args?.budget || "100"
    const householdSize = args?.household_size || "2"

    return userPrompt(
      "You are a budget-conscious shopping expert with access to Picnic's online supermarket. Help maximize grocery budgets while maintaining nutritional quality.",
      `Create a budget-conscious shopping list for €${budget} per week for ${householdSize} people. ` +
        "Start from this week's deals with picnic_get_promotions and find budget-friendly staples with picnic_search. " +
        "To plan meals, pick candidate recipes with picnic_browse_recipes, fetch their ingredients with picnic_get_multiple_recipe_ingredients, and let picnic_find_meal_combinations rank combinations that share ingredients, with maxTotalBudgetCents set to the budget in cents. " +
        "Add products with picnic_add_to_cart and recipes with picnic_add_recipe_to_cart, keep a running total, and check it against the budget with picnic_get_cart.",
    )
  },
})

// Quick dinner solutions prompt
promptRegistry.register({
  name: "picnic_quick_dinner",
  description: "Find ingredients for quick and easy dinner solutions available on Picnic",
  arguments: [
    {
      name: "time_limit",
      description: "Maximum cooking time in minutes",
      required: false,
    },
    {
      name: "dietary_preferences",
      description: "Any dietary preferences or restrictions",
      required: false,
    },
  ],
  handler: async (args) => {
    const timeLimit = args?.time_limit || "30"
    const dietaryPreferences = args?.dietary_preferences || "none"

    return userPrompt(
      "You are a quick-cooking expert with access to Picnic's grocery delivery service. Focus on fast, practical recipes for busy people.",
      `Find dinner solutions that can be prepared in ${timeLimit} minutes or less. Dietary preferences: ${dietaryPreferences}. ` +
        "Browse Picnic's recipes with picnic_browse_recipes (its category list often includes quick recipes) and check preparation times with picnic_get_recipe; use picnic_search for ready-made solutions. " +
        "Add the best option to the cart with picnic_add_recipe_to_cart, or with picnic_add_to_cart for individual products.",
    )
  },
})

// Healthy eating prompt
promptRegistry.register({
  name: "picnic_healthy_eating",
  description: "Create a healthy eating plan with products available on Picnic",
  arguments: [
    {
      name: "health_goal",
      description: "Specific health goal (weight loss, muscle gain, heart health, etc.)",
      required: false,
    },
    {
      name: "food_allergies",
      description: "Any food allergies or intolerances",
      required: false,
    },
  ],
  handler: async (args) => {
    const healthGoal = args?.health_goal || "general wellness"
    const foodAllergies = args?.food_allergies || "none"

    return userPrompt(
      "You are a nutrition-focused shopping advisor with access to Picnic's online supermarket. Focus on whole foods and balanced nutrition.",
      `Help me transition to healthier eating for ${healthGoal}. Food allergies: ${foodAllergies}. ` +
        "Use picnic_search to find healthy alternatives and nutritious products, and check ingredients, allergens and nutritional values with picnic_get_product_details (full=true) before recommending one. " +
        "Suggest a few fitting Picnic recipes from picnic_browse_recipes and picnic_get_recipe, then add a week's worth of healthy staples to the cart with picnic_add_to_cart or picnic_add_recipe_to_cart.",
    )
  },
})

// Special occasion shopping prompt
promptRegistry.register({
  name: "picnic_special_occasion",
  description: "Plan shopping for special occasions and gatherings using Picnic",
  arguments: [
    {
      name: "occasion",
      description: "Type of occasion (birthday party, dinner party, holiday meal, BBQ, etc.)",
      required: true,
    },
    {
      name: "guest_count",
      description: "Number of guests expected",
      required: false,
    },
  ],
  handler: async (args) => {
    const occasion = args?.occasion || "dinner party"
    const guestCount = args?.guest_count || "6-8"

    return userPrompt(
      "You are an event planning expert with access to Picnic's grocery delivery service. Help create memorable occasions with great food.",
      `Plan shopping for a ${occasion} for ${guestCount} people, with appetizers, main courses, sides and desserts. ` +
        "Use Picnic recipes where they fit (picnic_browse_recipes, picnic_get_recipe) and add them with picnic_add_recipe_to_cart for the number of guests; find everything else with picnic_search and add it with picnic_add_to_cart. " +
        "Check picnic_get_promotions for deals and picnic_get_delivery_slots for a delivery that arrives in time. Review the cart with picnic_get_cart and provide a preparation timeline.",
    )
  },
})

// Pantry restocking prompt
promptRegistry.register({
  name: "picnic_pantry_restock",
  description: "Help restock pantry essentials and household items through Picnic",
  arguments: [
    {
      name: "household_type",
      description: "Type of household (single person, couple, family with kids, etc.)",
      required: false,
    },
    {
      name: "cooking_frequency",
      description: "How often you cook at home",
      required: false,
    },
  ],
  handler: async (args) => {
    const householdType = args?.household_type || "small household"
    const cookingFrequency = args?.cooking_frequency || "regularly"

    return userPrompt(
      "You are a household organization expert with access to Picnic's grocery delivery service. Help maintain well-stocked pantries and kitchens.",
      `Help restock pantry essentials for a ${householdType} that cooks ${cookingFrequency}. ` +
        "Look at recent deliveries with picnic_get_deliveries and picnic_get_delivery to see what is usually bought, and check picnic_get_promotions for staples on offer. " +
        "Use picnic_search to find pantry staples, household necessities and versatile ingredients. Check picnic_get_cart first so nothing is added twice, then add appropriate quantities with picnic_add_to_cart.",
    )
  },
})

// Order management prompt
promptRegistry.register({
  name: "picnic_order_management",
  description: "Help manage Picnic orders, deliveries, and account settings",
  arguments: [
    {
      name: "task",
      description: "Specific task (check order status, manage delivery, review past orders, etc.)",
      required: false,
    },
  ],
  handler: async (args) => {
    const task = args?.task || "general order management"

    return userPrompt(
      "You are a customer service expert with access to Picnic's account and delivery tools. Help me keep track of my Picnic orders and deliveries efficiently.",
      `Help me with ${task} for my Picnic account. ` +
        "Look things up with picnic_get_deliveries, picnic_get_delivery, picnic_get_order_status, picnic_get_delivery_position and picnic_get_delivery_slots, the cart with picnic_get_cart, and account details with picnic_get_user_details. " +
        "Before anything that changes my account, such as picnic_set_delivery_slot, picnic_rate_delivery or picnic_send_delivery_invoice_email, tell me what you are about to do and wait for my confirmation.",
    )
  },
})

// Recipe recreation prompt
promptRegistry.register({
  name: "picnic_recipe_recreation",
  description: "Help recreate a specific recipe using ingredients available on Picnic",
  arguments: [
    {
      name: "recipe_name",
      description: "Name of the recipe to recreate",
      required: true,
    },
    {
      name: "recipe_description",
      description: "Description or details about the recipe",
      required: false,
    },
    {
      name: "servings",
      description: "Number of servings needed",
      required: false,
    },
  ],
  handler: async (args) => {
    const recipeName = args?.recipe_name || "unknown recipe"
    const recipeDescription = args?.recipe_description || "no additional details"
    const servings = args?.servings || "4"

    return userPrompt(
      "You are a culinary expert with access to Picnic's grocery delivery service. Help users recreate recipes by finding the right ingredients and providing cooking guidance.",
      `Help me recreate "${recipeName}" for ${servings} servings. Additional details: ${recipeDescription}. ` +
        "Find all necessary ingredients with picnic_search and suggest substitutions where needed. " +
        `Offer to save the recipe as an own recipe in my Picnic cookbook with picnic_create_recipe (the Picnic products as ingredients for ${servings} portions, the steps and anything Picnic does not sell in the note), so picnic_add_recipe_to_cart can add all its ingredients at once; otherwise add the products with picnic_add_to_cart. ` +
        "Provide step-by-step cooking instructions.",
    )
  },
})

// Dietary substitution prompt
promptRegistry.register({
  name: "picnic_dietary_substitutions",
  description: "Find dietary substitutions and alternatives available on Picnic",
  arguments: [
    {
      name: "original_ingredient",
      description: "The ingredient that needs to be substituted",
      required: true,
    },
    {
      name: "dietary_need",
      description: "Reason for substitution (vegan, gluten-free, low-sodium, etc.)",
      required: true,
    },
    {
      name: "recipe_context",
      description: "What the ingredient is being used for",
      required: false,
    },
  ],
  handler: async (args) => {
    const originalIngredient = args?.original_ingredient || "unknown ingredient"
    const dietaryNeed = args?.dietary_need || "dietary restriction"
    const recipeContext = args?.recipe_context || "general cooking"

    return userPrompt(
      "You are a dietary specialist with access to Picnic's grocery delivery service. Help users find suitable ingredient substitutions for their dietary needs.",
      `I need a ${dietaryNeed} substitute for ${originalIngredient} in ${recipeContext}. ` +
        "Use picnic_search to find suitable alternatives available on Picnic and check their ingredients and allergens with picnic_get_product_details (full=true). Explain how to use them and add the best option to the cart with picnic_add_to_cart. " +
        "If the ingredient is part of one of my own recipes, offer to swap it there with picnic_update_recipe_ingredient (picnic_get_own_recipe lists the ingredientIds).",
    )
  },
})

// Delivery optimization prompt
promptRegistry.register({
  name: "picnic_delivery_optimization",
  description: "Help optimize Picnic delivery scheduling and order timing",
  arguments: [
    {
      name: "schedule_preference",
      description: "Preferred delivery schedule (morning, afternoon, evening, specific days)",
      required: false,
    },
    {
      name: "household_needs",
      description: "Household consumption patterns and needs",
      required: false,
    },
  ],
  handler: async (args) => {
    const schedulePreference = args?.schedule_preference || "flexible"
    const householdNeeds = args?.household_needs || "standard household"

    return userPrompt(
      "You are a logistics expert with access to Picnic's delivery system. Help users plan their delivery schedule for maximum convenience.",
      `Help me optimize my Picnic delivery schedule. Preferences: ${schedulePreference}. Household needs: ${householdNeeds}. ` +
        "Check availability with picnic_get_delivery_slots and review my delivery history with picnic_get_deliveries. Suggest a delivery rhythm that fits, including by when the cart has to be complete for each suggested slot. " +
        "Select a slot with picnic_set_delivery_slot only after I confirm it.",
    )
  },
})
