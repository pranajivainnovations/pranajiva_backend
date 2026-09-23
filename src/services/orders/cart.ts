import { getOrdersDbPool } from "./db"
import { evaluatePrice, persistEvaluation } from "../pricing/pricing-engine"
import { getCartCredit } from "../wallet/cart-credit"

/**
 * The cart.
 *
 * ── The one rule that matters ──────────────────────────────────────────────────────────────────
 * A caller says WHAT they want, never what it costs. `addItem` takes a kind, a reference and a
 * spec; the price is resolved here, server-side, from the pricing engine or from the catalogue.
 * There is no parameter anywhere in this file that a browser could use to choose its own price —
 * the same reasoning that keeps the wallet's redemption cap on the server.
 *
 * ── Why a design is an item and not a product ──────────────────────────────────────────────────
 * Because it never needed to be one. A draft Medusa product with a variant, a shipping profile, a
 * sales channel and an `inventory_quantity` of zero existed for exactly one reason: `addItem` took a
 * variantId, so a cake had to become a catalogue entry before it could be bought. Here `kind` says
 * what a line is and `ref_id` says which one, so a design goes in as itself.
 *
 * ── Money ──────────────────────────────────────────────────────────────────────────────────────
 * Integers of paise throughout. The pricing engine returns RUPEES — `500.00` — so the conversion
 * happens once, in resolvePrice, and never again. Catalogue prices are already paise in
 * money_amount, so they are not converted at all. Getting this wrong in either direction is a 100x
 * price bug, which is why there is exactly one place it can happen.
 */

export type ItemKind = "catalogue" | "studio_design"
export type Brand = "crossfriend" | "pranajiva"

export interface CartItem {
  id: string
  kind: ItemKind
  refId: string
  title: string
  qty: number
  unitPricePaise: number
  linePaise: number
  spec: Record<string, unknown>
}

export interface Cart {
  id: string
  customerId: string | null
  brand: Brand
  pincode: string | null
  status: string
  items: CartItem[]
  subtotalPaise: number
  /** Always 0. Delivery is free; the field exists so the shape does not change when it is not. */
  deliveryPaise: number
  creditAppliedPaise: number
  payablePaise: number
}

type Client = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }>
}

const MAX_QTY = 99

/* ── reading ──────────────────────────────────────────────────────────────────────────────────── */

/**
 * The cart as the customer should see it.
 *
 * Totals are summed from the frozen `unit_price_paise` on each line, never recomputed from the
 * pricing engine. A rule changed this morning must not silently restate what somebody was quoted
 * last night — and if a price genuinely needs to move, that is a deliberate re-add, not a surprise
 * at the bottom of a page they were already reading.
 */
export async function getCart(cartId: string, client?: Client): Promise<Cart | null> {
  const db = client ?? getOrdersDbPool()

  const { rows: carts } = await db.query(
    `SELECT id, customer_id, brand, pincode, status FROM orders.carts WHERE id = $1`,
    [cartId]
  )
  if (!carts.length) return null

  const { rows: items } = await db.query(
    `SELECT id, kind, ref_id, qty, unit_price_paise, spec
       FROM orders.cart_items WHERE cart_id = $1 ORDER BY created_at`,
    [cartId]
  )

  return shape(carts[0], items, await creditOn(cartId, client))
}

/**
 * What the wallet says is already on this cart.
 *
 * Read from the ledger rather than held as a column here, because the ledger is where redemption
 * actually happens and a second copy would be a second thing that can be wrong. Never fatal: a cart
 * that cannot read its credit still shows the right price to pay, just without the discount — which
 * is recoverable, whereas showing a discount that was never redeemed is not.
 */
async function creditOn(cartId: string, client?: Client): Promise<number> {
  try {
    const credit = await getCartCredit(cartId, client as any)
    return credit?.amountPaise ?? 0
  } catch {
    return 0
  }
}

