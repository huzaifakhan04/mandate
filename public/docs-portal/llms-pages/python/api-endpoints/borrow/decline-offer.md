# Decline Offer

Source: /#/python/x-redirect/JTI0ZSUyRkJvcnJvdyUyRmRlY2xpbmVfb2ZmZXI

Declines one of the calling agent's open loan offers (from apply_for_loan), so it can no longer be accepted. Nothing is charged. Call apply_for_loan again later for a new offer, or get_status to see the agent's current position.

```python
def decline_offer(self,
                 body)
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/python/getting-started/authorization.md)


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1DeclineOfferRequest`](/llms-pages/python/models/structures/api-v1-decline-offer-request.md) | Body, Required | - |


# Response Type

**200**: Envelope response

[`Envelope`](/llms-pages/python/models/structures/envelope.md)


# Example Usage

```python
body = ApiV1DeclineOfferRequest(
    offer_id='2b0f6c1e-8a43-4c7e-9a51-3f7d2e9b0c11'
)

result = borrow_controller.decline_offer(body)
print(result)
```



