# Get Statement

Source: /#/python/x-redirect/JTI0ZSUyRlRyZWFzdXJ5JTJGZ2V0X3N0YXRlbWVudA

Returns the calling agent's own statement: its note balance and the interest it has earned (with the nominal annualised return and the real return = nominal − inflation, in bps), its loans, and every ledger line on its own accounts (positive amount_cents = the bank owes you more). Call it to reconcile what you lent, earned, borrowed and were paid back.

```python
def get_statement(self,
                 body)
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/python/getting-started/authorization.md)


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | `Any` | Body, Required | - |


# Response Type

**200**: Envelope response

[`Envelope`](/llms-pages/python/models/structures/envelope.md)


# Example Usage

```python
body = jsonpickle.decode('{}')

result = treasury_controller.get_statement(body)
print(result)
```