function shape(cart: any, items: any[], creditAppliedPaise: number): Cart {
  const shaped: CartItem[] = items.map((r) => ({
    id: r.id,
    kind: r.kind,
    refId: r.ref_id,
    title: String(r.spec?.title ?? titleFor(r.kind, r.spec)),
    qty: r.qty,
    unitPricePaise: r.unit_price_paise,
    linePaise: r.qty * r.unit_price_paise,
    spec: r.spec ?? {},
  }))

  const subtotalPaise = shaped.reduce((sum, i) => sum + i.linePaise, 0)
  const deliveryPaise = 0

  return {
    id: cart.id,
    customerId: cart.customer_id,
    brand: cart.brand,
    pincode: cart.pincode,
    status: cart.status,
    items: shaped,
    subtotalPaise,
    deliveryPaise,
    creditAppliedPaise,
    /* Floored at zero: credit can never make an order owe the customer money. The same rule is a
       CHECK constraint on orders.orders, so this is the screen agreeing with the database. */
    payablePaise: Math.max(0, subtotalPaise + deliveryPaise - creditAppliedPaise),
  }
}

function titleFor(kind: ItemKind, spec: any): string {
  if (kind === "studio_design") {
    const parts = [spec?.weight, spec?.flavor].filter(Boolean)
    return parts.length ? `Custom cake — ${parts.join(", ")}` : "Custom cake"
  }
  return "Item"
}

/* ── pricing, which the caller never supplies ─────────────────────────────────────────────────── */

async function resolvePrice(input: {
  kind: ItemKind
  refId: string
  spec: Record<string, unknown>
  pincode: string | null
  customerId: string | null
}): Promise<{ unitPricePaise: number; title: string; priceEvaluationId: string | null }> {
  if (input.kind === "catalogue") {
    const db = getOrdersDbPool()
    const { rows } = await db.query(
      `SELECT v.title AS variant_title, p.title AS product_title, ma.amount
         FROM product_variant v
         JOIN product p ON p.id = v.product_id
         JOIN product_variant_money_amount pv ON pv.variant_id = v.id
         JOIN money_amount ma ON ma.id = pv.money_amount_id
        WHERE v.id = $1 AND v.deleted_at IS NULL AND ma.price_list_id IS NULL
        ORDER BY ma.region_id NULLS LAST
        LIMIT 1`,
      [input.refId]
    )
    if (!rows.length) {
      throw new CartError("not_purchasable", "That item is no longer available.")
    }
    /* Already paise in money_amount — deliberately not multiplied. */
    return {
      unitPricePaise: Number(rows[0].amount),
      title: [rows[0].product_title, rows[0].variant_title].filter(Boolean).join(" — "),
      priceEvaluationId: null,
    }
  }

  /* A studio design: the pricing engine owns the number, from the spec the customer configured. */
  const spec = input.spec as {
    weight?: string
    selections?: Record<string, string | boolean | undefined>
  }
  if (!spec?.weight) {
    throw new CartError("incomplete_spec", "That cake is missing its size. Please choose one.")
  }

  const result = await evaluatePrice({
    categoryKey: "cake",
    pincode: input.pincode ?? undefined,
    weight: spec.weight,
    selections: spec.selections ?? {},
  })

  /* The receipt: which rule set, which region, what it added up to. Kept so "why was I charged
     this" stays answerable after the rules have moved on. */
  const priceEvaluationId = await persistEvaluation({
    result,
    pincode: input.pincode ?? undefined,
    selections: spec.selections ?? {},
    customerId: input.customerId ?? undefined,
  }).catch(() => null)

  return {
    /* RUPEES to paise — the one conversion in this file. */
    unitPricePaise: Math.round(result.total * 100),
    title: titleFor("studio_design", spec),
    priceEvaluationId,
  }
}

export class CartError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = "CartError"
  }
}

/* ── writing ──────────────────────────────────────────────────────────────────────────────────── */

/**
 * Every write runs inside a transaction holding an advisory lock on the cart.
 *
 * Not ceremony: add-to-cart is a button people press twice when nothing visible happens, and the
 * merge in claimCart reads one cart to write another. Without the lock, two presses can produce two
 * lines for one intent, and a sign-in racing an add can lose an item.
 */
