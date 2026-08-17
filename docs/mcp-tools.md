# Silpo MCP — actual tool schemas

Retrieved 2026-08-17T13:29:42.008Z via `tools/list` — generated, do not edit by hand.
Server: silpo-mcp-service v1.108.0, protocol 2025-06-18. Tools: **39**.

---

## `silpo_find_address`

Search for address coordinates using text input. Returns latitude and longitude for use with silpo_get_available_delivery_types to find delivery options.

USE: Pass addresses[].latitude and addresses[].longitude to silpo_get_available_delivery_types.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `address` | string | **yes** | Address search text (e.g., "Київ, вулиця Хрещатик, 1") |

## `silpo_get_time_slots`

Get available delivery time slots for a Silpo branch.

USAGE: Use slots[].start and slots[].end with silpo_update_shopping_cart timeslot param. Only pick slots where available=true.

TIMES: All times in the response are UTC — always convert to user's local timezone when presenting.

BRANCH: Prefer using branchId from silpo_get_shopping_cart_by_id (existing cart). Only use silpo_get_available_delivery_types if user wants to change address.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `branchId` | string | **yes** | Branch ID from silpo_get_shopping_cart_by_id or silpo_get_available_delivery_types |
| `deliveryTypes` | array | no | Filter by delivery types |
| `limit` | integer | no | Max slots to return (default: 25) |
| `start` | string | no | Start date-time in ISO format |
| `end` | string | no | End date-time in ISO format |

## `silpo_find_products_batch`

Search for multiple products at once (semicolon-separated, max 30). Prefer getting branchId/deliveryType/timeslot from silpo_get_shopping_cart_by_id (existing cart).

