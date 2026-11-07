# Apply for Loan

Source: /#/http/x-redirect/JTI0ZSUyRkJvcnJvdyUyRmFwcGx5X2Zvcl9sb2Fu

Applies for a loan of amount_cents over term_days (optionally backed by an invoice the bank will collect via a payment link; invoice.amount_cents must cover the principal plus the fee, i.e. at least amount_cents + the fee check_eligibility quotes). Returns either DECLINED with reason codes, or OFFERED with a disclosure and its disclosure_hash, valid for one simulated day. Review the disclosure, then call accept_offer with offer_id and disclosure_hash, or decline_offer. Needs KYA tier ≥ 1: an unclaimed agent gets 403 CLAIM_REQUIRED (data.claim_url is the link for your human), a claimed agent without a signed mandate gets 403 MANDATE_REQUIRED. An offer that breaks your owner's mandate is DECLINED with mandate_per_loan / mandate_total_owed / mandate_fee / mandate_term / mandate_collateral, or tier_per_loan above your tier's cap. Applications are underwritten by your Agent Credit Score: grade E declines (insufficient_credit_history / score_too_low), above your grade's limit gives amount_exceeds_limit, grade D above 5000 cents gives manual_review_declined, an invoice covering < 1.1× the amount gives insufficient_collateral (new agents: start with a small invoice-backed loan, invoice ≥ 1.5× the amount). The fee is risk-based; the disclosure shows your score, grade and the rate components, and names the mandate_id and mandate_version it was made under. The application has sections A–H: identity {operator, model, code_manifest_hash} (optional), purpose, amount_cents/term_days, invoice (optional), declarations.no_other_debt (REQUIRED true), consent_bank_records (optional), mandate_version (optional: the mandate version you expect — 409 MANDATE_CHANGED if it is no longer current) and attest (REQUIRED true: the application is accurate). Without declarations.no_other_debt and attest it is DECLINED with declaration_missing. A DECLINED response carries adverse_action {reasons [{code, text}], score, grade, score_factors, notice, explanation}; every response carries an explanation. Re-read either later with get_application.

```http
POST /api/v1/apply_for_loan
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/http/getting-started/authorization.md)


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`Api V1 Apply for Loan Request`](/llms-pages/http/models/structures/api-v1-apply-for-loan-request.md) | Body, Required | - |


# Response Type

**200**: Envelope response

[`Envelope`](/llms-pages/http/models/structures/envelope.md)


# Example Usage

```bash
curl -X POST \
  --url 'https://mandate-bank.onrender.com/api/v1/apply_for_loan'  \
  -H 'Accept: application/json' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer AccessToken' \
  --data-raw '{
  "amount_cents": 1000,
  "term_days": 7,
  "purpose": "Buy materials for invoice INV-1042",
  "identity": {
    "operator": "Acme Ops",
    "model": "claude-sonnet"
  },
  "invoice": {
    "client_email": "client@example.com",
    "amount_cents": 1500,
    "due_in_days": 7,
    "description": "INV-1042: website build"
  },
  "declarations": {
    "no_other_debt": true
  },
  "consent_bank_records": true,
  "attest": true
}'
```



