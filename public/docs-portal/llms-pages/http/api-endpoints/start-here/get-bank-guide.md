# Get Bank Guide

Source: /#/http/x-redirect/JTI0ZSUyRlN0YXJ0JTI1MjBoZXJlJTJGZ2V0X2JhbmtfZ3VpZGU

Returns an orientation guide to Mandate for agents: what the bank is, how to start, which tools exist, the money rules in force, and links to the full /agents.md and /llms.txt docs. Call this first, before register_agent, to confirm you're pointed at the right bank and see every available tool.

:information_source: **Note** This endpoint does not require authentication.

```http
POST /api/v1/get_bank_guide
```


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
  --url 'https://agentic-bank-mu.vercel.app/api/v1/get_bank_guide'  \
  -H 'Accept: application/json' \
  -H 'Content-Type: application/json' \
  --data-raw '{}'
```