SEARCH BY ARTICLE CODE: The `products` search terms accept exact numeric article codes (externalProductId) in addition to free-text names — e.g. searching "795319" returns the exact product with that externalProductId. This is the most reliable match: prefer numeric externalProductId over fuzzy name matching whenever it is already known (e.g. from a silpo_get_my_offline_orders receipt line's lagerId, a silpo_get_my_online_orders result, or a cart/favorites entry) — it eliminates ambiguity from product names.

PACKAGE SIZE: displayRatio shows the actual content of one unit (e.g. "400г", "10 шт") — use it together with step to compute how many units to add for a requested weight/volume/count. step alone only tells you the minimum increment (e.g. step=1 unit), not what one unit contains.

BUDGET: If user mentions a budget, ALWAYS fill the cart as close to the budget limit as possible. Maximize the total spend without exceeding it — add more items or increase quantities to use the full budget.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `branchId` | string | **yes** | Branch ID from silpo_get_shopping_cart_by_id or silpo_get_available_delivery_types |
| `deliveryType` | string (Unknown, SelfPickup, DeliveryHome, DeliveryFlat, DeliveryOffice, DeliveryGlovo, DeliveryExpress, DeliveryExpressFood, JustIn, LongDelivery, JustInPost, NovaPoshta, DeliveryExpressByPromise, WideAssortDelivery) | **yes** | Delivery type |
| `timeslotStart` | string | **yes** | Timeslot start |
| `timeslotEnd` | string | **yes** | Timeslot end |
| `products` | array | **yes** | Array of product names to search for (max 30) |
| `limit` | integer | no | Results per search (default: 30) |

## `silpo_get_products`

Browse products at a Silpo branch with filters. At least one filter required: category, mustHavePromotion, promotionCode, or set. Prefer getting branchId/deliveryType/timeslot from silpo_get_shopping_cart_by_id (existing cart). NOTE: promotionCode automatically enables mustHavePromotion.

PACKAGE SIZE: displayRatio shows the actual content of one unit (e.g. "400г", "10 шт") — use it together with step to compute quantities for a requested weight/volume/count.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `branchId` | string | **yes** | Branch ID from silpo_get_shopping_cart_by_id or silpo_get_available_delivery_types |
| `deliveryType` | string (Unknown, SelfPickup, DeliveryHome, DeliveryFlat, DeliveryOffice, DeliveryGlovo, DeliveryExpress, DeliveryExpressFood, JustIn, LongDelivery, JustInPost, NovaPoshta, DeliveryExpressByPromise, WideAssortDelivery) | **yes** | Delivery type |
| `timeslotStart` | string | **yes** | Timeslot start |
| `timeslotEnd` | string | **yes** | Timeslot end |
| `mustHavePromotion` | boolean | no | Only show promotional products |
| `category` | string | no | Category filter |
| `promotionCode` | string | no | Promotion code from silpo_get_promotions |
| `inStock` | boolean | no | Only show in-stock products |
| `set` | string | no | Set slug from silpo_get_product_sets to browse products in that set |
| `limit` | integer | no | Max results (default: 25) |
| `offset` | integer | no | Skip items for pagination |
| `sortBy` | string (popularity, score, title, price, promotion, productsList, slugsList, guestRating, carouselList) | no | Sort field (default: popularity) |
| `sortDirection` | string (asc, desc) | no | Sort direction |
| `fromPrice` | number | no | Min price |
| `toPrice` | number | no | Max price |

## `silpo_get_promotions`

List active promotions at a Silpo branch. Returns promotion codes for use with silpo_get_products.

All inputs must be taken from silpo_get_shopping_cart_by_id: branchId, deliveryType, timeslotStart (slot.start), timeslotEnd (slot.end).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `branchId` | string | **yes** | Branch ID from silpo_get_shopping_cart_by_id |
| `deliveryType` | string (Unknown, SelfPickup, DeliveryHome, DeliveryFlat, DeliveryOffice, DeliveryGlovo, DeliveryExpress, DeliveryExpressFood, JustIn, LongDelivery, JustInPost, NovaPoshta, DeliveryExpressByPromise, WideAssortDelivery) | **yes** | Delivery type from silpo_get_shopping_cart_by_id |
| `timeslotStart` | string | **yes** | Timeslot start ISO timestamp from silpo_get_shopping_cart_by_id slot.start |
| `timeslotEnd` | string | **yes** | Timeslot end ISO timestamp from silpo_get_shopping_cart_by_id slot.end |

## `silpo_get_popular_categories`

List popular/trending categories at a Silpo branch.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `branchId` | string | **yes** | Branch ID from silpo_get_shopping_cart_by_id or silpo_get_available_delivery_types |
| `deliveryType` | string (Unknown, SelfPickup, DeliveryHome, DeliveryFlat, DeliveryOffice, DeliveryGlovo, DeliveryExpress, DeliveryExpressFood, JustIn, LongDelivery, JustInPost, NovaPoshta, DeliveryExpressByPromise, WideAssortDelivery) | **yes** | Delivery type |

## `silpo_get_category`

Get detailed info about a specific category (name, path, price range, children).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `branchId` | string | **yes** | Branch ID from silpo_get_shopping_cart_by_id or silpo_get_available_delivery_types |
| `deliveryType` | string (Unknown, SelfPickup, DeliveryHome, DeliveryFlat, DeliveryOffice, DeliveryGlovo, DeliveryExpress, DeliveryExpressFood, JustIn, LongDelivery, JustInPost, NovaPoshta, DeliveryExpressByPromise, WideAssortDelivery) | **yes** | Delivery type |
| `categorySlug` | string | **yes** | Category slug from silpo_get_popular_categories or silpo_get_categories_tree |

## `silpo_get_categories`

List categories at a Silpo branch. Optionally filter by parent category to get subcategories.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `branchId` | string | **yes** | Branch ID from silpo_get_shopping_cart_by_id or silpo_get_available_delivery_types |
| `parentId` | string | no | Parent category ID to get subcategories |
| `limit` | integer | no | Max categories (default: 1000) |
| `offset` | integer | no | Skip for pagination |

## `silpo_get_categories_tree`

Get the full category hierarchy for a Silpo branch and time slot.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `branchId` | string | **yes** | Branch ID from silpo_get_shopping_cart_by_id |
| `deliveryType` | string (Unknown, SelfPickup, DeliveryHome, DeliveryFlat, DeliveryOffice, DeliveryGlovo, DeliveryExpress, DeliveryExpressFood, JustIn, LongDelivery, JustInPost, NovaPoshta, DeliveryExpressByPromise, WideAssortDelivery) | **yes** | Delivery type from silpo_get_shopping_cart_by_id |
| `timeslotStart` | string | **yes** | Timeslot start from silpo_get_shopping_cart_by_id |
| `timeslotEnd` | string | **yes** | Timeslot end from silpo_get_shopping_cart_by_id |

## `silpo_get_my_shopping_cart`

Get the authenticated user's shopping cart ID. START HERE — use this first, then silpo_get_shopping_cart_by_id to get branchId, deliveryType, and timeslot for product searches.

_No parameters._

## `silpo_get_shopping_cart_by_id`

View detailed shopping cart contents including products, delivery settings, totals, and errors/warnings.

RESPONSE FIELDS GUIDE:
- cart.shipments[0].branchId — use as branchId for product searches
- cart.deliveryType — use as deliveryType for product searches
- cart.timeslot.start / cart.timeslot.end — use as timeslotStart/timeslotEnd for product searches
- cart.shipments[].products[].productId + companyId — use for add_or_update_cart_products
- cart.calculation.validations[] — errors/warnings that block checkout
- cart.calculation.total — full order total before discounts
- cart.calculation.totalAfterDiscounts — the actual amount the user will PAY (always show this to the user, not total)
- BUDGET CHECK: If the user stated a budget for this cart, compare it against cart.calculation.totalAfterDiscounts. If it exceeds the budget, you MUST go back to silpo_add_or_update_cart_products / silpo_remove_cart_products to reduce the cart, then call this tool again to re-verify — do NOT report the cart as complete while over budget.
- cart.calculation.certificatesTotal — total discount applied from gift certificates
- cart.calculation.delivery.totalWeight — total weight

EXPRESS DELIVERY:
- If cart.deliveryType = "DeliveryExpressByPromise": order will be delivered in ~cart.calculation.delivery.deliveryExpressByPromise.promiseTime seconds (convert to minutes for user). Use "DeliveryHome" as deliveryType for all other tools (product searches, time slots, etc.).
- If cart.deliveryType != "DeliveryExpressByPromise": check cart.calculation.delivery.deliveryExpressByPromise. If isAvailable=true AND isTemporarilyUnavailable=false — HIGHLIGHT to user: "Express delivery available! Delivery in ~{promiseTime/60} minutes for ₴{price}". If user wants express, update cart deliveryType to "DeliveryExpressByPromise" via silpo_update_shopping_cart.

TIMESLOT VALIDATION (MANDATORY — DO THIS IMMEDIATELY):
You MUST call silpo_get_time_slots IMMEDIATELY after this tool (branchId=cart.shipments[0].branchId, deliveryTypes=[cart.deliveryType], start=now, limit=10). Then check if cart.timeslot (start + end) exists in the returned slots where available=true. If not found or not available — ask user to pick a new timeslot and update via silpo_update_shopping_cart. Do NOT proceed with any other operations until timeslot is confirmed valid.

VALIDATION HANDLING:
- ERRORS in cart.calculation.validations[] MUST be highlighted to the user — they block checkout
- WARNINGS MUST be communicated clearly
- Timeslot times are UTC — always convert to user's local timezone

PLASTIC BAGS: ALWAYS ignore plastic bags (пакет, пакет з пакетів, пакет-майка) when reordering products from this cart — never add them.

CHECKOUT LINK: If checkoutWebLink/checkoutMobileLink are present in the response, ALWAYS show BOTH links to the user — checkoutWebLink labeled "Оформити на сайті" and checkoutMobileLink labeled "Оформити в застосунку".

БАЛАБОНУСИ (BONUS PAY):
Check cart.calculation.loyalty after this tool:
- If bonusRequested is null AND bonusAvailable > 0 AND bonusTotal >= bonusAvailable AND isEnabled is true — ALWAYS propose to user: "У вас є {bonusAvailable} балабонусів. Бажаєте їх застосувати для оплати замовлення?"
- If user agrees — call silpo_update_shopping_cart with bonusRequested = bonusAvailable (or user-specified amount ≤ bonusAvailable)
- If user declines — proceed without bonuses
- bonusTotal — total balance the user has; bonusAvailable — amount applicable to this cart

| Parameter | Type | Required | Description |
|---|---|---|---|
| `shoppingCartId` | string | **yes** | Cart ID from silpo_get_my_shopping_cart |

## `silpo_add_or_update_cart_products`

Add products to shopping cart or update quantities. Requires productId, companyId, and branchId from product search results.

VERIFICATION (MANDATORY — DO THIS IMMEDIATELY):
You MUST call silpo_get_shopping_cart_by_id IMMEDIATELY after this tool, using the same shoppingCartId. Do NOT tell the user the cart is ready until you have done this — it covers budget checks and error/warning reporting.

STOCK LIMIT: NEVER add quantity exceeding the product's stock value. Before calling this tool, always check the stock field and inform the user of the maximum available quantity. If user requests more than stock — warn them and cap at stock value.

PLASTIC BAGS: ALWAYS ignore plastic bags (пакет, пакет з пакетів, пакет-майка) — never add them to cart. Skip them silently without asking the user.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `shoppingCartId` | string | **yes** | Cart ID from silpo_get_my_shopping_cart |
| `products` | array | **yes** | Products to add/update |

## `silpo_remove_cart_products`

Remove products from shopping cart. IMPORTANT: After this action, ALWAYS call silpo_get_shopping_cart_by_id to verify the cart and report any errors/warnings to the user. Product IDs from silpo_get_shopping_cart_by_id.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `shoppingCartId` | string | **yes** | Cart ID from silpo_get_my_shopping_cart |
| `products` | array | **yes** | Products to remove |

## `silpo_clear_shopping_cart`

Remove all products from the shopping cart.

VERIFICATION (MANDATORY — DO THIS IMMEDIATELY):
You MUST call silpo_get_shopping_cart_by_id IMMEDIATELY after this tool, using the same shoppingCartId. Confirm cart.shipments[].products is empty before telling the user the cart was cleared. Do NOT respond to the user until verification is complete. If products are still present, treat this as a failure and inform the user the clear did not fully succeed — do not report success.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `shoppingCartId` | string | **yes** | Cart ID from silpo_get_my_shopping_cart |

## `silpo_update_shopping_cart`

Update cart delivery settings. IMPORTANT: After this action, ALWAYS call silpo_get_shopping_cart_by_id to verify the cart and report any errors/warnings to the user.

For DeliveryExpressByPromise deliveryType: Use this to switch to express delivery. Copy address, shipments, timeslot from the current cart response as-is. Only change deliveryType to "DeliveryExpressByPromise". The branchId in shipments will be automatically resolved from deliveryExpressByPromise.branchId.

For NovaPoshta deliveryType: 1) Get settlement via silpo_find_nova_poshta_settlements 2) Get office via silpo_find_nova_poshta_offices 3) Get branchId via silpo_list_branches(hasNP=true). Build address as: { "addressType": "nova-poshta", "city": settlement.title, "region": settlement.area, "latitude": String(office.latitude), "longitude": String(office.longitude), "officeId": office.id, "street": "<type> #<number>" } where type is "Відділення" for office or "Поштомат" for parcelLocker. Set shipments with the NP branch companyId + branchId.

