# Picnic MCP Server Prompts

This document describes the useful prompts available in the Picnic MCP Server. These prompts are designed to help users accomplish common grocery shopping tasks using Picnic's online supermarket delivery service.

## Available Prompts

### 1. `picnic_meal_planner`

**Description**: Create a meal plan and generate a shopping list for Picnic

**Use Case**: Perfect for users who want to plan their meals for the week and automatically generate a shopping list with all necessary ingredients.

**Arguments**:

- `days` (optional): Number of days to plan meals for (default: 7)
- `people` (optional): Number of people to cook for (default: 2)
- `dietary_restrictions` (optional): Any dietary restrictions or preferences (default: none)

**What it does**: Picks Picnic recipes (including your saved and own recipes) that share ingredients, consolidates the shopping list and adds the recipes to the cart. Meals that are not Picnic recipes are added product by product, or saved as own recipes first.

---

### 2. `picnic_budget_shopping`

**Description**: Help create a budget-conscious shopping list with Picnic

**Use Case**: Ideal for users who want to maximize their grocery budget while maintaining nutritional quality.

**Arguments**:

- `budget` (required): Weekly grocery budget in euros
- `household_size` (optional): Number of people in the household (default: 2)

**What it does**: Starts from this week's promotions, finds budget-friendly staples and ranks recipe combinations by cost while tracking the total and staying within the specified budget.

---

### 3. `picnic_quick_dinner`

**Description**: Find ingredients for quick and easy dinner solutions available on Picnic

**Use Case**: Perfect for busy people who need fast dinner solutions that can be prepared quickly.

**Arguments**:

- `time_limit` (optional): Maximum cooking time in minutes (default: 30)
- `dietary_preferences` (optional): Any dietary preferences or restrictions (default: none)

**What it does**: Suggests quick Picnic recipes and ready-made solutions and adds the best option to the cart.

---

### 4. `picnic_healthy_eating`

**Description**: Create a healthy eating plan with products available on Picnic

**Use Case**: Great for users who want to transition to healthier eating habits or achieve specific health goals.

**Arguments**:

- `health_goal` (optional): Specific health goal like weight loss, muscle gain, heart health (default: general wellness)
- `food_allergies` (optional): Any food allergies or intolerances (default: none)

**What it does**: Finds healthy alternatives and nutritious products, checks their allergens and nutritional values, and focuses on whole foods and balanced nutrition.

---

### 5. `picnic_special_occasion`

**Description**: Plan shopping for special occasions and gatherings using Picnic

**Use Case**: Perfect for planning parties, holiday meals, dinner parties, or any special event.

**Arguments**:

- `occasion` (required): Type of occasion (birthday party, dinner party, holiday meal, BBQ, etc.)
- `guest_count` (optional): Number of guests expected (default: 6-8)

**What it does**: Plans a complete menu and finds all necessary ingredients for appetizers, main courses, sides, and desserts.

---

### 6. `picnic_pantry_restock`

**Description**: Help restock pantry essentials and household items through Picnic

**Use Case**: Ideal for maintaining a well-stocked kitchen with all the essentials for efficient cooking.

**Arguments**:

- `household_type` (optional): Type of household like single person, couple, family with kids (default: small household)
- `cooking_frequency` (optional): How often you cook at home (default: regularly)

**What it does**: Finds essential pantry staples, household necessities, and versatile ingredients based on your cooking habits and what your recent deliveries contained.

---

### 7. `picnic_order_management`

**Description**: Help manage Picnic orders, deliveries, and account settings

**Use Case**: Useful for managing your Picnic account, checking order status, and optimizing your delivery experience.

**Arguments**:

- `task` (optional): Specific task like check order status, manage delivery, review past orders (default: general order management)

**What it does**: Uses the Picnic delivery and account tools to help with order tracking, delivery scheduling, and account information, and asks before changing anything.

---

### 8. `picnic_recipe_recreation`

**Description**: Help recreate a specific recipe using ingredients available on Picnic

**Use Case**: Perfect when you want to make a specific dish and need to find all the ingredients on Picnic.

**Arguments**:

