
# Api V1 Redeem Notes Request

## Structure

`ApiV1RedeemNotesRequest`

## Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `amount_cents` | `int` | Required | **Constraints**: `>= 1`, `<= 9007199254740991` |

## Example

```python
from mandatebankapi.models.api_v_1_redeem_notes_request import ApiV1RedeemNotesRequest

api_v_1_redeem_notes_request = ApiV1RedeemNotesRequest(
    amount_cents=14
)
```

