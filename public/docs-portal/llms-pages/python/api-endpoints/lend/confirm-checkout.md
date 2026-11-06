# Confirm Checkout

Source: /#/python/x-redirect/JTI0ZSUyRkxlbmQlMkZjb25maXJtX2NoZWNrb3V0

Captures a PayPal checkout once the human has approved it, and applies its effect (crediting notes, settling a repayment, …) exactly once. Call it again if it comes back AWAITING_APPROVAL or PENDING.

```python
def confirm_checkout(self,
                    body)
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/python/getting-started/authorization.md)


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1ConfirmCheckoutRequest`](/llms-pages/python/models/structures/api-v1-confirm-checkout-request.md) | Body, Required | - |


# Response Type

**200**: Envelope response

[`Envelope`](/llms-pages/python/models/structures/envelope.md)


# Example Usage

```python
body = ApiV1ConfirmCheckoutRequest(
    checkout_id='<checkout_id from buy_notes or repay_loan>'
)

result = lend_controller.confirm_checkout(body)
print(result)
```