For SelfPickup deliveryType: address MUST use data from silpo_list_branches (hasPickup=true). Build address as: { "addressType": "self-pickup", "city": branch.cityFull, "locality": branch.addressFull, "street": branch.addressFull, "latitude": branch.latitude, "longitude": branch.longitude }. Set shipments with the branch companyId + branchId.

For other delivery types: the address object MUST be passed exactly as received from silpo_get_shopping_cart_by_id (requires addressType, latitude, longitude as strings). Do NOT construct the address manually — always copy it from the cart response. The shipments array must also come from the cart response.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `shoppingCartId` | string | **yes** | Cart ID from silpo_get_my_shopping_cart |
| `deliveryType` | string | **yes** | Delivery type |
| `timeslot` | object | **yes** | Delivery timeslot |
| `address` | object | **yes** | Full address object from silpo_get_shopping_cart_by_id response (must include addressType, latitude, longitude) |
| `shipments` | array | **yes** | Shipments array from silpo_get_shopping_cart_by_id response (do NOT construct manually) |
| `branchId` | string | no | New branch ID (optional) |
| `feedbackChanges` | string (approvedChanges, disapprovedChanges) | no | Product change preference |
| `feedbackContacts` | string (call, doNotCall) | no | Contact preference |
| `isAdultConfirmed` | boolean | no | Confirm adult products |
| `promoCode` | string\|null | no | Promo code to apply |
| `bonusRequested` | number\|null | no | Балабонуси to apply: set to bonusAvailable (or less if user specifies an exact amount) from silpo_get_shopping_cart_by_id to pay with bonuses, or null to remove bonus payment |

