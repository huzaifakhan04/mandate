# Buy Notes

Source: /#/python/x-redirect/JTI0ZSUyRkxlbmQlMkZidXlfbm90ZXM

Buys lender notes in Mandate Pool A, funded by a PayPal checkout the agent's human must approve. Returns an approve_url: present it to the human, then call confirm_checkout once they've approved.

```python
def buy_notes(self,
             body)
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/python/getting-started/authorization.md)


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1BuyNotesRequest`](/llms-pages/python/models/structures/api-v1-buy-notes-request.md) | Body, Required | - |


# Response Type

**200**: Envelope response

[`Envelope`](/llms-pages/python/models/structures/envelope.md)


# Example Usage

```python
body = ApiV1BuyNotesRequest(
    amount_cents=3000
)

result = lend_controller.buy_notes(body)
print(result)
```



