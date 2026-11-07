# Treasury

```python
treasury_api = client.treasury
```

## Class Name

`TreasuryApi`

## Methods

* [Redeem Notes](../../doc/controllers/treasury.md#redeem-notes)
* [Cancel Redemption](../../doc/controllers/treasury.md#cancel-redemption)
* [Get Statement](../../doc/controllers/treasury.md#get-statement)


# Redeem Notes

Redeems lender notes for cash, paid out to the agent's PayPal payout receiver. Fails with INSUFFICIENT_NOTE_BALANCE if the amount exceeds the agent's redeemable balance (position minus any other redemption still settling or queued), or PAYOUT_RECEIVER_MISSING if the agent has no payout receiver on file. If paying now would take the bank's cash below its reserve floor (or others are already queued), the redemption is QUEUED instead: data.queue says its position, why, and how much more cash is needed; the bank pays the queue in order automatically, and cancel_redemption withdraws it.

```python
def redeem_notes(self,
                body)
```

## Authentication

This endpoint requires [bearerAuth](../../doc/auth/oauth-2-bearer-token.md)

## Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1RedeemNotesRequest`](../../doc/models/api-v1-redeem-notes-request.md) | Body, Required | - |

## Response Type

**200**: Envelope response

This method returns an [`ApiResponse`](../../doc/api-response.md) instance. The `body` property of this instance returns the response data which is of type [`Envelope`](../../doc/models/envelope.md).

## Example Usage

```python
body = ApiV1RedeemNotesRequest(
    amount_cents=1000
)

result = treasury_api.redeem_notes(body)

if result.is_success():
    print(result.body)
elif result.is_error():
    print(result.errors)
```


# Cancel Redemption

Cancels one of the calling agent's QUEUED note redemptions (redeem_notes returns QUEUED with note_tx_id when the bank's reserve floor gates a payout). The units are yours again at once; nothing was paid. A redemption already being paid out (PENDING) can't be cancelled (409 INVALID_TRANSITION).

```python
def cancel_redemption(self,
                     body)
```

## Authentication

This endpoint requires [bearerAuth](../../doc/auth/oauth-2-bearer-token.md)

## Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1CancelRedemptionRequest`](../../doc/models/api-v1-cancel-redemption-request.md) | Body, Required | - |

## Response Type

**200**: Envelope response

This method returns an [`ApiResponse`](../../doc/api-response.md) instance. The `body` property of this instance returns the response data which is of type [`Envelope`](../../doc/models/envelope.md).

## Example Usage

```python
body = ApiV1CancelRedemptionRequest(
    note_tx_id='4e8b2c6d-5a1f-4d3e-9b7c-1a2b3c4d5e44'
)

result = treasury_api.cancel_redemption(body)

if result.is_success():
    print(result.body)
elif result.is_error():
    print(result.errors)
```


# Get Statement

Returns the calling agent's own statement: its note balance and the interest it has earned (with the nominal annualised return and the real return = nominal − inflation, in bps), its loans, and every ledger line on its own accounts (positive amount_cents = the bank owes you more). Call it to reconcile what you lent, earned, borrowed and were paid back.

```python
def get_statement(self,
                 body)
```

## Authentication

This endpoint requires [bearerAuth](../../doc/auth/oauth-2-bearer-token.md)

## Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | `Any` | Body, Required | - |

## Response Type

**200**: Envelope response

This method returns an [`ApiResponse`](../../doc/api-response.md) instance. The `body` property of this instance returns the response data which is of type [`Envelope`](../../doc/models/envelope.md).

## Example Usage

```python
body = jsonpickle.decode('{}')

result = treasury_api.get_statement(body)

if result.is_success():
    print(result.body)
elif result.is_error():
    print(result.errors)
```

