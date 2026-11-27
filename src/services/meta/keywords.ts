/**
 * Deterministic comment matching — the three keyword modes. (Intent matching is the AI's job, in
 * ai.ts; "any comment" needs no matching at all.)
 *
 *   exact     the whole comment is the keyword:      "CALENDAR 🙏" ✓   "send calendar" ✗
 *   word      the keyword appears as whole word(s):  "send calendar" ✓  "calander" ✓ (typo)  "cal" ✗
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
  /* Second pass, "word" only: a misspelt single word ("calander", "calender") still counts. */
  if (mode === "word") {
    const words = haystack.trim().split(" ")
    for (const raw of keywords) {
      const needle = normalise(raw).trim()
      if (needle && words.some((w) => isTypoOf(w, needle))) return raw
    }
  }
  return null
}

/**
 * A word close enough to a single-word keyword to be the same request typed in a hurry: same first
 * letter, at most one slip for keywords of 5–7 letters, two for 8 or more. Shorter keywords ("pdf",
 * "हाँ") must match exactly — one slip there turns them into other words.
 */
export function isTypoOf(word: string, keyword: string): boolean {
  if (keyword.includes(" ")) return false
  const n = [...keyword].length
  if (n < 5 || word[0] !== keyword[0]) return false
  const allowed = n >= 8 ? 2 : 1
  if (Math.abs([...word].length - n) > allowed) return false
  return editDistance(word, keyword) <= allowed
}

/** Optimal-string-alignment distance: insert, delete, substitute, or swap two neighbours. */
function editDistance(x: string, y: string): number {
  const a = [...x]
  const b = [...y]
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  }
  return d[a.length][b.length]
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
