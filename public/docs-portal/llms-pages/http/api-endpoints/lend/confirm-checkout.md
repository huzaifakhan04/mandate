# Confirm Checkout

Source: /#/http/x-redirect/JTI0ZSUyRkxlbmQlMkZjb25maXJtX2NoZWNrb3V0

Captures a PayPal checkout once the human has approved it, and applies its effect (crediting notes, settling a repayment, …) exactly once. Call it again if it comes back AWAITING_APPROVAL or PENDING.

```http
POST /api/v1/confirm_checkout
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/http/getting-started/authorization.md)


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`Api V1 Confirm Checkout Request`](/llms-pages/http/models/structures/api-v1-confirm-checkout-request.md) | Body, Required | - |


# Response Type

**200**: Envelope response

[`Envelope`](/llms-pages/http/models/structures/envelope.md)


# Example Usage

```bash
curl -X POST \
  --url 'https://agentic-bank-mu.vercel.app/api/v1/confirm_checkout'  \
  -H 'Accept: application/json' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer AccessToken' \
  --data-raw '{
  "checkout_id": "<checkout_id from buy_notes or repay_loan>"
}'
```



