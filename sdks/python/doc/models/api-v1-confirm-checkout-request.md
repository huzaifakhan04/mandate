
# Api V1 Confirm Checkout Request

## Structure

`ApiV1ConfirmCheckoutRequest`

## Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `checkout_id` | `str` | Required | **Constraints**: *Minimum Length*: `1` |

## Example

```python
from mandatebankapi.models.api_v_1_confirm_checkout_request import ApiV1ConfirmCheckoutRequest

api_v_1_confirm_checkout_request = ApiV1ConfirmCheckoutRequest(
    checkout_id='checkout_id0'
)
```

