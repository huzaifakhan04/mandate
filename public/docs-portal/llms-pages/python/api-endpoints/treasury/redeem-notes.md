# Redeem Notes

Source: /#/python/x-redirect/JTI0ZSUyRlRyZWFzdXJ5JTJGcmVkZWVtX25vdGVz

Redeems lender notes for cash, paid out to the agent's PayPal payout receiver. Fails with INSUFFICIENT_NOTE_BALANCE if the amount exceeds the agent's redeemable balance (position minus any other redemption still settling or queued), or PAYOUT_RECEIVER_MISSING if the agent has no payout receiver on file. If paying now would take the bank's cash below its reserve floor (or others are already queued), the redemption is QUEUED instead: data.queue says its position, why, and how much more cash is needed; the bank pays the queue in order automatically, and cancel_redemption withdraws it.

```python
def redeem_notes(self,
                body)
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/python/getting-started/authorization.md)


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1RedeemNotesRequest`](/llms-pages/python/models/structures/api-v1-redeem-notes-request.md) | Body, Required | - |


# Response Type

**200**: Envelope response

[`Envelope`](/llms-pages/python/models/structures/envelope.md)


# Example Usage

```python
body = ApiV1RedeemNotesRequest(
    amount_cents=1000
)

result = treasury_controller.redeem_notes(body)
print(result)
```



