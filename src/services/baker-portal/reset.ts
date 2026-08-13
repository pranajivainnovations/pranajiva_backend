import type { MedusaRequest } from "@medusajs/medusa"

import { getBakerNetworkDbPool } from "../baker-network/db"
import { getCrossFriendChannelId } from "./publication"

/**
 * Undoing a baker's onboarding — the missing half of issuing an invite.
 *
 * `issueActivation` refuses a bakery that has already claimed its account, and that refusal is
 * correct: re-inviting a live bakery would either strand the existing owner or create a second one.
 * But it left no way back. A bakery onboarded for testing, claimed by the wrong person, or set up
 * with a token that has since been shared around could not be returned to an invitable state by any
 * code path at all. This is that path.
 *
 * Two operations, kept separate because they carry very different risk and are wanted at different
 * times. Resetting access is routine and reversible in effect — the bakery simply gets a new invite.
 * Deleting the catalogue is neither.
 */

export interface ResetAccessResult {
  bakerName: string
  /** Owner and staff accounts deactivated — the bakery becomes invitable again. */
  usersDeactivated: number
  /** Unused invites killed, so a link already in an inbox stops working. */
  activationsRevoked: number
}

/**
 * Returns a bakery to the state it was in before anyone claimed it.
 *
 * ── Why accounts are deactivated, not deleted ───────────────────────────────────────────────────
 * `idx_baker_users_one_active_owner` is a partial unique index over (baker_id) WHERE role='owner'
 * AND is_active — so clearing `is_active` frees the owner slot for a fresh activation just as
 * effectively as a DELETE would, while keeping the record that an account existed, when it was
 * created and when it last logged in. Deleting would also cascade `used_by` to NULL on the old
 * activation rows and erase the audit trail of who claimed what. An inactive user cannot sign in:
 * `requireBakerUser` re-reads is_active from the database on every single request, so the reset
 * takes effect immediately rather than whenever their seven-day session token happens to expire.
 *
 * Products are deliberately untouched. Whoever runs this usually wants to re-invite a bakery, not
 * destroy its catalogue, and those are separate decisions — see resetBakerData.
 */