## `silpo_get_my_online_orders`

View online delivery order history with product details. Only shows orders placed via silpo.ua or Silpo mobile apps (not in-store purchases). Product IDs can be used to reorder via silpo_add_or_update_cart_products.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `limit` | integer | no | Max orders (default: 10) |
| `offset` | integer | no | Skip for pagination |

## `silpo_get_product_details`

Get detailed information about a specific product by branch and slug. Returns product attributes, nutrition info, and image URLs.

CRITICAL: The slug parameter MUST come from the slug field in silpo_find_products_batch or silpo_get_products results. NEVER construct or guess a slug from a product name — slugs are generated by Silpo and cannot be derived from names. If you don't have a slug from a previous search, call silpo_find_products_batch first.

PACKAGE SIZE: displayRatio shows the actual content of one unit (e.g. "400г", "10 шт") — use it together with step to compute how many units to add for a requested weight/volume/count. step alone only tells you the minimum increment, not what one unit contains.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `branchId` | string | **yes** | Branch ID from silpo_get_shopping_cart_by_id |
| `slug` | string | **yes** | Product slug — MUST be taken from slug field in silpo_find_products_batch or silpo_get_products results. Never construct from name. |
| `deliveryType` | string | **yes** | Delivery type from silpo_get_shopping_cart_by_id |
| `timeslotStart` | string | **yes** | Timeslot start from silpo_get_shopping_cart_by_id |
| `timeslotEnd` | string | **yes** | Timeslot end from silpo_get_shopping_cart_by_id |

