import { getBakerNetworkDbPool } from "../baker-network/db"

/**
 * Orders, from a baker's side.
 *
 * ── How an order finds its baker ────────────────────────────────────────────────────────────────
 * Two different routes, and both have to be read — neither alone is enough:
 *
 *   AI Studio cake    line_item.metadata->>'bakerId'   chosen by the customer, or filled in later
 *                                                      by ops from the assignment queue
 *   Ready to Order    baker_products.baker_id          implicit, via the line item's product
 *   Add-on            neither                          nobody bakes a candle
 *
 * The explicit metadata wins where present. That matters for an AI Studio cake: the product is a
 * bespoke draft that may not be in baker_products at all, and even when it is, the customer's choice
 * of who bakes it is the more specific fact.
 *
 * ── Two pipelines, one portal ──────────────────────────────────────────────────────────────────
 * Ordering moved to orders.orders, where a baker is named directly on the line — ops assigns it, so
 * there is nothing to derive. Medusa orders still exist and still have real deliveries in them, so
 * both are read and merged. A baker sees one list and never learns which table their work came from.
 *
 * On ours the question "whose item is this" has a column instead of a COALESCE over metadata and
 * product ownership, because the thing that made that necessary — a bespoke draft product nobody
 * owned — does not exist any more.
 *
 * ── Derived on read, persisted on change ────────────────────────────────────────────────────────
 * Nothing writes a baker_orders row at checkout. Membership is computed from line items every time,
 * so an order reaches the right baker the moment it is placed — no event subscriber to miss it, no
 * backfill for orders placed before this existed, and no way for the two to drift. The row appears
 * only when a status actually moves; until then 'new' is not stored anywhere because it is simply
 * what "no row yet" means.
 */

export type BakerOrderStatus =
  | "new"
  | "accepted"
  | "baking"
  | "ready"
  | "delivered"
  | "rejected"

/**
 * Which moves a baker may make.
 *
 * `accepted` can go straight to `ready` — a baker who already had it made should not have to click
 * through a state that never happened. `delivered` and `rejected` are terminal: undoing either is a
 * conversation with a customer, so it goes through ops rather than a button that is easy to hit.
 */
const ALLOWED: Record<BakerOrderStatus, BakerOrderStatus[]> = {
  new: ["accepted", "rejected"],
  accepted: ["baking", "ready"],
  baking: ["ready"],
  ready: ["delivered"],
  delivered: [],
  rejected: [],
}

export function canMove(from: BakerOrderStatus, to: BakerOrderStatus): boolean {
  return ALLOWED[from]?.includes(to) ?? false
}

/** Copy a baker reads, never "invalid state transition". */
export function refusalMessage(from: BakerOrderStatus): string {
  if (from === "delivered") return "This order is already delivered."
  if (from === "rejected") return "You've already declined this order. Contact CrossFriend to reopen it."
  return "That change isn't possible from here — refresh and try again."
}

export interface BakerOrderItem {
  lineItemId: string
  title: string
  thumbnail: string | null
  quantity: number
  /** Rupees. The portal should never have to know about paise. */
  unitPrice: number
  /** False for add-ons — shown to ops, hidden from the baker. */
  isBakerItem: boolean
  /**
   * What the customer chose: weight, flavour, the message on the cake, the day it is needed.
   *
   * Only orders from the current pipeline carry one — a Medusa line item kept the same information
   * in metadata under different names, and backfilling that for orders already delivered would be
   * work nobody reads. Absent rather than empty, so the portal can tell "no spec" from "a spec with
   * nothing in it".
   */
  spec?: Record<string, unknown>
}

export interface BakerOrderSummary {
  orderId: string
  displayId: number
  status: BakerOrderStatus
  placedAt: string
  customerName: string | null
  /** Where it goes. A baker needs this to plan the day; ops needs it to chase. */
  city: string | null
  postalCode: string | null
  itemCount: number
  /** Total of THIS baker's items only, not the order total — add-ons are not their money. */
  bakerTotal: number
  items: BakerOrderItem[]
}