async function withCart<T>(cartId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const pool = getOrdersDbPool()
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`cart:${cartId}`])
    const out = await fn(client as unknown as Client)
    await client.query("COMMIT")
    return out
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/**
 * The cart this request should use.
 *
 * A signed-in customer has one active cart per brand, found by customer. A visitor who has not
 * signed in has whichever cart their cookie names. Nobody is asked to sign in to hold a cake —
 * that requirement belongs at the order, and asking earlier is how a cart gets abandoned.
 */
export async function getOrCreateCart(input: {
  customerId?: string | null
  cartId?: string | null
  brand: Brand
  pincode?: string | null
}): Promise<Cart> {
  const db = getOrdersDbPool()

  if (input.customerId) {
    const { rows } = await db.query(
      `SELECT id FROM orders.carts
        WHERE customer_id = $1 AND brand = $2 AND status = 'active' LIMIT 1`,
      [input.customerId, input.brand]
    )
    if (rows.length) {
      if (input.pincode) await setPincode(rows[0].id, input.pincode)
      return (await getCart(rows[0].id))!
    }
  }

  if (input.cartId) {
    const existing = await getCart(input.cartId)
    if (existing && existing.status === "active") {
      if (input.pincode) await setPincode(existing.id, input.pincode)
      return (await getCart(existing.id))!
    }
  }

  const { rows } = await db.query(
    `INSERT INTO orders.carts (customer_id, brand, pincode) VALUES ($1, $2, $3) RETURNING id`,
    [input.customerId ?? null, input.brand, input.pincode ?? null]
  )
  return (await getCart(rows[0].id))!
}

async function setPincode(cartId: string, pincode: string): Promise<void> {
  await getOrdersDbPool().query(
    `UPDATE orders.carts SET pincode = $2, updated_at = now()
      WHERE id = $1 AND (pincode IS DISTINCT FROM $2)`,
    [cartId, pincode]
  )
}

