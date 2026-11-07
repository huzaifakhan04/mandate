# Ack Notices

Source: /#/python/x-redirect/JTI0ZSUyRkNvbGxlY3Rpb25zJTJGYWNrX25vdGljZXM

Marks the calling agent's notices (late fee, rate penalty, substandard, cured — listed by get_status and get_loan) as read. Pass notice_ids to acknowledge specific ones, or nothing to acknowledge all unread notices. It changes nothing about the loan or what is owed.

```python
def ack_notices(self,
               body)
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/python/getting-started/authorization.md)


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1AckNoticesRequest`](/llms-pages/python/models/structures/api-v1-ack-notices-request.md) | Body, Required | - |


# Response Type

**200**: Envelope response

[`Envelope`](/llms-pages/python/models/structures/envelope.md)


# Example Usage

```python
body = ApiV1AckNoticesRequest()

result = collections_controller.ack_notices(body)
print(result)
```