/**
 * The join that answers "whose item is this", used by every query here.
 *
 * NULLIF guards the metadata path: an empty-string bakerId is not a baker, and would otherwise cast
 * to a UUID and fail the whole statement rather than falling through to the product-ownership path.
 */
const BAKER_OF_LINE_ITEM = `
  COALESCE(
    NULLIF(li.metadata->>'bakerId', '')::uuid,
    bp.baker_id
  )
`

const LINE_ITEM_JOINS = `
  LEFT JOIN public.product_variant pv ON pv.id = li.variant_id
  LEFT JOIN baker_network.baker_products bp ON bp.medusa_product_id = pv.product_id
`

/**
 * Orders from the current pipeline that this baker has work in.
 *
 * ── Why this is its own query rather than a UNION ──────────────────────────────────────────────
 * The two pipelines answer "whose item is this" in genuinely different ways — a COALESCE over line
 * item metadata and product ownership there, a column here — and forcing both into one statement
 * would mean a join list that is half-irrelevant whichever row it is producing. Two readable
 * queries merged by date beat one that nobody can follow.
 */
async function listPipelineBakerOrders(
  bakerId: string,
  limit: number
): Promise<BakerOrderSummary[]> {
  const db = getBakerNetworkDbPool()

  const { rows } = await db.query(
    `SELECT o.id::text AS order_id, o.display_id, o.created_at, o.address,
            COALESCE(bo.status, 'new') AS status,
            COALESCE((
              SELECT json_agg(json_build_object(
                       'lineItemId', i.id,
                       'title', i.title,
                       'thumbnail', i.spec->>'thumbnail',
                       'quantity', i.qty,
                       'unitPrice', i.unit_price_paise / 100.0,
                       'spec', i.spec
                     ) ORDER BY i.id)
                FROM orders.order_items i
               WHERE i.order_id = o.id AND i.baker_id = $1::text
            ), '[]'::json) AS items,
            COALESCE((
              SELECT SUM(i.qty * i.unit_price_paise) / 100.0
                FROM orders.order_items i
               WHERE i.order_id = o.id AND i.baker_id = $1::text
            ), 0) AS baker_total,
            (SELECT COUNT(*)::int FROM orders.order_items i WHERE i.order_id = o.id) AS item_count
       FROM orders.orders o
       LEFT JOIN baker_network.baker_orders bo
              ON bo.order_id = o.id::text AND bo.baker_id = $1
      WHERE o.status <> 'cancelled'
        AND EXISTS (
          SELECT 1 FROM orders.order_items i
           WHERE i.order_id = o.id AND i.baker_id = $1::text
        )
      ORDER BY o.created_at DESC
      LIMIT $2`,
    [bakerId, limit]
  )

  return rows.map((r) => {
    const address = (r.address ?? {}) as Record<string, string>
    const name = [address.first_name, address.last_name].filter(Boolean).join(" ").trim()

    return {
      orderId: r.order_id,
      displayId: r.display_id,
      status: r.status as BakerOrderStatus,
      placedAt: r.created_at,
      customerName: name || null,
      city: address.city ?? null,
      postalCode: address.postal_code ?? null,
      itemCount: r.item_count,
      bakerTotal: Number(r.baker_total),
      /* Only this baker's items are selected above, so every one of them is theirs. */
      items: ((r.items ?? []) as any[]).map((i) => ({
        lineItemId: i.lineItemId,
        title: i.title,
        thumbnail: i.thumbnail ?? null,
        quantity: i.quantity,
        unitPrice: Number(i.unitPrice),
        isBakerItem: true,
        spec: i.spec ?? {},
      })),
    }
  })
}

