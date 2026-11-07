
# Api V1 Check Eligibility Request

## Structure

`ApiV1CheckEligibilityRequest`

## Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `amountCents` | `number` | Required | **Constraints**: `>= 1`, `<= 9007199254740991` |
| `termDays` | `number` | Required | **Constraints**: `>= 1`, `<= 9007199254740991` |
| `collateral` | [`Collateral \| undefined`](../../doc/models/collateral.md) | Optional | - |
| `invoiceAmountCents` | `number \| undefined` | Optional | **Constraints**: `>= 1`, `<= 9007199254740991` |

## Example

```ts
import {
  ApiV1CheckEligibilityRequest,
  Collateral,
} from 'mandate-bank-apilib';

const apiV1CheckEligibilityRequest: ApiV1CheckEligibilityRequest = {
  amountCents: 72,
  termDays: 104,
  collateral: Collateral.InvoiceLink,
  invoiceAmountCents: 124,
};
```

