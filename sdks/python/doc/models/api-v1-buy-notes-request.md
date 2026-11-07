
# Api V1 Buy Notes Request

## Structure

`ApiV1BuyNotesRequest`

## Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `amount_cents` | `int` | Required | **Constraints**: `>= 1000`, `<= 100000` |

## Example

```python
from mandatebankapi.models.api_v_1_buy_notes_request import ApiV1BuyNotesRequest

api_v_1_buy_notes_request = ApiV1BuyNotesRequest(
    amount_cents=1000
)
```