## `silpo_get_similar_products`

Find products similar to a given product. Use to suggest alternatives.

PACKAGE SIZE: displayRatio shows the actual content of one unit (e.g. "400г", "10 шт") — use it together with step to compute quantities for a requested weight/volume/count.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `branchId` | string | **yes** | Branch ID from silpo_get_shopping_cart_by_id |
| `slug` | string | **yes** | Product slug |
| `limit` | number | no | Max results |
| `offset` | number | no | Offset for pagination |
| `deliveryType` | string | no | Delivery type from silpo_get_shopping_cart_by_id |

## `silpo_get_replacements`

Find replacement products when an item is out of stock.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `branchId` | string | **yes** | Branch ID from silpo_get_shopping_cart_by_id |
| `companyId` | string | **yes** | Company ID |
| `productIds` | array | **yes** | Product IDs to find replacements for |
| `deliveryType` | string | **yes** | Delivery type from silpo_get_shopping_cart_by_id |

## `silpo_get_my_coupons`

List available coupons for the authenticated user.

_No parameters._

## `silpo_get_loyalty_info`

Get loyalty card info and balance for the authenticated user.

_No parameters._

## `silpo_get_coupon_details`

Get detailed info about a specific coupon by its ID (from silpo_get_my_coupons).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `businessCouponId` | number | **yes** | Coupon ID from silpo_get_my_coupons |

## `silpo_get_my_delivery_addresses`

Get saved delivery addresses for the authenticated user. Use coordinates from an address with silpo_get_available_delivery_types to set up delivery.

_No parameters._

## `silpo_get_my_food_restrictions`

Get user food restrictions (gluten-free, lactose-free, vegan, etc.). Use to personalize product recommendations.

_No parameters._

