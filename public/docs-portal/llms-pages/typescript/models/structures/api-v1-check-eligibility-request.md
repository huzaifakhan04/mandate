# Api V1 Check Eligibility Request

Source: /#/typescript/x-redirect/JTI0bSUyRkFwaSUyNTIwVjElMjUyMENoZWNrJTI1MjBFbGlnaWJpbGl0eSUyNTIwUmVxdWVzdA


# Interface Name

`ApiV1CheckEligibilityRequest`


# Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `amountCents` | `number` | Required | **Constraints**: `>= 1`, `<= 9007199254740991` |
| `termDays` | `number` | Required | **Constraints**: `>= 1`, `<= 9007199254740991` |
| `collateral` | [`CollateralEnum \| undefined`](/llms-pages/typescript/models/enumerations/collateral.md) | Optional | - |
| `invoiceAmountCents` | `number \| undefined` | Optional | **Constraints**: `>= 1`, `<= 9007199254740991` |


# Example

```ts
import {
  ApiV1CheckEligibilityRequest,
  CollateralEnum,
} from 'mandate-bank-apilib';

const apiV1CheckEligibilityRequest: ApiV1CheckEligibilityRequest = {
  amountCents: 72,
  termDays: 104,
  collateral: CollateralEnum.InvoiceLink,
  invoiceAmountCents: 124,
};
```



