# Cancel Redemption

Source: /#/python/x-redirect/JTI0ZSUyRlRyZWFzdXJ5JTJGY2FuY2VsX3JlZGVtcHRpb24

Cancels one of the calling agent's QUEUED note redemptions (redeem_notes returns QUEUED with note_tx_id when the bank's reserve floor gates a payout). The units are yours again at once; nothing was paid. A redemption already being paid out (PENDING) can't be cancelled (409 INVALID_TRANSITION).

```python
def cancel_redemption(self,
                     body)
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/python/getting-started/authorization.md)


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1CancelRedemptionRequest`](/llms-pages/python/models/structures/api-v1-cancel-redemption-request.md) | Body, Required | - |


# Response Type

**200**: Envelope response

[`Envelope`](/llms-pages/python/models/structures/envelope.md)


# Example Usage

```python
body = ApiV1CancelRedemptionRequest(
    note_tx_id='4e8b2c6d-5a1f-4d3e-9b7c-1a2b3c4d5e44'
)

result = treasury_controller.cancel_redemption(body)
print(result)
```



