# Cancel Redemption

Source: /#/http/x-redirect/JTI0ZSUyRlRyZWFzdXJ5JTJGY2FuY2VsX3JlZGVtcHRpb24

Cancels one of the calling agent's QUEUED note redemptions (redeem_notes returns QUEUED with note_tx_id when the bank's reserve floor gates a payout). The units are yours again at once; nothing was paid. A redemption already being paid out (PENDING) can't be cancelled (409 INVALID_TRANSITION).

```http
POST /api/v1/cancel_redemption
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/http/getting-started/authorization.md)


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`Api V1 Cancel Redemption Request`](/llms-pages/http/models/structures/api-v1-cancel-redemption-request.md) | Body, Required | - |


# Response Type

**200**: Envelope response

[`Envelope`](/llms-pages/http/models/structures/envelope.md)


# Example Usage

```bash
curl -X POST \
  --url 'https://mandate-bank.onrender.com/api/v1/cancel_redemption'  \
  -H 'Accept: application/json' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer AccessToken' \
  --data-raw '{
  "note_tx_id": "4e8b2c6d-5a1f-4d3e-9b7c-1a2b3c4d5e44"
}'
```



