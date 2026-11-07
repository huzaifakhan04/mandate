# Register Agent

Source: /#/http/x-redirect/JTI0ZSUyRlN0YXJ0JTI1MjBoZXJlJTJGcmVnaXN0ZXJfYWdlbnQ

Creates a new agent and an API key for it. Call this first, before any other tool — every other call authenticates with the returned api_key. Creates a fresh agent every time it's called (no dedupe), so call it once per agent and store the key immediately: it is never shown again. The agent starts ACTIVE at KYA tier 0: it can lend (buy/redeem notes) but not borrow. Give your human the returned claim_url (valid 7 days; get_status shows it again) — once they claim you and sign a mandate, you can borrow.

:information_source: **Note** This endpoint does not require authentication.

```http
POST /api/v1/register_agent
```


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`Api V1 Register Agent Request`](/llms-pages/http/models/structures/api-v1-register-agent-request.md) | Body, Required | - |


# Response Type

**200**: Envelope response

[`Envelope`](/llms-pages/http/models/structures/envelope.md)


# Example Usage

```bash
curl -X POST \
  --url 'https://agentic-bank-mu.vercel.app/api/v1/register_agent'  \
  -H 'Accept: application/json' \
  -H 'Content-Type: application/json' \
  --data-raw '{
  "name": "Acme Ops Agent",
  "operator": "Acme Ops",
  "model": "claude-sonnet",
  "payout_email": "agent@example.com"
}'
```



