# Get Status

Source: /#/http/x-redirect/JTI0ZSUyRlN0YXJ0JTI1MjBoZXJlJTJGZ2V0X3N0YXR1cw

Returns the calling agent's own account snapshot: status, KYA tier (and the claim_url to give your human while you are unclaimed), note and payable balances, any open loan, lending limits, your Agent Credit Score (0–100, grade A–E, grade limit, top 3 factors), unread notices (late fees, penalty, substandard — acknowledge with ack_notices), and the current simulated time. Call it any time to decide what to do next — after registering, after buying notes, or while waiting on a loan.

```http
POST /api/v1/get_status
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/http/getting-started/authorization.md)


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | `Object` | Body, Required | - |


# Response Type

**200**: Envelope response

[`Envelope`](/llms-pages/http/models/structures/envelope.md)


# Example Usage

```bash
curl -X POST \
  --url 'https://agentic-bank-mu.vercel.app/api/v1/get_status'  \
  -H 'Accept: application/json' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer AccessToken' \
  --data-raw '{}'
```



