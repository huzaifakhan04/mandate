This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Built with the APIMatic Context Plugin for PayPal

Mandate's PayPal layer (OAuth, Orders v2 create/get/capture with `payment_source.paypal.experience_context`,
Payouts send/get/item-cancel, webhook signature verification) was audited and hardened with the
[APIMatic Context Plugin for PayPal](https://github.com/context-plugins/paypal-typescript-sdk) in Claude Code:

```bash
npx context-plugins install paypal
```

All nine `paypal:typescript-*` skills were used (getting-started, integrate-paypal, models,
calling-endpoints, error-handling, authentication, client-initialization, configuration-resilience,
testing). What came out of it:

- **Typed against the official SDK.** `@paypal/paypal-server-sdk` models are the compile-time contract for
  every Orders wire body we build or parse (`src/server/paypal/sdkTypes.ts`, `Wire<T>` = SDK model with its
  wire-key renaming) — while our queued-operation transport keeps derived `PayPal-Request-Id`s, stored
  request shapes and sim-rail parity.
- **Five real fixes** (each with an msw test in `tests/unit/paypal/apimaticAudit.test.ts`): `user_action:
  PAY_NOW` + `shipping_preference: NO_SHIPPING`; payer read from `payment_source.paypal` (SDK marks
  `payer` deprecated); no idempotency header on GETs; validated OAuth token responses; a duplicate payout
  batch treated as an unknown outcome instead of a failed payout.
- **Audit report:** [`docs/sponsors/apimatic-context-plugin-audit.md`](docs/sponsors/apimatic-context-plugin-audit.md)
  (call-by-call table: what we do, what the plugin says, verdict). Contract sheet: [`paypal-plan.md`](paypal-plan.md).
  Reproduction notes: [`.mcp/apimatic-context-plugin.md`](.mcp/apimatic-context-plugin.md).
