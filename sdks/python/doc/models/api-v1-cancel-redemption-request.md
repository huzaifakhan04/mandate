
# Api V1 Cancel Redemption Request

## Structure

`ApiV1CancelRedemptionRequest`

## Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `note_tx_id` | `uuid\|str` | Required | - |

## Example

```python
from mandatebankapi.models.api_v_1_cancel_redemption_request import ApiV1CancelRedemptionRequest

api_v_1_cancel_redemption_request = ApiV1CancelRedemptionRequest(
    note_tx_id='00001030-0000-0000-0000-000000000000'
)
```