export async function addItem(input: {
  cartId: string
  kind: ItemKind
  refId: string
  qty?: number
  spec?: Record<string, unknown>
}): Promise<Cart> {
  const qty = clampQty(input.qty ?? 1)
  const spec = input.spec ?? {}

  return withCart(input.cartId, async (c) => {
    const { rows: carts } = await c.query(
      `SELECT id, customer_id, pincode, status FROM orders.carts WHERE id = $1`,
      [input.cartId]
    )
    if (!carts.length) throw new CartError("no_cart", "Your cart has expired. Please start again.")
    if (carts[0].status !== "active") {
      throw new CartError("cart_closed", "That cart has already been ordered.")
    }

    const priced = await resolvePrice({
      kind: input.kind,
      refId: input.refId,
      spec,
      pincode: carts[0].pincode,
      customerId: carts[0].customer_id,
    })

    /**
     * The same thing twice is one line with a higher quantity.
     *
     * Matched on kind and reference rather than on the spec, because two lines for the same design
     * are a cart the customer has to reason about rather than read. A design configured differently
     * is a different ref_id by the time it gets here.
     */
    const { rows: same } = await c.query(
      `SELECT id, qty FROM orders.cart_items
        WHERE cart_id = $1 AND kind = $2 AND ref_id = $3 LIMIT 1`,
      [input.cartId, input.kind, input.refId]
    )

    if (same.length) {
      await c.query(
        `UPDATE orders.cart_items SET qty = $2, unit_price_paise = $3 WHERE id = $1`,
        [same[0].id, clampQty(same[0].qty + qty), priced.unitPricePaise]
      )
    } else {
      await c.query(
        `INSERT INTO orders.cart_items
           (cart_id, kind, ref_id, qty, unit_price_paise, spec, price_evaluation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          input.cartId,
          input.kind,
          input.refId,
          qty,
          priced.unitPricePaise,
          JSON.stringify({ ...spec, title: priced.title }),
          priced.priceEvaluationId,
        ]
      )
    }

    await touch(c, input.cartId)
    return (await getCart(input.cartId, c))!
  })
}

export async function setItemQty(input: {
  cartId: string
  itemId: string
  qty: number
}): Promise<Cart> {
  return withCart(input.cartId, async (c) => {
    if (input.qty <= 0) {
      await c.query(`DELETE FROM orders.cart_items WHERE id = $1 AND cart_id = $2`,
        [input.itemId, input.cartId])
    } else {
      await c.query(`UPDATE orders.cart_items SET qty = $3 WHERE id = $1 AND cart_id = $2`,
        [input.itemId, input.cartId, clampQty(input.qty)])
    }
    await touch(c, input.cartId)
    return (await getCart(input.cartId, c))!
  })
}

export async function removeItem(input: { cartId: string; itemId: string }): Promise<Cart> {
  return setItemQty({ ...input, qty: 0 })
}

/**
 * A guest cart becomes a signed-in one.
 *
 * This is the case the OTP-at-checkout decision creates, and the one that will bite in production if
 * it is not handled here: somebody fills a cart signed out, signs in to order, and already has an
 * active cart from another device. Two active carts would break the unique index, and picking one
 * silently would throw away items somebody chose.
 *
 * So they merge. The customer's existing cart survives — its id is the stable one — and the guest
 * cart's lines move into it before it is closed. The surviving cart is returned, because the caller
 * has to update the cookie and guessing would leave the browser pointed at an abandoned cart.
 */
export async function claimCart(input: { cartId: string; customerId: string }): Promise<Cart> {
  return withCart(input.cartId, async (c) => {
    const { rows: carts } = await c.query(
      `SELECT id, customer_id, brand, status FROM orders.carts WHERE id = $1`,
      [input.cartId]
    )
    if (!carts.length) throw new CartError("no_cart", "Your cart has expired. Please start again.")
    const cart = carts[0]

    if (cart.customer_id === input.customerId) return (await getCart(cart.id, c))!
    if (cart.customer_id) {
      /* Somebody else's cart. Refused rather than reassigned — a cart id in the wrong cookie must
         not become a way to read what another customer chose. */
      throw new CartError("not_your_cart", "Please start a new cart.")
    }

    const { rows: mine } = await c.query(
      `SELECT id FROM orders.carts
        WHERE customer_id = $1 AND brand = $2 AND status = 'active' AND id <> $3 LIMIT 1`,
      [input.customerId, cart.brand, cart.id]
    )

    if (!mine.length) {
      await c.query(
        `UPDATE orders.carts SET customer_id = $2, updated_at = now() WHERE id = $1`,
        [cart.id, input.customerId]
      )
      return (await getCart(cart.id, c))!
    }

    const target = mine[0].id

    /* Lines that exist in both become one line with the quantities added. */
    await c.query(
      `UPDATE orders.cart_items t
          SET qty = LEAST($3, t.qty + g.qty)
         FROM orders.cart_items g
        WHERE g.cart_id = $1 AND t.cart_id = $2
          AND g.kind = t.kind AND g.ref_id = t.ref_id`,
      [cart.id, target, MAX_QTY]
    )
    await c.query(
      `DELETE FROM orders.cart_items g
        WHERE g.cart_id = $1
          AND EXISTS (SELECT 1 FROM orders.cart_items t
                       WHERE t.cart_id = $2 AND t.kind = g.kind AND t.ref_id = g.ref_id)`,
      [cart.id, target]
    )
    await c.query(`UPDATE orders.cart_items SET cart_id = $2 WHERE cart_id = $1`, [cart.id, target])
    await c.query(
      `UPDATE orders.carts SET status = 'abandoned', updated_at = now() WHERE id = $1`, [cart.id])

    await touch(c, target)
    return (await getCart(target, c))!
  })
}

function clampQty(qty: number): number {
  const n = Math.floor(Number(qty) || 0)
  return Math.max(1, Math.min(MAX_QTY, n))
}

async function touch(c: Client, cartId: string): Promise<void> {
  await c.query(`UPDATE orders.carts SET updated_at = now() WHERE id = $1`, [cartId])
}