export async function resetBakerAccess(
  bakerId: string,
  opsUserId: string | null
): Promise<ResetAccessResult> {
  const db = getBakerNetworkDbPool()
  const client = await db.connect()

  try {
    await client.query("BEGIN")

    const bakerResult = await client.query(
      `SELECT id, name FROM baker_network.bakers WHERE id = $1 FOR UPDATE`,
      [bakerId]
    )
    const baker = bakerResult.rows[0]
    if (!baker) throw new Error("Baker not found")

    const users = await client.query(
      `UPDATE baker_network.baker_users
          SET is_active = false, updated_at = NOW()
        WHERE baker_id = $1 AND is_active
        RETURNING id`,
      [bakerId]
    )

    // Live invites too: a reset whose purpose is to stop an old link working must also stop the
    // unused one sitting next to it.
    const activations = await client.query(
      `UPDATE baker_network.baker_activations
          SET revoked_at = NOW()
        WHERE baker_id = $1 AND used_at IS NULL AND revoked_at IS NULL
        RETURNING id`,
      [bakerId]
    )

    // baker_stage_history is the existing record of what ops did to a bakery and why, so a reset
    // belongs in it rather than in a log nobody reads. from_stage = to_stage because this is not a
    // pipeline move — the bakery stays exactly where it was in the funnel.
    await client.query(
      `INSERT INTO baker_network.baker_stage_history (baker_id, from_stage, to_stage, reason, changed_by)
       SELECT id, status, status, $2, $3 FROM baker_network.bakers WHERE id = $1`,
      [
        bakerId,
        `Portal access reset — ${users.rowCount} account(s) deactivated, ${activations.rowCount} unused invite(s) revoked`,
        opsUserId,
      ]
    )

    await client.query("COMMIT")

    return {
      bakerName: baker.name,
      usersDeactivated: users.rowCount ?? 0,
      activationsRevoked: activations.rowCount ?? 0,
    }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export interface ResetDataResult {
  bakerName: string
  productsDeleted: number
}

const ORDERED_PRODUCTS_REFUSAL =
  "REFUSED:This bakery has products that customers have ordered. Deleting them would erase those items from the order history, so this is blocked. Archive the products instead."

/**
 * Whether this bakery's catalogue may be deleted at all.
 *
 * Exists to be callable BEFORE anything is written. A reset of both access and data runs access
 * first, so discovering the order block only once resetBakerData opened its transaction would leave
 * the accounts already deactivated while the caller is shown nothing but an error — a half-applied
 * reset that reads as a failed one. Checking up front makes "refused" mean nothing happened.
 *
 * resetBakerData re-checks inside its own transaction regardless; this is the courtesy, that is the
 * guarantee.
 */
export async function assertBakerDataDeletable(bakerId: string): Promise<void> {
  const db = getBakerNetworkDbPool()
  const { rows } = await db.query(
    `SELECT COUNT(*)::INT AS n
       FROM baker_network.baker_products bp
       JOIN public.product_variant v ON v.product_id = bp.medusa_product_id
       JOIN public.line_item li ON li.variant_id = v.id
      WHERE bp.baker_id = $1`,
    [bakerId]
  )
  if ((rows[0]?.n ?? 0) > 0) {
    throw new Error(ORDERED_PRODUCTS_REFUSAL)
  }
}

/**
 * Permanently deletes every product a bakery owns.
 *
 * For clearing out test data. Irreversible, and there is no soft-delete hiding behind it — the
 * Medusa products are gone.
 *
 * ── Orders are an absolute block ────────────────────────────────────────────────────────────────
 * Refuses outright, for the whole bakery, if ANY of its products has ever appeared in an order. A
 * line item points at a variant which points at the product; deleting it erases what was actually
 * bought from every order that contained it, leaving a customer's history unanswerable. Partially
 * deleting — skipping the ordered ones — would be worse than refusing, because it would look like it
 * worked. A bakery with orders is by definition not test data, so the right answer is to stop and
 * let a human reconsider.
 *
 * Goes through Medusa's productService rather than a DELETE, so its hooks, events and search
 * indexing fire exactly as they would for any other deletion.
 */
export async function resetBakerData(
  req: MedusaRequest,
  bakerId: string,
  opsUserId: string | null
): Promise<ResetDataResult> {
  const manager = req.scope.resolve("manager")
  const productService = req.scope.resolve("productService")

  let result: ResetDataResult | null = null

  await manager.transaction(async (tm: any) => {
    const bakerRows = await tm.query(
      `SELECT id, name, status FROM baker_network.bakers WHERE id = $1 FOR UPDATE`,
      [bakerId]
    )
    const baker = bakerRows[0]
    if (!baker) throw new Error("Baker not found")

    const products = await tm.query(
      `SELECT medusa_product_id FROM baker_network.baker_products WHERE baker_id = $1 FOR UPDATE`,
      [bakerId]
    )
    const productIds: string[] = products.map((p: any) => p.medusa_product_id)

    if (productIds.length) {
      const ordered = await tm.query(
        `SELECT COUNT(*)::INT AS n
           FROM public.line_item li
           JOIN public.product_variant v ON v.id = li.variant_id
          WHERE v.product_id = ANY($1::text[])`,
        [productIds]
      )
      if ((ordered[0]?.n ?? 0) > 0) {
        throw new Error(ORDERED_PRODUCTS_REFUSAL)
      }

      const channelId = await getCrossFriendChannelId(tm)
      for (const productId of productIds) {
        await tm.query(
          `DELETE FROM public.product_sales_channel WHERE product_id = $1 AND sales_channel_id = $2`,
          [productId, channelId]
        )
        await productService.withTransaction(tm).delete(productId)
      }

      // ON DELETE CASCADE does not reach this — baker_products has no foreign key to public.product,
      // by design, so Medusa owns its own migration lifecycle. The rows have to go explicitly.
      await tm.query(`DELETE FROM baker_network.baker_products WHERE baker_id = $1`, [bakerId])
    }

    await tm.query(
      `INSERT INTO baker_network.baker_stage_history (baker_id, from_stage, to_stage, reason, changed_by)
       VALUES ($1, $2, $2, $3, $4)`,
      [bakerId, baker.status, `Catalogue reset — ${productIds.length} product(s) deleted`, opsUserId]
    )

    result = { bakerName: baker.name, productsDeleted: productIds.length }
  })

  return result!
}
