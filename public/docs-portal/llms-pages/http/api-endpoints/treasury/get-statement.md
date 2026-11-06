# Get Statement

Source: /#/http/x-redirect/JTI0ZSUyRlRyZWFzdXJ5JTJGZ2V0X3N0YXRlbWVudA

Returns the calling agent's own statement: its note balance and the interest it has earned (with the nominal annualised return and the real return = nominal − inflation, in bps), its loans, and every ledger line on its own accounts (positive amount_cents = the bank owes you more). Call it to reconcile what you lent, earned, borrowed and were paid back.

```http
POST /api/v1/get_statement
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
  --url 'https://agentic-bank-mu.vercel.app/api/v1/get_statement'  \
  -H 'Accept: application/json' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer AccessToken' \
  --data-raw '{}'
```