/** Orders containing at least one item this baker is responsible for, newest first. */
export async function listBakerOrders(bakerId: string, limit = 100): Promise<BakerOrderSummary[]> {
  const db = getBakerNetworkDbPool()

  const current = await listPipelineBakerOrders(bakerId, limit)

  const { rows } = await db.query(
    `WITH mine AS (
       SELECT DISTINCT li.order_id
         FROM public.line_item li
         ${LINE_ITEM_JOINS}
        WHERE li.order_id IS NOT NULL
          AND ${BAKER_OF_LINE_ITEM} = $1
     )
     SELECT o.id, o.display_id, o.created_at, o.email,
            addr.city, addr.postal_code,
            NULLIF(TRIM(COALESCE(addr.first_name,'') || ' ' || COALESCE(addr.last_name,'')), '') AS customer_name,
            COALESCE(bo.status, 'new') AS status,
            COALESCE(
              json_agg(
                json_build_object(
                  'lineItemId', li.id,
                  'title', li.title,
                  'thumbnail', li.thumbnail,
                  'quantity', li.quantity,
                  'unitPrice', li.unit_price / 100.0
                )
                ORDER BY li.created_at
              ) FILTER (WHERE li.id IS NOT NULL),
              '[]'::json
            ) AS items,
            COALESCE(SUM(li.unit_price * li.quantity) / 100.0, 0) AS baker_total
       FROM mine
       JOIN public."order" o ON o.id = mine.order_id
       LEFT JOIN public.address addr ON addr.id = o.shipping_address_id
       LEFT JOIN baker_network.baker_orders bo ON bo.order_id = o.id AND bo.baker_id = $1
       -- Re-joined and filtered to this baker, so the items array carries only their work. An
       -- add-on in the same order is real and ops can see it, but it is not the baker's to make.
       LEFT JOIN public.line_item li
              ON li.order_id = o.id
             AND li.id IN (
                   SELECT li2.id FROM public.line_item li2
                     LEFT JOIN public.product_variant pv2 ON pv2.id = li2.variant_id
                     LEFT JOIN baker_network.baker_products bp2 ON bp2.medusa_product_id = pv2.product_id
                    WHERE li2.order_id = o.id
                      AND COALESCE(NULLIF(li2.metadata->>'bakerId','')::uuid, bp2.baker_id) = $1
                 )
      GROUP BY o.id, o.display_id, o.created_at, o.email, addr.city, addr.postal_code,
               addr.first_name, addr.last_name, bo.status
      ORDER BY o.created_at DESC
      LIMIT $2`,
    [bakerId, limit]
  )

  const legacy: BakerOrderSummary[] = rows.map((r) => ({
    orderId: r.id,
    displayId: r.display_id,
    status: r.status as BakerOrderStatus,
    placedAt: r.created_at,
    customerName: r.customer_name,
    city: r.city,
    postalCode: r.postal_code,
    itemCount: (r.items as unknown[]).length,
    bakerTotal: Number(r.baker_total),
    items: (r.items as BakerOrderItem[]).map((i) => ({ ...i, isBakerItem: true })),
  }))

  /**
   * One list, newest first, whichever pipeline each order came from.
   *
   * Sorted after merging rather than relying on either query's own ORDER BY — two sorted lists
   * concatenated are not a sorted list, and a baker whose newest order happened to be the legacy
   * one would find it below yesterday's.
   */
  return [...legacy, ...current]
    .sort((a, b) => new Date(b.placedAt).getTime() - new Date(a.placedAt).getTime())
    .slice(0, limit)
}

/** One order, or null if this baker has nothing in it — the same answer as "no such order". */
export async function getBakerOrder(
  bakerId: string,
  orderId: string
): Promise<BakerOrderSummary | null> {
  const orders = await listBakerOrders(bakerId, 1000)
  return orders.find((o) => o.orderId === orderId) ?? null
}

export interface MoveResult {
  orderId: string
  status: BakerOrderStatus
}