- `recipe_name` (required): Name of the recipe to recreate
- `recipe_description` (optional): Description or details about the recipe
- `servings` (optional): Number of servings needed (default: 4)

**What it does**: Finds all necessary ingredients for the recipe, suggests substitutions if needed, offers to save it as an own recipe in your Picnic cookbook, and provides cooking instructions.

---

### 9. `picnic_dietary_substitutions`

**Description**: Find dietary substitutions and alternatives available on Picnic

**Use Case**: Essential for people with dietary restrictions who need to find suitable alternatives for specific ingredients.

**Arguments**:

- `original_ingredient` (required): The ingredient that needs to be substituted
- `dietary_need` (required): Reason for substitution (vegan, gluten-free, low-sodium, etc.)
- `recipe_context` (optional): What the ingredient is being used for (default: general cooking)

**What it does**: Finds suitable alternatives available on Picnic, explains how to use them in recipes, and can swap the ingredient in one of your own recipes.

---

### 10. `picnic_delivery_optimization`

**Description**: Help optimize Picnic delivery scheduling and order timing

**Use Case**: Great for users who want to optimize their delivery schedule for maximum convenience and efficiency.

**Arguments**:

- `schedule_preference` (optional): Preferred delivery schedule like morning, afternoon, evening (default: flexible)
- `household_needs` (optional): Household consumption patterns and needs (default: standard household)

**What it does**: Analyzes delivery slots, reviews delivery history, and suggests a delivery rhythm, including by when the cart has to be complete for each slot.

---

## How to Use These Prompts

These prompts are designed to work with the Picnic MCP Server's tools. When you use a prompt, it will:

1. **Set up the right context**: Each prompt opens with instructions that tell the AI how to behave as an expert in that specific area. MCP prompts have no system role, so these instructions are part of the user message
2. **Use Picnic tools automatically**: The prompts guide the AI to use the appropriate Picnic API tools like `picnic_browse_recipes`, `picnic_get_multiple_recipe_ingredients`, `picnic_add_recipe_to_cart`, `picnic_search`, `picnic_add_to_cart`, etc.
3. **Provide practical guidance**: Beyond just finding products, the prompts help with meal planning, cooking instructions, budget management, and more
4. **Stop at the cart**: No prompt places an order. Placing orders is deliberately not supported, so checking out and paying always happen in the Picnic app

## Integration with Picnic Tools

These prompts leverage the full range of Picnic API tools available in the MCP server:

- **Product Search**: `picnic_search`, `picnic_get_product_details`, `picnic_get_promotions`
- **Recipes & Meal Planning**: `picnic_browse_recipes`, `picnic_get_recipe`, `picnic_get_saved_recipes`, `picnic_get_own_recipes`, `picnic_get_multiple_recipe_ingredients`, `picnic_find_meal_combinations`, `picnic_build_shopping_list`, `picnic_add_recipe_to_cart`
- **Own Recipes**: `picnic_create_recipe`, `picnic_get_own_recipe`, `picnic_update_recipe_ingredient`
- **Cart Management**: `picnic_add_to_cart`, `picnic_get_cart`
- **Delivery Management**: `picnic_get_delivery_slots`, `picnic_set_delivery_slot`, `picnic_get_deliveries`, `picnic_get_delivery`
- **Account Management**: `picnic_get_user_details`
- **Order Tracking**: `picnic_get_order_status`, `picnic_get_delivery_position`, `picnic_rate_delivery`, `picnic_send_delivery_invoice_email`

## Benefits for Users

1. **Time-saving**: Automates the process of meal planning and shopping list creation
2. **Budget-conscious**: Helps find the best value products while staying within budget
3. **Health-focused**: Makes it easier to maintain healthy eating habits
4. **Dietary-friendly**: Accommodates various dietary restrictions and preferences
5. **Convenience-oriented**: Optimizes delivery scheduling and order management
6. **Expert guidance**: Provides professional advice for cooking, nutrition, and meal planning

These prompts transform the Picnic MCP Server from a simple API interface into an intelligent grocery shopping assistant that can help with complex meal planning, budget management, and dietary needs.