## `silpo_get_my_profile`

Get the authenticated user profile info (name, phone, email, birthday).

_No parameters._

## `silpo_get_my_promos`

Get personal promotional offers available for selection. User can choose which promos to activate for bonus rewards.

_No parameters._

## `silpo_get_promo_codes`

Get promo codes for the authenticated user.

_No parameters._

## `silpo_list_branches`

List available Silpo branches with pagination. Use with hasPickup=true when user wants SelfPickup delivery — show 5 nearest branches to their location and let them choose. Branch data (branchId, companyId, latitude, longitude, address, city) is needed to construct the SelfPickup address for silpo_update_shopping_cart.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `limit` | integer | no | Max results to return (default: 50) |
| `offset` | integer | no | Offset for pagination |
| `hasPickup` | boolean | no | Filter branches that support self-pickup |
| `hasNP` | boolean | no | Filter branches that support Nova Poshta delivery |

## `silpo_get_product_sets`

Get curated product collections/sets at a Silpo branch. Use slug with silpo_get_products (set param) to browse products in a set.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `branchId` | string | **yes** | Branch ID from silpo_get_shopping_cart_by_id or silpo_get_available_delivery_types |
| `deliveryType` | string | no | Filter by delivery type |

## `silpo_get_my_family`

Get family info: household members, children, and pets. Helps personalize product recommendations.

_No parameters._

## `silpo_get_available_delivery_types`

Get all available delivery types for a location. Returns which delivery types are available at given coordinates with branchId for polygon-based options.

USE: Pass deliveryType + branchId to silpo_update_shopping_cart or silpo_get_time_slots.

NEXT STEPS BY TYPE:
- DeliveryHome/WideAssortDelivery/B2B: branchId is provided, use directly
- SelfPickup: branchId is null → call silpo_list_branches(hasPickup=true) to let user pick a branch
- NovaPoshta: branchId is null → call silpo_find_nova_poshta_settlements → silpo_find_nova_poshta_offices → silpo_list_branches(hasNP=true) for branchId

| Parameter | Type | Required | Description |
|---|---|---|---|
| `latitude` | number | **yes** | Latitude coordinate |
| `longitude` | number | **yes** | Longitude coordinate |

## `silpo_find_nova_poshta_settlements`

Search for cities available for Nova Poshta delivery. Returns settlement IDs needed for silpo_find_nova_poshta_offices.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `title` | string | **yes** | City name to search for (e.g. "Київ", "Одеса") |

## `silpo_find_nova_poshta_offices`

Search for Nova Poshta offices/parcel lockers in a settlement.

USE: After silpo_find_nova_poshta_settlements. Pass offices[].id, offices[].latitude, offices[].longitude, offices[].type, offices[].number to construct NovaPoshta address for silpo_update_shopping_cart.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `settlementId` | string | **yes** | Settlement ID from silpo_find_nova_poshta_settlements |
| `title` | string | no | Filter by office number or address text |

## `silpo_get_my_offline_orders`

View in-store (offline) purchase history from physical Silpo shops.

Unlike silpo_get_my_online_orders (website/app orders), this shows purchases made at physical store checkouts using the loyalty card.

REQUIRES: branchId, deliveryType, timeslotStart, timeslotEnd from silpo_get_shopping_cart_by_id to check product availability.

RESPONSE: Products with catalogProduct !== null can be reordered via silpo_add_or_update_cart_products. Products with catalogProduct === null — use silpo_find_products_batch with product name to find replacements.

REORDER BY ARTICLE: products[].lagerId is the same identifier as externalProductId returned by silpo_find_products_batch and other catalog tools. To reliably reorder an item from this receipt (instead of fuzzy-matching by name), search for its lagerId as a numeric query in silpo_find_products_batch — this is more precise than searching by product name.

