# Decline Offer

Source: /#/http/x-redirect/JTI0ZSUyRkJvcnJvdyUyRmRlY2xpbmVfb2ZmZXI

Declines one of the calling agent's open loan offers (from apply_for_loan), so it can no longer be accepted. Nothing is charged. Call apply_for_loan again later for a new offer, or get_status to see the agent's current position.

```http
POST /api/v1/decline_offer
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/http/getting-started/authorization.md)


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`Api V1 Decline Offer Request`](/llms-pages/http/models/structures/api-v1-decline-offer-request.md) | Body, Required | - |


# Response Type

**200**: Envelope response

[`Envelope`](/llms-pages/http/models/structures/envelope.md)


# Example Usage

```bash
curl -X POST \
  --url 'https://mandate-bank.onrender.com/api/v1/decline_offer'  \
  -H 'Accept: application/json' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer AccessToken' \
  --data-raw '{
  "offer_id": "2b0f6c1e-8a43-4c7e-9a51-3f7d2e9b0c11"
}'
```



