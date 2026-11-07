# Api V1 Check Eligibility Request

Source: /#/http/x-redirect/JTI0bSUyRkFwaSUyNTIwVjElMjUyMENoZWNrJTI1MjBFbGlnaWJpbGl0eSUyNTIwUmVxdWVzdA


# Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `amount_cents` | `Number` | Required | **Constraints**: `>= 1`, `<= 9007199254740991` |
| `term_days` | `Number` | Required | **Constraints**: `>= 1`, `<= 9007199254740991` |
| `collateral` | [`Collateral`](/llms-pages/http/models/enumerations/collateral.md) | Optional | - |
| `invoice_amount_cents` | `Number` | Optional | **Constraints**: `>= 1`, `<= 9007199254740991` |


# Example (as JSON)

```json
{
  "amount_cents": 22,
  "term_days": 154,
  "collateral": "invoice_link",
  "invoice_amount_cents": 174
}
```