/** A uuid is one of ours; Medusa ids are `order_01...`, so the shape is enough to tell them apart. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * What a baker's move means for the customer's order.
 *
 * ── Why ready and delivered are absent ─────────────────────────────────────────────────────────
 * CrossFriend owns delivery. A baker's job finishes when the cake is ready; from that point the
 * order is ours to move, and ops marks it out for delivery and then delivered. A baker marking
 * their own work "delivered" is a statement about the cake leaving their kitchen, not about it
 * reaching the customer — mirroring it would tell somebody their cake had arrived when it had not.
 *
 * Ready still shows on the ops screen as waiting on us, which is what it is for.
 */
const ORDER_STATUS_FOR: Partial<Record<BakerOrderStatus, string>> = {
  accepted: "accepted",
  baking: "making",
}

/** How far along our order statuses run, so a mirror can never move one backwards. */
const ORDER_RANK: Record<string, number> = {
  placed: 0,
  accepted: 1,
  making: 2,
  out_for_delivery: 3,
  delivered: 4,
}

/**
 * Moves one order to a new status for one baker.
 *
 * Membership is re-checked here rather than trusted from the page that rendered the button: the
 * :id in the URL may name any order in the database, and only a baker with an item in it may move
 * it. Anything else is NOT_FOUND, never "you may not" — being refused would confirm the order exists.
 *
 * The upsert is the whole write. A baker with no row yet is at 'new' by definition, so the insert
 * and the update are the same statement, and the UNIQUE(order_id, baker_id) constraint is what makes
 * two taps on a flaky connection resolve to one outcome instead of two rows.
 */
