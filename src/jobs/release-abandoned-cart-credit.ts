import type { ScheduledJobArgs, ScheduledJobConfig } from "@medusajs/medusa"

import { releaseStaleCartCredit } from "../services/wallet/cart-credit"

/**
 * Gives back credit that is sitting on carts nobody finished.
 *
 * ── Why this job is the price of debiting early ────────────────────────────────────────────────
 * Credit is taken out of the wallet the moment a customer applies it at checkout, because the amount
 * they are charged drops at that moment and the two have to agree. Most carts then become orders. The
 * ones that do not would hold the credit for ever, and the customer would see a balance that is
 * missing money for a cake they never bought — so this is not an optimisation, it is the other half
 * of that decision.
 *
 * ── Why it runs often ──────────────────────────────────────────────────────────────────────────
 * Unlike expiry and referral payouts, which settle calendar dates, this one is holding a customer's
 * own money out of reach. Hourly means the worst case is an hour of a balance reading low, rather
 * than most of a day.
 *
 * ── Why it can decline to give credit back ─────────────────────────────────────────────────────
 * The gift card minted against a cart carries a code the customer can read. If they copied it, spent
 * it on a second order and abandoned the first cart, returning the credit would hand them the same
 * money twice. So each cart is checked: the credit comes back only if its gift card is untouched and
 * has been disabled. Anything else is left alone and logged loudly, because it is either fraud or a
 * bug and a job should not quietly resolve either.
 */
export default async function releaseAbandonedCartCredit({
  container,
}: ScheduledJobArgs): Promise<void> {
  const logger = container.resolve("logger")

  try {
    const manager = container.resolve("manager") as any
    const giftCardService = container.resolve("giftCardService") as any

    /**
     * Is this cart's credit genuinely still unspent?
     *
     * Reads the gift card the wallet minted for the cart and insists it is whole — value untouched.
     * A partly spent card is deliberately not handled by returning the remainder: the ledger reverses
     * a redemption entirely or not at all, and a partial reversal would restore the full amount while
     * recording less, which is a broken book rather than a careful one.
     *
     * Disabling it before returning the credit is what closes the window: after this the code is dead,
     * so it cannot be spent between the check and the reversal.
     */
    const canRelease = async (cartId: string): Promise<boolean> => {
      const cards = await manager.query(
        `SELECT id, value, balance, is_disabled
           FROM public.gift_card
          WHERE metadata->>'source' = 'wallet_credit'
            AND metadata->>'cart_id' = $1`,
        [cartId]
      )

      /* No card at all means the debit never became a discount — the apply failed partway. That
         credit is owed back, and this is the path that returns it. */
      if (!cards.length) return true

      for (const card of cards) {
        if (Number(card.balance) !== Number(card.value)) return false
      }

      for (const card of cards) {
        if (!card.is_disabled) {
          await giftCardService.update(card.id, { is_disabled: true })
        }
      }

      return true
    }

    const result = await releaseStaleCartCredit({ canRelease })

    if (result.carts > 0) {
      logger.info(
        `[wallet] returned ₹${(result.releasedPaise / 100).toFixed(2)} of credit from ` +
          `${result.carts} abandoned cart(s)`
      )
    }

    if (result.withheld > 0) {
      logger.warn(
        `[wallet] ${result.withheld} abandoned cart(s) kept their credit debited because the gift ` +
          `card had already been used — these need a person to look at them`
      )
    }
  } catch (error) {
    /* Caught, never rethrown: an unhandled error in a scheduled job can take the worker down, and a
       dead worker means every later job is missed too. */
    logger.error(
      `[wallet] abandoned cart sweep failed: ${error instanceof Error ? error.message : error}`
    )
  }
}

export const config: ScheduledJobConfig = {
  name: "release-abandoned-cart-credit",
  schedule: "15 * * * *",
  data: {},
}
