import type { MedusaContainer } from "@medusajs/medusa"

export interface ShippingResolution {
  shippingOptionId: string
  shippingMethodName: string
  shippingCost: number
}

/**
 * Picks the shipping option for a cart — the customer never sees or chooses this, CrossFriend's
 * business rules do. Today there's exactly one active option per region, so this just returns it.
 * Tomorrow (express/standard/same-day), this is the one place that logic lives — the checkout
 * route and its response contract don't change.
 */
export async function resolveShipping(
  container: MedusaContainer,
  regionId: string
): Promise<ShippingResolution> {
  const shippingOptionService = container.resolve("shippingOptionService")
  const options = await shippingOptionService.list({ region_id: regionId, is_return: false })

  if (!options.length) {
    throw new Error(`No shipping option configured for region ${regionId}`)
  }

  const chosen = options[0]
  return {
    shippingOptionId: chosen.id,
    shippingMethodName: chosen.name,
    shippingCost: chosen.amount / 100,
  }
}
