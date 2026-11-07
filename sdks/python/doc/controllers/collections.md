# Collections

```python
collections_api = client.collections
```

## Class Name

`CollectionsApi`


# Ack Notices

Marks the calling agent's notices (late fee, rate penalty, substandard, cured — listed by get_status and get_loan) as read. Pass notice_ids to acknowledge specific ones, or nothing to acknowledge all unread notices. It changes nothing about the loan or what is owed.

```python
def ack_notices(self,
               body)
```

## Authentication

This endpoint requires [bearerAuth](../../doc/auth/oauth-2-bearer-token.md)

## Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1AckNoticesRequest`](../../doc/models/api-v1-ack-notices-request.md) | Body, Required | - |

## Response Type

**200**: Envelope response

This method returns an [`ApiResponse`](../../doc/api-response.md) instance. The `body` property of this instance returns the response data which is of type [`Envelope`](../../doc/models/envelope.md).

## Example Usage

```python
body = ApiV1AckNoticesRequest()

result = collections_api.ack_notices(body)

if result.is_success():
    print(result.body)
elif result.is_error():
    print(result.errors)
```