HIGHLIGHT FOR USER:
- accruedBalaBonusesSum — Балабонуси earned for this order. Show this to the user as a benefit of shopping at Silpo.
- rewards[] — promotions/coupons that were applied to this order and saved money. Highlight these to show how the user benefited.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `branchId` | string | **yes** | Branch ID from silpo_get_shopping_cart_by_id |
| `deliveryType` | string | **yes** | Delivery type from silpo_get_shopping_cart_by_id |
| `timeslotStart` | string | **yes** | Timeslot start from silpo_get_shopping_cart_by_id |
| `timeslotEnd` | string | **yes** | Timeslot end from silpo_get_shopping_cart_by_id |
| `limit` | integer | no | Max orders to return (default: 10, max: 10) |
| `offset` | integer | no | Skip for pagination (default: 0) |
| `dateStart` | string | no | Period start in ISO format (default: 6 months ago) |
| `dateEnd` | string | no | Period end in ISO format (default: now) |

## `silpo_get_my_certificates`

Get user gift certificates that can be applied to the shopping cart. Shows barcode, pincode, expiry date and value.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `limit` | integer | no | Max certificates to return (default: 50) |
| `offset` | integer | no | Pagination offset (default: 0) |

## `silpo_get_my_premium_subscription`

Get premium subscription (Плюхс) details including features, balances, and benefits. Shows active subscription status, available bonuses, and feature cards with links.

If subscription is NOT active: ALWAYS show BOTH links to the user — webLink labeled "Оформити на сайті" and mobileLink labeled "Оформити в застосунку".

If subscription IS active: ALWAYS show BOTH share links — shareWebLink labeled "Поділитись (сайт)" and shareMobileLink labeled "Поділитись (застосунок)".

_No parameters._

## `silpo_get_my_favorites`

Get the user's favorite products at a Silpo branch. Returns products in the same format as silpo_get_products — use companyId, branchId, id, and step to add items to cart via silpo_add_or_update_cart_products.

PACKAGE SIZE: displayRatio shows the actual content of one unit (e.g. "400г", "10 шт") — use it together with step to compute quantities for a requested weight/volume/count.

All inputs must be taken from silpo_get_shopping_cart_by_id: branchId, deliveryType, timeslotStart (slot.start).

| Parameter | Type | Required | Description |
|---|---|---|---|
| `branchId` | string | **yes** | Branch ID from silpo_get_shopping_cart_by_id |
| `deliveryType` | string (Unknown, SelfPickup, DeliveryHome, DeliveryFlat, DeliveryOffice, DeliveryGlovo, DeliveryExpress, DeliveryExpressFood, JustIn, LongDelivery, JustInPost, NovaPoshta, DeliveryExpressByPromise, WideAssortDelivery) | **yes** | Delivery type from silpo_get_shopping_cart_by_id |
| `timeslotStart` | string | **yes** | Timeslot start ISO timestamp from silpo_get_shopping_cart_by_id slot.start |
| `limit` | integer | no | Max results (default: 25) |
| `offset` | integer | no | Pagination offset (default: 0) |

## `silpo_add_or_update_favorite_products`

Add or remove products from the user's favorites list.

Use productId and externalProductId from any product-returning tool (silpo_get_my_favorites, silpo_find_products_batch, silpo_get_products, silpo_get_similar_products, etc).

To ADD: set toDelete=false.
To REMOVE: set toDelete=true. Get productId and externalProductId from silpo_get_my_favorites.

Max 5 actions per call.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `actions` | array | **yes** | List of add/remove actions (max 5) |

## `silpo_add_or_update_certificates`

Add or remove gift certificates from the shopping cart in one call. Adds run before removes.

certificatesToAdd: get barcode and pincode from silpo_get_my_certificates or from user input. Max 10.
certificatesToRemove: get barcode from the certificates array in silpo_get_shopping_cart_by_id response. Max 10.

MANDATORY: After calling this tool, ALWAYS call silpo_get_shopping_cart_by_id to verify the result and check if cart total changed.

VALIDATION ERRORS: If added[].validations is non-empty, show the messages to the user — the certificate was not applied.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `shoppingCartId` | string | **yes** | Cart ID from silpo_get_my_shopping_cart |
| `certificatesToAdd` | array | no | Certificates to add (barcode + optional pincode) |
| `certificatesToRemove` | array | no | Certificates to remove (barcode from silpo_get_shopping_cart_by_id certificates) |
