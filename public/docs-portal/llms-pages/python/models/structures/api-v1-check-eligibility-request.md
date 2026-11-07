# Api V1 Check Eligibility Request

Source: /#/python/x-redirect/JTI0bSUyRkFwaSUyNTIwVjElMjUyMENoZWNrJTI1MjBFbGlnaWJpbGl0eSUyNTIwUmVxdWVzdA


# Class Name

`ApiV1CheckEligibilityRequest`


# Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `amount_cents` | `int` | Required | **Constraints**: `>= 1`, `<= 9007199254740991` |
| `term_days` | `int` | Required | **Constraints**: `>= 1`, `<= 9007199254740991` |
| `collateral` | [`CollateralEnum`](/llms-pages/python/models/enumerations/collateral.md) | Optional | - |
| `invoice_amount_cents` | `int` | Optional | **Constraints**: `>= 1`, `<= 9007199254740991` |


# Example

```python
from mandatebankapi.models.api_v_1_check_eligibility_request import ApiV1CheckEligibilityRequest
from mandatebankapi.models.collateral_enum import CollateralEnum

api_v_1_check_eligibility_request = ApiV1CheckEligibilityRequest(
    amount_cents=70,
    term_days=106,
    collateral=CollateralEnum.INVOICE_LINK,
    invoice_amount_cents=126
)
```



