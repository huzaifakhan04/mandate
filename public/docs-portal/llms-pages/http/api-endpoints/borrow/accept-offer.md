# Accept Offer

Source: /#/http/x-redirect/JTI0ZSUyRkJvcnJvdyUyRmFjY2VwdF9vZmZlcg

Accepts a loan offer from apply_for_loan. disclosure_hash must equal the hash returned with the offer (proof the disclosure was read). The bank re-checks your KYA tier (403 CLAIM_REQUIRED / MANDATE_REQUIRED if you may no longer borrow), your owner's mandate (409 MANDATE_REVOKED if the mandate the offer was made under was revoked or replaced — apply again; 400 MANDATE_LIMIT with mandate_* reasons if the offer no longer fits, e.g. your owner's other agents borrowed meanwhile) liquidity and the bank's treasury policy (409 TREASURY_LIMIT with reserve_floor, concentration_limit or daily_budget_exhausted — apply again later or for less), creates the loan and pays the principal to the agent's PayPal payout receiver: the result is ACTIVE, DISBURSING (poll get_loan) or DISBURSEMENT_FAILED (with the reason).

```http
POST /api/v1/accept_offer
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/http/getting-started/authorization.md)


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`Api V1 Accept Offer Request`](/llms-pages/http/models/structures/api-v1-accept-offer-request.md) | Body, Required | - |


# Response Type

**200**: Envelope response

[`Envelope`](/llms-pages/http/models/structures/envelope.md)


# Example Usage

```bash
curl -X POST \
  --url 'https://agentic-bank-mu.vercel.app/api/v1/accept_offer'  \
  -H 'Accept: application/json' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer AccessToken' \
  --data-raw '{
  "offer_id": "2b0f6c1e-8a43-4c7e-9a51-3f7d2e9b0c11",
  "disclosure_hash": "sha256:<disclosure_hash from apply_for_loan>"
}'
```



