import type { MiddlewaresConfig } from "@medusajs/medusa"
import type { NextFunction, Request, Response } from "express"
import express from "express"

/**
 * One exception to Medusa's JSON body parsing: the Razorpay webhook.
 *
 * ── Why ────────────────────────────────────────────────────────────────────────────────────────
 * A webhook signature is an HMAC over the bytes Razorpay sent. Once express has parsed that body
 * into an object those bytes are gone, and re-serialising is a guess — key order, unicode escaping
 * and number formatting all have to come back identically or the signature fails on a genuine
 * delivery. So this route takes the raw buffer and parses it itself, after checking the signature.
 *
 * ── Why the signature is not load-bearing anyway ───────────────────────────────────────────────
 * Deliberately belt and braces. The webhook handler always asks Razorpay directly whether the order
 * was paid, so a forged delivery costs one API call and achieves nothing, and a missing
 * RAZORPAY_WEBHOOK_SECRET degrades to "slower" rather than "silently stops confirming orders". This
 * middleware makes the cheap check possible; it is not what makes the payment safe.
 */
/** Keeps the exact bytes beside the request so a route can verify the signature, then parse. */
const keepRawBody = [
  express.raw({ type: "*/*", limit: "1mb" }),
  (req: Request, _res: Response, next: NextFunction) => {
    ;(req as any).rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString("utf8")
      : typeof req.body === "string"
      ? req.body
      : ""
    next()
  },
]

export const config: MiddlewaresConfig = {
  routes: [
    {
      matcher: "/hooks/razorpay",
      method: ["POST"],
      /* Medusa's own parser off for this path — ours runs instead. */
      bodyParser: false,
      middlewares: keepRawBody,
    },
    /* Meta signs its webhooks (Instagram, Pages, WhatsApp) the same way (HMAC over the raw bytes), and here the
       signature is the only thing standing between a forged delivery and a DM to a stranger. */
    {
      matcher: "/hooks/meta",
      method: ["POST"],
      bodyParser: false,
      middlewares: keepRawBody,
    },
  ],
}