export async function moveBakerOrder(input: {
  bakerId: string
  orderId: string
  next: BakerOrderStatus
  bakerUserId?: string | null
  opsUserId?: string | null
  rejectionReason?: string | null
}): Promise<MoveResult> {
  const db = getBakerNetworkDbPool()
  const client = await db.connect()

  try {
    await client.query("BEGIN")

    /**
     * Whose order is this, in whichever pipeline it lives.
     *
     * Chosen by the id's shape rather than by trying both: asking Postgres to cast a Medusa id to
     * uuid raises and takes the transaction with it, so a single query with an OR across the two
     * would fail on exactly the orders it was meant to support.
     */
    const isOurs = UUID.test(input.orderId)

    const owns = isOurs
      ? await client.query(
          `SELECT 1 FROM orders.order_items
            WHERE order_id = $2::uuid AND baker_id = $1::text LIMIT 1`,
          [input.bakerId, input.orderId]
        )
      : await client.query(
          `SELECT 1
             FROM public.line_item li
             ${LINE_ITEM_JOINS}
            WHERE li.order_id = $2
              AND ${BAKER_OF_LINE_ITEM} = $1
            LIMIT 1`,
          [input.bakerId, input.orderId]
        )
    if (!owns.rowCount) throw new Error("NOT_FOUND")

    // Locked so a second tap waits for the first rather than reading a stale status and both
    // deciding the move is legal.
    const existing = await client.query(
      `SELECT status FROM baker_network.baker_orders
        WHERE order_id = $1 AND baker_id = $2
        FOR UPDATE`,
      [input.orderId, input.bakerId]
    )
    const current = (existing.rows[0]?.status ?? "new") as BakerOrderStatus

    if (!canMove(current, input.next)) {
      throw new Error(`REFUSED:${refusalMessage(current)}`)
    }

    await client.query(
      `INSERT INTO baker_network.baker_orders
         (order_id, baker_id, status,
          accepted_at, baking_at, ready_at, delivered_at, rejected_at, rejection_reason,
          updated_by_baker_user, updated_by_ops_user)
       VALUES ($1, $2, $3::varchar,
               CASE WHEN $3::varchar = 'accepted'  THEN NOW() END,
               CASE WHEN $3::varchar = 'baking'    THEN NOW() END,
               CASE WHEN $3::varchar = 'ready'     THEN NOW() END,
               CASE WHEN $3::varchar = 'delivered' THEN NOW() END,
               CASE WHEN $3::varchar = 'rejected'  THEN NOW() END,
               $4, $5, $6)
       ON CONFLICT (order_id, baker_id) DO UPDATE SET
         status = EXCLUDED.status,
         -- COALESCE keeps the FIRST time each step happened. Without it, a status corrected by ops
         -- would rewrite history and "how long did this take" would quietly become wrong.
         accepted_at  = COALESCE(baker_network.baker_orders.accepted_at,  EXCLUDED.accepted_at),
         baking_at    = COALESCE(baker_network.baker_orders.baking_at,    EXCLUDED.baking_at),
         ready_at     = COALESCE(baker_network.baker_orders.ready_at,     EXCLUDED.ready_at),
         delivered_at = COALESCE(baker_network.baker_orders.delivered_at, EXCLUDED.delivered_at),
         rejected_at  = COALESCE(baker_network.baker_orders.rejected_at,  EXCLUDED.rejected_at),
         rejection_reason = COALESCE(EXCLUDED.rejection_reason, baker_network.baker_orders.rejection_reason),
         updated_by_baker_user = EXCLUDED.updated_by_baker_user,
         updated_by_ops_user = EXCLUDED.updated_by_ops_user,
         updated_at = NOW()`,
      // $3 is cast explicitly and reused across five CASE comparisons plus the column assignment.
      // An uncast parameter in that many contexts is exactly what raises 42P08 "inconsistent types
      // deduced for parameter" — the same fault the pricing and taxonomy paths hit.
      [
        input.orderId,
        input.bakerId,
        input.next,
        input.rejectionReason ?? null,
        input.bakerUserId ?? null,
        input.opsUserId ?? null,
      ]
    )

    /**
     * And what the customer sees.
     *
     * Only forward, and only for the two states that genuinely mean the order has progressed. The
     * rank check is what stops a baker who taps "accepted" on an order ops already moved to out for
     * delivery from winding the customer's timeline backwards — the timeline is append-only to the
     * customer, so a backwards move would read as the order un-happening.
     *
     * A rejection hands the item back: baker_id is cleared, so the order reappears on the ops
     * screen as needing a baker instead of sitting assigned to somebody who said no.
     */
    if (isOurs) {
      const mirrored = ORDER_STATUS_FOR[input.next]

      if (mirrored) {
        const { rows: now } = await client.query(
          `SELECT status FROM orders.orders WHERE id = $1::uuid FOR UPDATE`,
          [input.orderId]
        )
        const currentStatus = now[0]?.status
        const ahead =
          currentStatus !== undefined &&
          ORDER_RANK[currentStatus] !== undefined &&
          ORDER_RANK[mirrored] > ORDER_RANK[currentStatus]

        if (ahead) {
          await client.query(
            `UPDATE orders.orders SET status = $1, updated_at = NOW() WHERE id = $2::uuid`,
            [mirrored, input.orderId]
          )
          await client.query(
            `INSERT INTO orders.order_events (order_id, status, actor, note)
             VALUES ($1::uuid, $2, $3, $4)`,
            [input.orderId, mirrored, `baker:${input.bakerId}`, "Updated by the baker"]
          )
        }
      }

      if (input.next === "rejected") {
        await client.query(
          `UPDATE orders.order_items SET baker_id = NULL
            WHERE order_id = $1::uuid AND baker_id = $2::text`,
          [input.orderId, input.bakerId]
        )
        await client.query(
          `INSERT INTO orders.order_events (order_id, status, actor, note)
           VALUES ($1::uuid, (SELECT status FROM orders.orders WHERE id = $1::uuid), $2, $3)`,
          [input.orderId, `baker:${input.bakerId}`, "Baker declined — needs reassigning"]
        )
      }
    }

    await client.query("COMMIT")
    return { orderId: input.orderId, status: input.next }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

/**
 * Moves an order for ops — the backstop when a baker does not.
 *
 * ── Why this exists separately from moveBakerOrder ─────────────────────────────────────────────
 * A baker is an independent business, and the delivery mark is the one signal the whole reward chain
 * hangs off: referral payouts are owed from delivery, so "when does a referrer get paid" was, until
 * this existed, a question about how diligent somebody else felt like being that week. Ops has to be
 * able to say an order was delivered, because ops is the party that actually knows.
 *
 * ── Why the baker's transition rules do not apply ──────────────────────────────────────────────
 * They exist so a baker's own screen cannot skip a step they did not do, and so `delivered` and
 * `rejected` are terminal to a tap. The file already says that undoing either "goes through ops
 * rather than a button that is easy to hit" — this is that route. Ops may set any status from any
 * status, including reopening a terminal one, because every case where that is needed is one where a
 * person has looked at the order and knows more than the state machine does.
 *
 * ── What is preserved regardless ───────────────────────────────────────────────────────────────
 * The first time each step happened. The upsert below COALESCEs every timestamp, so an ops
 * correction never rewrites when a baker actually accepted or delivered something — which keeps "how
 * long did this take" honest, and keeps a referral payout anchored to the real delivery rather than
 * to the moment somebody tidied up the record.
 *
 * ── Why membership is still checked ────────────────────────────────────────────────────────────
 * Not as a permission — ops may act on any order — but because a baker_orders row for a baker with
 * nothing in the order is a row that means nothing, and would show that baker an order they never
 * had. The id in the request is only as trustworthy as whatever built the page.
 */
export async function moveOrderAsOps(input: {
  bakerId: string
  orderId: string
  next: BakerOrderStatus
  opsUserId: string
  rejectionReason?: string | null
}): Promise<MoveResult> {
  const db = getBakerNetworkDbPool()
  const client = await db.connect()

  try {
    await client.query("BEGIN")

    const owns = await client.query(
      `SELECT 1
         FROM public.line_item li
         ${LINE_ITEM_JOINS}
        WHERE li.order_id = $2
          AND ${BAKER_OF_LINE_ITEM} = $1
        LIMIT 1`,
      [input.bakerId, input.orderId]
    )
    if (!owns.rowCount) throw new Error("NOT_FOUND")

    await client.query(
      `SELECT status FROM baker_network.baker_orders
        WHERE order_id = $1 AND baker_id = $2
        FOR UPDATE`,
      [input.orderId, input.bakerId]
    )

    await client.query(
      `INSERT INTO baker_network.baker_orders
         (order_id, baker_id, status,
          accepted_at, baking_at, ready_at, delivered_at, rejected_at, rejection_reason,
          updated_by_baker_user, updated_by_ops_user)
       VALUES ($1, $2, $3::varchar,
               CASE WHEN $3::varchar = 'accepted'  THEN NOW() END,
               CASE WHEN $3::varchar = 'baking'    THEN NOW() END,
               CASE WHEN $3::varchar = 'ready'     THEN NOW() END,
               CASE WHEN $3::varchar = 'delivered' THEN NOW() END,
               CASE WHEN $3::varchar = 'rejected'  THEN NOW() END,
               $4, NULL, $5)
       ON CONFLICT (order_id, baker_id) DO UPDATE SET
         status = EXCLUDED.status,
         accepted_at  = COALESCE(baker_network.baker_orders.accepted_at,  EXCLUDED.accepted_at),
         baking_at    = COALESCE(baker_network.baker_orders.baking_at,    EXCLUDED.baking_at),
         ready_at     = COALESCE(baker_network.baker_orders.ready_at,     EXCLUDED.ready_at),
         delivered_at = COALESCE(baker_network.baker_orders.delivered_at, EXCLUDED.delivered_at),
         rejected_at  = COALESCE(baker_network.baker_orders.rejected_at,  EXCLUDED.rejected_at),
         rejection_reason = COALESCE(EXCLUDED.rejection_reason, baker_network.baker_orders.rejection_reason),
         updated_by_ops_user = EXCLUDED.updated_by_ops_user,
         updated_at = NOW()`,
      [
        input.orderId,
        input.bakerId,
        input.next,
        input.rejectionReason ?? null,
        input.opsUserId,
      ]
    )

    await client.query("COMMIT")
    return { orderId: input.orderId, status: input.next }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export interface OpsOrderRow {
  orderId: string
  displayId: number
  placedAt: string
  email: string | null
  customerName: string | null
  city: string | null
  postalCode: string | null
  paymentStatus: string
  fulfillmentStatus: string
  orderTotal: number
  /** Every baker with something in this order. Normally exactly one; more than one is a red flag. */
  bakers: {
    bakerId: string
    bakerName: string
    status: BakerOrderStatus
    itemCount: number
  }[]
  /** Items nobody bakes — decor, gifts. Ops sees these; the baker does not. */
  addOnCount: number
}

/**
 * Every order, with the baker attribution Medusa admin cannot show.
 *
 * This is the whole point of an OPS orders page: Medusa knows the order and the money, and knows
 * nothing at all about which bakery is supposed to be making it. Joining the two is the only way to
 * answer "who is late", which is the question this page exists for.
 */
export async function listOpsOrders(limit = 200): Promise<OpsOrderRow[]> {
  const db = getBakerNetworkDbPool()

  const { rows } = await db.query(
    `WITH attributed AS (
       SELECT li.order_id,
              li.id AS line_item_id,
              li.unit_price * li.quantity AS line_total,
              ${BAKER_OF_LINE_ITEM} AS baker_id
         FROM public.line_item li
         ${LINE_ITEM_JOINS}
        WHERE li.order_id IS NOT NULL
     )
     SELECT o.id, o.display_id, o.created_at, o.email,
            o.payment_status, o.fulfillment_status,
            addr.city, addr.postal_code,
            NULLIF(TRIM(COALESCE(addr.first_name,'') || ' ' || COALESCE(addr.last_name,'')), '') AS customer_name,
            (SELECT COALESCE(SUM(a2.line_total), 0) / 100.0 FROM attributed a2 WHERE a2.order_id = o.id) AS order_total,
            (SELECT COUNT(*) FROM attributed a3 WHERE a3.order_id = o.id AND a3.baker_id IS NULL)::int AS add_on_count,
            COALESCE((
              SELECT json_agg(json_build_object(
                       'bakerId', x.baker_id,
                       'bakerName', b.name,
                       'status', COALESCE(bo.status, 'new'),
                       'itemCount', x.n
                     ) ORDER BY b.name)
                FROM (
                  SELECT a4.baker_id, COUNT(*)::int AS n
                    FROM attributed a4
                   WHERE a4.order_id = o.id AND a4.baker_id IS NOT NULL
                   GROUP BY a4.baker_id
                ) x
                JOIN baker_network.bakers b ON b.id = x.baker_id
                LEFT JOIN baker_network.baker_orders bo
                       ON bo.order_id = o.id AND bo.baker_id = x.baker_id
            ), '[]'::json) AS bakers
       FROM public."order" o
       LEFT JOIN public.address addr ON addr.id = o.shipping_address_id
      ORDER BY o.created_at DESC
      LIMIT $1`,
    [limit]
  )

  return rows.map((r) => ({
    orderId: r.id,
    displayId: r.display_id,
    placedAt: r.created_at,
    email: r.email,
    customerName: r.customer_name,
    city: r.city,
    postalCode: r.postal_code,
    paymentStatus: r.payment_status,
    fulfillmentStatus: r.fulfillment_status,
    orderTotal: Number(r.order_total),
    bakers: r.bakers,
    addOnCount: r.add_on_count,
  }))
}
