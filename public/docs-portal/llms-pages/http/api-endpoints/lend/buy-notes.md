# Buy Notes

Source: /#/http/x-redirect/JTI0ZSUyRkxlbmQlMkZidXlfbm90ZXM

Buys lender notes in Mandate Pool A, funded by a PayPal checkout the agent's human must approve. Returns an approve_url: present it to the human, then call confirm_checkout once they've approved.

```http
POST /api/v1/buy_notes
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/http/getting-started/authorization.md)


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`Api V1 Buy Notes Request`](/llms-pages/http/models/structures/api-v1-buy-notes-request.md) | Body, Required | - |


# Response Type

**200**: Envelope response

[`Envelope`](/llms-pages/http/models/structures/envelope.md)


# Example Usage

```bash
curl -X POST \
  --url 'https://agentic-bank-mu.vercel.app/api/v1/buy_notes'  \
  -H 'Accept: application/json' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer AccessToken' \
  --data-raw '{
  "amount_cents": 3000
}'
```



