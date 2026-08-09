/**
 * The one place CrossFriend product metadata is constructed.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────────
 * Medusa's `metadata` is an untyped JSONB bag, and Medusa Admin edits it through a free-text
 * key/value box. The Pranajiva catalogue in this same database shows exactly where that leads: on
 * two products, four keys have two different shapes.
 *
 *   pair_with     Neem: ["multani-mitti","rose-water"]      Moringa: "\"a\",       \"b\""
 *   who_is_it_for Neem: [...]                               Moringa: "\"...\",     \"...\""
 *   ritual_usage  Neem: { time, method, frequency }         Moringa: " \"time\": \"Morning\", ..."
 *   benefits      Neem: [...]                               Moringa: "a, b, c"
 *
 * Someone pasted the inside of a JSON array into a text field; the whitespace runs are still there.
 * Nothing can read both shapes, so those fields are inert. That happened to a small catalogue
 * maintained by people invested in it — bakers filling a form on a phone will not do better.
 *
 * So no creation path writes `metadata` directly. Everything goes through here, which coerces
 * types, drops unknown keys, and normalises arrays. Same principle as the baker profile allowlist:
 * the shape is enforced at the write, not documented and hoped for.
 *
 * ── Field ownership ─────────────────────────────────────────────────────────────────────────────
 * Split by who knows the answer and who bears the cost of it being wrong:
 *
 *   BAKER, required   contains (allergens), sizes+prices, prep time, name, photos
 *   BAKER, optional   who_is_it_for, highlights, care_note
 *   CROSSFRIEND       seo_*, is_addon, kit_eligible  (ops curation / auto-generated)
 *
 * Ops-owned fields are never accepted from a baker payload — see buildBakerProductMetadata.
 */

export interface BakerMetadataInput {
  bakerPublicId: string
  bakerName: string
  bakerSlug?: string | null
  bakerCity?: string | null
  productTitle: string
  categoryLabel?: string | null
  prepHours?: number | null
  /** Allergens and ingredients. Required to publish — this is a compliance field, not a nicety. */
  contains?: string[]
  whoIsItFor?: string[]
  highlights?: string[]
  careNote?: string | null
}

export interface CrossFriendProductMetadata {
  brand: "crossfriend"
  source: "baker" | "ops" | "ai_studio"
  baker_id: string
  baker_name: string
  baker_slug?: string
  prep_hours?: number
  contains?: string[]
  who_is_it_for?: string[]
  highlights?: string[]
  care_note?: string
  seo_title?: string
  seo_description?: string
  [key: string]: unknown
}

/** Caps exist so one pasted essay cannot bloat every product row and every API response. */
const MAX_LIST_ITEMS = 12
const MAX_ITEM_CHARS = 120
const MAX_NOTE_CHARS = 500
/** Search engines truncate around these; writing past them wastes the useful part. */
const MAX_SEO_TITLE = 60
const MAX_SEO_DESCRIPTION = 155

/**
 * Coerces anything into a clean string array.
 *
 * Deliberately tolerant of the comma-separated string a form actually submits, because that IS the
 * real input shape — a text input cannot produce an array. What it will never do is store the
 * string as-is, which is the precise failure in the Pranajiva rows.
 */
export function toStringList(value: unknown): string[] | undefined {
  let raw: unknown[]

  if (Array.isArray(value)) {
    raw = value
  } else if (typeof value === "string") {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    // A string that is actually JSON gets parsed rather than stored as text — this is exactly the
    // paste that corrupted the Pranajiva rows, caught instead of persisted.
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed)
        raw = Array.isArray(parsed) ? parsed : [trimmed]
      } catch {
        raw = trimmed.split(",")
      }
    } else {
      raw = trimmed.split(",")
    }
  } else {
    return undefined
  }

  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== "string" && typeof item !== "number") continue
    // Strips the stray quotes left by a half-pasted JSON array.
    const clean = String(item).replace(/^["'\s]+|["'\s]+$/g, "").trim().slice(0, MAX_ITEM_CHARS)
    if (!clean) continue
    const key = clean.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(clean)
    if (out.length >= MAX_LIST_ITEMS) break
  }

  return out.length ? out : undefined
}

function toNote(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const clean = value.trim().slice(0, MAX_NOTE_CHARS)
  return clean || undefined
}

