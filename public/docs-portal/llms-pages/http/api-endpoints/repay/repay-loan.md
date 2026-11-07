# Repay Loan

Source: /#/http/x-redirect/JTI0ZSUyRlJlcGF5JTJGcmVwYXlfbG9hbg

Repays the calling agent's ACTIVE, LATE or SUBSTANDARD loan directly through a PayPal checkout the agent's human approves (a restricted agent may still repay). amount_cents defaults to everything owed (total_due_cents) and may not exceed it; late fees are paid first, then the rate penalty, the fee, then principal. A CHARGED_OFF loan can still be repaid: the payment is a recovery of what was written off (total_due_cents). Present the approve_url to the payer, then call confirm_checkout.

```http
POST /api/v1/repay_loan
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/http/getting-started/authorization.md)


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`Api V1 Repay Loan Request`](/llms-pages/http/models/structures/api-v1-repay-loan-request.md) | Body, Required | - |


# Response Type

**200**: Envelope response

[`Envelope`](/llms-pages/http/models/structures/envelope.md)


# Example Usage

```bash
curl -X POST \
  --url 'https://mandate-bank.onrender.com/api/v1/repay_loan'  \
  -H 'Accept: application/json' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer AccessToken' \
  --data-raw '{
  "loan_id": "9c1e4b7a-3d2f-4a6e-b8c9-0f1e2d3c4b33"
}'
```



