
# Api V1 Repay Loan Request

## Structure

`ApiV1RepayLoanRequest`

## Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `loan_id` | `uuid\|str` | Required | - |
| `amount_cents` | `int` | Optional | **Constraints**: `>= 1`, `<= 9007199254740991` |

## Example

```python
from mandatebankapi.models.api_v_1_repay_loan_request import ApiV1RepayLoanRequest

api_v_1_repay_loan_request = ApiV1RepayLoanRequest(
    loan_id='000002ac-0000-0000-0000-000000000000',
    amount_cents=202
)
```

