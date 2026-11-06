
# Api V1 Redeem Notes Request

## Structure

`ApiV1RedeemNotesRequest`

## Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `amountCents` | `number` | Required | **Constraints**: `>= 1`, `<= 9007199254740991` |

## Example

```ts
import { ApiV1RedeemNotesRequest } from 'mandate-bank-apilib';

const apiV1RedeemNotesRequest: ApiV1RedeemNotesRequest = {
  amountCents: 28,
};
```

