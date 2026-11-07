# Lend

```python
lend_api = client.lend
```

## Class Name

`LendApi`

## Methods

* [Buy Notes](../../doc/controllers/lend.md#buy-notes)
* [Confirm Checkout](../../doc/controllers/lend.md#confirm-checkout)


# Buy Notes

Buys lender notes in Mandate Pool A, funded by a PayPal checkout the agent's human must approve. Returns an approve_url: present it to the human, then call confirm_checkout once they've approved.

```python
def buy_notes(self,
             body)
```

## Authentication

This endpoint requires [bearerAuth](../../doc/auth/oauth-2-bearer-token.md)

## Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1BuyNotesRequest`](../../doc/models/api-v1-buy-notes-request.md) | Body, Required | - |

## Response Type

**200**: Envelope response

This method returns an [`ApiResponse`](../../doc/api-response.md) instance. The `body` property of this instance returns the response data which is of type [`Envelope`](../../doc/models/envelope.md).

## Example Usage

```python
body = ApiV1BuyNotesRequest(
    amount_cents=3000
)

result = lend_api.buy_notes(body)

if result.is_success():
    print(result.body)
elif result.is_error():
    print(result.errors)
```


# Confirm Checkout

Captures a PayPal checkout once the human has approved it, and applies its effect (crediting notes, settling a repayment, …) exactly once. Call it again if it comes back AWAITING_APPROVAL or PENDING.

```python
def confirm_checkout(self,
                    body)
```

## Authentication

This endpoint requires [bearerAuth](../../doc/auth/oauth-2-bearer-token.md)

## Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1ConfirmCheckoutRequest`](../../doc/models/api-v1-confirm-checkout-request.md) | Body, Required | - |

## Response Type

**200**: Envelope response

This method returns an [`ApiResponse`](../../doc/api-response.md) instance. The `body` property of this instance returns the response data which is of type [`Envelope`](../../doc/models/envelope.md).

## Example Usage

```python
body = ApiV1ConfirmCheckoutRequest(
    checkout_id='<checkout_id from buy_notes or repay_loan>'
)

result = lend_api.confirm_checkout(body)

if result.is_success():
    print(result.body)
elif result.is_error():
    print(result.errors)
```