/**
 * Generates the SEO title and description.
 *
 * Auto-generated rather than authored because these are mechanical — title, baker, city, category —
 * and because the alternative does not scale: at 200 bakers with 20 products each, "ops writes the
 * SEO" means 4,000 hand-written strings that nobody will ever finish. Generation makes the ops
 * screen an exception list ("12 look wrong") instead of a backlog ("4,000 missing").
 *
 * Worth noting the existing storefront ignores seo_title entirely — generateMetadata builds from
 * product.title and a description slice — so these are written for a consumer that must be wired up
 * alongside, or they are just more inert metadata.
 */
export function buildSeo(input: {
  productTitle: string
  bakerName: string
  bakerCity?: string | null
  categoryLabel?: string | null
  description?: string | null
}): { seo_title: string; seo_description: string } {
  const title = input.productTitle.trim()
  const baker = input.bakerName.trim()

  // "Chocolate Truffle Cake by Butter Berry | CrossFriend", trimmed to fit rather than truncated
  // mid-word — a title ending "Butter Ber…" reads as broken rather than abbreviated.
  let seoTitle = `${title} by ${baker} | CrossFriend`
  if (seoTitle.length > MAX_SEO_TITLE) {
    seoTitle = `${title} | CrossFriend`
  }
  if (seoTitle.length > MAX_SEO_TITLE) {
    seoTitle = title.slice(0, MAX_SEO_TITLE - 1).trimEnd() + "…"
  }

  const where = input.bakerCity ? ` in ${input.bakerCity.trim()}` : ""
  const what = input.categoryLabel ? input.categoryLabel.trim().toLowerCase() : "treats"
  const base =
    input.description?.trim()
      ? input.description.trim().replace(/\s+/g, " ")
      : `Order ${title} from ${baker}${where}. Fresh ${what} made to order on CrossFriend.`

  const seoDescription =
    base.length > MAX_SEO_DESCRIPTION
      ? base.slice(0, MAX_SEO_DESCRIPTION - 1).trimEnd() + "…"
      : base

  return { seo_title: seoTitle, seo_description: seoDescription }
}

/**
 * Builds the metadata for a baker-created product.
 *
 * Ops-owned keys (is_addon, kit_eligible, pair_with, and anything else) are absent by construction:
 * this function only ever emits the keys below, so a baker payload carrying `is_addon: true` cannot
 * smuggle it through. That is why callers pass a typed input rather than spreading a request body.
 */
export function buildBakerProductMetadata(
  input: BakerMetadataInput,
  description?: string | null
): CrossFriendProductMetadata {
  const contains = toStringList(input.contains)
  const whoIsItFor = toStringList(input.whoIsItFor)
  const highlights = toStringList(input.highlights)
  const careNote = toNote(input.careNote)

  const seo = buildSeo({
    productTitle: input.productTitle,
    bakerName: input.bakerName,
    bakerCity: input.bakerCity,
    categoryLabel: input.categoryLabel,
    description,
  })

  return {
    brand: "crossfriend",
    source: "baker",
    baker_id: input.bakerPublicId,
    baker_name: input.bakerName,
    ...(input.bakerSlug ? { baker_slug: input.bakerSlug } : {}),
    ...(input.prepHours != null ? { prep_hours: input.prepHours } : {}),
    ...(contains ? { contains } : {}),
    ...(whoIsItFor ? { who_is_it_for: whoIsItFor } : {}),
    ...(highlights ? { highlights } : {}),
    ...(careNote ? { care_note: careNote } : {}),
    ...seo,
  }
}

/**
 * The fields a listing must have before it can go live.
 *
 * Checked at publish rather than at creation so a baker can save a half-finished listing and come
 * back to it — the draft state exists precisely for that. What it must not do is reach a customer
 * incomplete.
 *
 * `contains` is here for a different reason from the rest. CrossFriend sells food; allergen
 * disclosure is a legal obligation, and "the baker left it blank" is not a defence when someone
 * with a nut allergy orders a cake. It is the one field where an empty value is a safety problem
 * rather than a quality one.
 */
export function missingForPublish(product: {
  title?: string | null
  description?: string | null
  thumbnail?: string | null
  metadata?: Record<string, unknown> | null
  variantCount: number
}): string[] {
  const missing: string[] = []
  const meta = product.metadata ?? {}

  if (!product.title?.trim()) missing.push("a name")
  if (!product.description?.trim()) missing.push("a description")
  if (!product.thumbnail) missing.push("at least one photo")
  if (product.variantCount < 1) missing.push("at least one size and price")

  const contains = Array.isArray(meta.contains) ? meta.contains : []
  if (contains.length === 0) missing.push("ingredients and allergens")

  return missing
}
