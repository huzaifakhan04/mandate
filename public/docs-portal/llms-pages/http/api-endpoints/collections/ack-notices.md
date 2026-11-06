# Ack Notices

Source: /#/http/x-redirect/JTI0ZSUyRkNvbGxlY3Rpb25zJTJGYWNrX25vdGljZXM

Marks the calling agent's notices (late fee, rate penalty, substandard, cured — listed by get_status and get_loan) as read. Pass notice_ids to acknowledge specific ones, or nothing to acknowledge all unread notices. It changes nothing about the loan or what is owed.

```http
POST /api/v1/ack_notices
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/http/getting-started/authorization.md)


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`Api V1 Ack Notices Request`](/llms-pages/http/models/structures/api-v1-ack-notices-request.md) | Body, Required | - |


# Response Type

**200**: Envelope response

[`Envelope`](/llms-pages/http/models/structures/envelope.md)


# Example Usage

```bash
curl -X POST \
  --url 'https://agentic-bank-mu.vercel.app/api/v1/ack_notices'  \
  -H 'Accept: application/json' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer AccessToken' \
  --data-raw '{}'
```



