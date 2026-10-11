# Picnic API MCP Tools

This MCP server provides tools to interact with the Picnic online supermarket API. The tools are based on the unofficial [picnic-api](https://github.com/MRVDH/picnic-api) Node.js package.

## Available Tools

### Authentication

**Note:** Authentication is handled automatically using environment variables (`PICNIC_USERNAME` and `PICNIC_PASSWORD`). No manual login is required.

#### `picnic_generate_2fa_code`

Generate a 2FA code for verification.

**Parameters:**

- `channel` (string, optional): Channel to send 2FA code (default: "SMS")

#### `picnic_verify_2fa_code`

Verify a 2FA code.

**Parameters:**

- `code` (string): The 2FA code to verify

### Product Search & Information

#### `picnic_search`

Search for products in Picnic.

**Parameters:**

- `query` (string): Search query for products
- `limit` (number, optional): Maximum number of results to return (1-20, default: 5)
- `offset` (number, optional): Number of results to skip for pagination (default: 0)

#### `picnic_get_promotions`

Get Picnic's current weekly promotions/deals from the app's "Alle acties" page.

**Parameters:**

- `limit` (number, optional): Maximum number of promotions to return (1-100, default: 25)
- `offset` (number, optional): Number of promotions to skip for pagination (default: 0)

**Returns:** Promoted products with product ID, promotion ID, name, current price, unit, promotion label, original price when shown, image ID, and pagination metadata.

#### `picnic_get_suggestions`

Get product suggestions based on a query.

**Parameters:**

- `query` (string): Query for product suggestions

#### `picnic_get_product_details`

Look up product details by selling unit ID.

**Parameters:**

- `productId` (string): The product selling unit ID returned by search or cart
- `full` (boolean, optional): Return full product details, including description, allergens, nutritional info, promotions, and similar products

#### `picnic_get_image`

Get product image data.

**Parameters:**

- `imageId` (string): The image ID returned by search, cart, or product details
- `size` (string): Image size (`tiny`, `small`, `medium`, `large`, or `extra-large`)

### Removed Legacy Product Tools

#### ~~`picnic_get_article`~~ (REMOVED)

**This tool has been removed** because the Picnic API deprecated product detail endpoints. See [GitHub issue #23](https://github.com/MRVDH/picnic-api/issues/23).

**Alternative:** Use `picnic_get_product_details` for product details or `picnic_search` for basic product information (id, name, price, unit).

#### ~~`picnic_get_categories`~~ (REMOVED)

**This tool is not available** because `picnic-api` v4 removed the underlying `getCategories()` function. Category browsing would require a new Fusion page implementation.

### Shopping Cart Management

#### `picnic_get_cart`

Get the current shopping cart contents.

#### `picnic_add_to_cart`

Add a product to the shopping cart.

**Parameters:**

- `productId` (string): The ID of the product to add
- `count` (number, optional): Number of items to add (default: 1)

#### `picnic_remove_from_cart`

Remove a product from the shopping cart.

**Parameters:**

- `productId` (string): The ID of the product to remove
- `count` (number, optional): Number of items to remove (default: 1)

#### `picnic_clear_cart`

Clear all items from the shopping cart.

### Delivery Management

#### `picnic_get_delivery_slots`

Get available delivery time slots.

#### `picnic_set_delivery_slot`

Select a delivery time slot.

**Parameters:**

- `slotId` (string): The ID of the delivery slot to select

#### `picnic_get_deliveries`

Get past and current deliveries.

**Parameters:**

- `filter` (array of strings, optional): Filter deliveries by status

#### `picnic_get_delivery`

Get details of a specific delivery.

**Parameters:**

- `deliveryId` (string): The ID of the delivery to get details for

#### `picnic_get_delivery_position`

Get real-time position data for a delivery.

**Parameters:**

- `deliveryId` (string): The ID of the delivery to get position for

#### `picnic_get_delivery_scenario`

Get driver and route information for a delivery.

**Parameters:**

- `deliveryId` (string): The ID of the delivery to get scenario for

#### `picnic_cancel_delivery`

Cancel a delivery order. A cancelled delivery cannot be restored, so this tool is only available when `PICNIC_ENABLE_CANCEL_DELIVERY=true` is set.

**Parameters:**

- `deliveryId` (string): The ID of the delivery to cancel

#### `picnic_rate_delivery`

Rate a completed delivery.

**Parameters:**

- `deliveryId` (string): The ID of the delivery to rate
- `rating` (number): Rating from 0 to 10

#### `picnic_send_delivery_invoice_email`

Send or resend the invoice email for a completed delivery. Not idempotent: every call sends another email.

**Parameters:**

- `deliveryId` (string): The ID of the delivery to send the invoice email for

#### `picnic_get_order_status`

Get the status of an order (not a delivery). Picnic answers with a `checkout_status`, for example `FINISHED`. Order IDs are the `orders[].id` values in the results of `picnic_get_deliveries` and `picnic_get_delivery`.

**Parameters:**

- `orderId` (string): The ID of the order to get the status for

### User Information

#### `picnic_get_user_details`

Get details of the current logged-in user.

#### `picnic_get_user_info`

Get user information including toggled features.

### Payment & Transactions

#### `picnic_get_payment_profile`

Get payment information and profile.

#### `picnic_get_wallet_transactions`

Get wallet transaction history.

**Parameters:**

- `pageNumber` (number, optional): Page number for transaction history (default: 1)

#### `picnic_get_wallet_transaction_details`

Get detailed information about a specific wallet transaction.

**Parameters:**

- `transactionId` (string): The ID of the transaction to get details for

### Recipes & Meal Planning

#### `picnic_browse_recipes`

Browse Picnic cookbook recipes. Without a `category`, this returns cookbook highlights plus available recipe category page IDs when Picnic exposes them. With a `category`, this fetches that category page.

**Parameters:**

- `category` (string, optional): Bare category ID (for example `"20minuten"`) or full page ID (for example `"recipe-cattree-jamie-oliver"`)
- `limit` (number, optional): Maximum number of recipes to return (1-100, default: 25)
- `offset` (number, optional): Number of recipes to skip for pagination (default: 0)

#### `picnic_get_recipe`

Fetch a Picnic recipe by URL or recipe ID.

**Parameters:**

- `recipe_url_or_id` (string): A Picnic recipe URL or 24-/32-character recipe ID
- `portions` (number, optional): Render the recipe for this many portions (defaults to the recipe's own count)

#### `picnic_get_saved_recipes`

List recipes saved in the user's Picnic cookbook.

**Parameters:**

- `limit` (number, optional): Maximum number of recipes to return (1-100, default: 25)
- `offset` (number, optional): Number of recipes to skip for pagination (default: 0)

#### `picnic_get_own_recipes`

List user-created Picnic recipes.

**Parameters:**

- `limit` (number, optional): Maximum number of recipes to return (1-100, default: 25)
- `offset` (number, optional): Number of recipes to skip for pagination (default: 0)

#### `picnic_save_recipe`

Save a recipe to the user's Picnic cookbook.

**Parameters:**

- `recipe_url_or_id` (string): A Picnic recipe URL or 24-/32-character recipe ID

#### `picnic_unsave_recipe`

Remove a recipe from the user's Picnic cookbook.

**Parameters:**

- `recipe_url_or_id` (string): A Picnic recipe URL or 24-/32-character recipe ID

#### `picnic_add_recipe_to_cart`

Add a recipe's ingredients to the shopping cart by assigning the recipe selling group to the basket.

**Parameters:**

- `recipe_url_or_id` (string): A Picnic recipe URL or 24-/32-character recipe ID
- `portions` (number, optional): Number of portions to add

#### `picnic_remove_recipe_from_cart`

Remove a recipe's ingredients from the shopping cart.

**Parameters:**

- `recipe_url_or_id` (string): A Picnic recipe URL or 24-/32-character recipe ID

#### `picnic_get_recipe_ingredients`

Fetch structured recipe ingredients for meal planning.

**Parameters:**

- `recipe_url_or_id` (string): A Picnic recipe URL or 24-/32-character recipe ID
- `portions` (number, optional): Return ingredients for this many portions (defaults to the recipe's own count)

#### `picnic_get_multiple_recipe_ingredients`

Fetch structured ingredients for multiple recipes.

**Parameters:**

- `recipe_urls_or_ids` (array of strings): Picnic recipe URLs or 24-/32-character recipe IDs, up to 20

#### `picnic_build_shopping_list`

Consolidate structured recipe ingredients into a shopping list.

#### `picnic_find_meal_combinations`

Rank recipe combinations by shared non-pantry ingredients and optional budget.

### Own Recipes

The user's own recipes ("Eigen recepten" in the app) consist of Picnic products with a pack quantity for the recipe's portions, plus a free-text note for preparation steps and anything Picnic does not sell. List them with `picnic_get_own_recipes`; their IDs are 32 characters long and work with every recipe tool, including `picnic_add_recipe_to_cart`.

Picnic renders an own recipe only at multiples of its default portion count (for example 4, 8 or 12 for a 4-portion recipe), so a `portions` value outside those fails. Reads straight after an edit can briefly fail to render; the tools retry those automatically.

#### `picnic_get_own_recipe`

Get an own recipe with its portions, note (as plain text) and ingredients (`ingredientId`, `productId`, name, pack quantity). Also works for catalog recipes.

**Parameters:**

- `recipe_url_or_id` (string): A Picnic recipe URL or recipe ID
- `portions` (number, optional): Return quantities for this many portions (defaults to the recipe's own count)
- `resolve_names` (boolean, optional): Look up product names missing from the recipe page (default: true)

#### `picnic_create_recipe`

Create a new own recipe. Not idempotent: every call creates another recipe.

**Parameters:**

- `name` (string): Recipe name, max 43 characters (the app's limit)
- `ingredients` (array): Products as `{ "product_id": "s1001524", "quantity": 1 }`; repeated products are merged
- `portions` (number, optional): Number of portions the quantities are for (default: 4)
- `note` (string, optional): Free-text note, max 5000 characters; each line becomes a paragraph

#### `picnic_rename_recipe`

Rename an own recipe.

**Parameters:**

- `recipe_url_or_id` (string): The own recipe's URL or ID
- `name` (string): New name, max 43 characters

#### `picnic_update_recipe_portions`

Change the default number of portions of an own recipe.

**Parameters:**

- `recipe_url_or_id` (string): The own recipe's URL or ID
- `portions` (number): New default number of portions

#### `picnic_delete_recipe`

Permanently delete an own recipe. Does not touch the cart; remove the recipe from the cart first with `picnic_remove_recipe_from_cart` if needed.

**Parameters:**

- `recipe_url_or_id` (string): The own recipe's URL or ID

#### `picnic_add_recipe_ingredient`

Add a product as a new ingredient to an own recipe. Not idempotent.

**Parameters:**

- `recipe_url_or_id` (string): The own recipe's URL or ID
- `product_id` (string): Product (selling unit) ID from `picnic_search`
- `quantity` (number, optional): Number of packs (default: 1)
- `portions` (number, optional): Portion count the quantity is for (defaults to the recipe's own count)

#### `picnic_update_recipe_ingredient`

Change an ingredient's pack quantity, or swap it for another product. If the recipe is in the cart, the cart is updated to match.

**Parameters:**

- `recipe_url_or_id` (string): The own recipe's URL or ID
- `ingredient_id` (string): The `ingredientId` from `picnic_get_own_recipe`
- `quantity` (number): Number of packs
- `product_id` (string, optional): Swap to this product (omit to keep the current one)
- `portions` (number, optional): Portion count the quantity is for (defaults to the recipe's own count)

#### `picnic_remove_recipe_ingredient`

Remove an ingredient from an own recipe.

**Parameters:**

- `recipe_url_or_id` (string): The own recipe's URL or ID
- `ingredient_id` (string): The `ingredientId` from `picnic_get_own_recipe`

#### `picnic_set_recipe_note`

Set or replace the note of an own recipe.

**Parameters:**

- `recipe_url_or_id` (string): The own recipe's URL or ID
- `note` (string): Plain text, max 5000 characters; each line becomes a paragraph

#### `picnic_delete_recipe_note`

Delete the note of an own recipe.

**Parameters:**

- `recipe_url_or_id` (string): The own recipe's URL or ID

#### `picnic_get_recipe_image_suggestions`

List the images Picnic suggests for an own recipe.

**Parameters:**

- `recipe_url_or_id` (string): The own recipe's URL or ID

#### `picnic_set_recipe_image`

Set the image of an own recipe. Pass exactly one of `suggested_image_id`, `image_url` or `image_base64`.

**Parameters:**

- `recipe_url_or_id` (string): The own recipe's URL or ID
- `suggested_image_id` (string, optional): An `imageId` from `picnic_get_recipe_image_suggestions`
- `image_url` (string, optional): An http(s) URL of a photo to download and upload (max 10 MB)
- `image_base64` (string, optional): A photo as base64 or a data URL (max 10 MB)
- `mime_type` (string, optional): MIME type of `image_base64` (default: `image/jpeg`)

### Raw App Pages

#### `picnic_get_page`

Fetch a raw Picnic app page as JSON text, for data no other tool covers. Handles both formats Picnic serves pages in (Fusion and React Server Components). Known pages include `category-tree-root` (product categories), `profile-root`, `promo-group-deep-dive?promo_group_id=<id>`, `L2-category-page-root?category_id=<id>` and `delivery-receipt-page?delivery_id=<id>`.

**Parameters:**

- `page_id` (string): Page ID, optionally with query params
- `offset` (number, optional): Character offset to read the next chunk of a large page (default: 0)
- `max_chars` (number, optional): Maximum number of characters to return (1000-100000, default: 20000)

### Other Removed Legacy Tools

The legacy `picnic_get_lists`, `picnic_get_list`, and `picnic_get_mgm_details` tools are not available because `picnic-api` v4 removed their backing APIs.

## Usage Example

**Note**: Authentication is handled automatically using environment variables. No manual login is required.

1. Search for products:

```json
{
  "tool": "picnic_search",
  "arguments": {
    "query": "milk"
  }
}
```

2. Add a product to cart:

```json
{
  "tool": "picnic_add_to_cart",
  "arguments": {
    "productId": "12345",
    "count": 2
  }
}
```

3. Get available delivery slots:

```json
{
  "tool": "picnic_get_delivery_slots",
  "arguments": {}
}
```

## Important Notes

- **Authentication**: Authentication is handled automatically using environment variables (`PICNIC_USERNAME` and `PICNIC_PASSWORD`)
- **Country Support**: Supports the Netherlands (NL), Germany (DE) and France (FR)
- **Rate Limiting**: Be mindful of API rate limits when making frequent requests
- **Security**: Credentials are read from environment variables and used to authenticate automatically when tools are called
- **No ordering**: Placing orders is deliberately not supported. The tools can fill the cart and pick a delivery slot, but checking out and paying always happen in the Picnic app
- **Unofficial API**: This uses an unofficial API wrapper, so functionality may change if Picnic updates their API

## Error Handling

All tools include proper error handling and will throw descriptive errors if:

- Authentication is required but not provided
- Invalid parameters are passed
- API requests fail
- Network issues occur

## Dependencies

This implementation uses the [picnic-api](https://www.npmjs.com/package/picnic-api) npm package by MRVDH.
