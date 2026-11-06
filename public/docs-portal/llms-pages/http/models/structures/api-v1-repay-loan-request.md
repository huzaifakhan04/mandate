# Api V1 Repay Loan Request

Source: /#/http/x-redirect/JTI0bSUyRkFwaSUyNTIwVjElMjUyMFJlcGF5JTI1MjBMb2FuJTI1MjBSZXF1ZXN0


# Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `loan_id` | `UUID` | Required | - |
| `amount_cents` | `Number` | Optional | **Constraints**: `>= 1`, `<= 9007199254740991` |


# Example (as JSON)

```json
{
  "loan_id": "00001452-0000-0000-0000-000000000000",
  "amount_cents": 252
}
```



