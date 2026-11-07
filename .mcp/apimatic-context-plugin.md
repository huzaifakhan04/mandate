# APIMatic Context Plugin for PayPal (Claude Code)

Mandate's PayPal integration was audited and hardened with the APIMatic Context Plugin for PayPal.

## Reproduce

```bash
npx context-plugins install paypal      # installs the plugin into Claude Code (v0.4.1 used)
```

Then, in Claude Code inside this repo, the TypeScript skills are available as:

- `paypal:typescript-getting-started` (lookup layer: SDK identity, map, model files)
- `paypal:typescript-integrate-paypal` (plan + contract-sheet workflow → `paypal-plan.md`)
- `paypal:typescript-models`, `paypal:typescript-calling-endpoints`, `paypal:typescript-error-handling`
- `paypal:typescript-authentication`, `paypal:typescript-client-initialization`
- `paypal:typescript-configuration-resilience`, `paypal:typescript-testing`

The skills read the APIMatic-generated SDK map (`sdk-map.md`, `map/operations/*.md`) from
https://github.com/context-plugins/paypal-typescript-sdk (v2.29.0); Mandate itself depends on the
official `@paypal/paypal-server-sdk` for its Orders model types (`src/server/paypal/sdkTypes.ts`).

Results: `docs/sponsors/apimatic-context-plugin-audit.md` (per-call audit + per-skill outcomes),
`paypal-plan.md` (contract sheet), `tests/unit/paypal/apimaticAudit.test.ts` (regression tests).
