/**
 * Deterministic comment matching — the three keyword modes. (Intent matching is the AI's job, in
 * ai.ts; "any comment" needs no matching at all.)
 *
 *   exact     the whole comment is the keyword:      "CALENDAR 🙏" ✓   "send calendar" ✗
 *   word      the keyword appears as whole word(s):  "send calendar" ✓  "calendars" ✗
 *   contains  the keyword appears anywhere:          "calendars" ✓     "mycalendar" ✓
 *
 * All three ignore case, punctuation and emoji, and work on Devanagari as well as Latin script.
 * "word" is the default because substring matching on short keywords ("pdf", "हाँ") fires on
 * comments that never asked for anything.
 */

export type MatchMode = "exact" | "word" | "contains"

/** Lower-cased, NFC, every run of non-letters/marks/digits collapsed to one space, padded. */
export function normalise(text: string): string {
  return ` ${String(text ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim()} `
}

export function matchKeyword(comment: string, keywords: string[], mode: MatchMode = "word"): string | null {
  const haystack = normalise(comment)
  for (const raw of keywords) {
    const needle = normalise(raw).trim()
    if (!needle) continue
    if (mode === "exact" && haystack.trim() === needle) return raw
    if (mode === "word" && haystack.includes(` ${needle} `)) return raw
    if (mode === "contains" && haystack.replace(/ /g, "").includes(needle.replace(/ /g, ""))) return raw
  }
  return null
}

/** Cleans what an operator typed: trimmed, de-duplicated, no empties, at most 30. */
export function cleanKeywords(input: unknown): string[] {
  const list = Array.isArray(input) ? input : String(input ?? "").split(/[,\n]/)
  const seen = new Set<string>()
  const out: string[] = []
  for (const k of list) {
    const v = String(k ?? "").trim().slice(0, 60)
    const key = normalise(v).trim()
    if (key && !seen.has(key)) {
      seen.add(key)
      out.push(v)
    }
  }
  return out.slice(0, 30)
}

/** Cleans a list of templates: one per array item or per paragraph block separated by a "---" line. */
export function cleanTemplates(input: unknown, max: number, maxLen: number): string[] {
  const list = Array.isArray(input) ? input : String(input ?? "").split(/\n-{3,}\n/)
  return list
    .map((t) => String(t ?? "").trim())
    .filter(Boolean)
    .slice(0, max)
    .map((t) => t.slice(0, maxLen))
}
