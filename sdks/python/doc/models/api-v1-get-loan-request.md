
# Api V1 Get Loan Request

## Structure

`ApiV1GetLoanRequest`

## Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `loan_id` | `uuid\|str` | Required | - |

## Example

```python
from mandatebankapi.models.api_v_1_get_loan_request import ApiV1GetLoanRequest

api_v_1_get_loan_request = ApiV1GetLoanRequest(
    loan_id='00000db0-0000-0000-0000-000000000000'
)
```

