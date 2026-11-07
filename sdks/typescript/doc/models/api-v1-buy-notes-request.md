
# Api V1 Buy Notes Request

## Structure

`ApiV1BuyNotesRequest`

## Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `amountCents` | `number` | Required | **Constraints**: `>= 1000`, `<= 100000` |

## Example

```ts
import { ApiV1BuyNotesRequest } from 'mandate-bank-apilib';

const apiV1BuyNotesRequest: ApiV1BuyNotesRequest = {
  amountCents: 1000,
};
```

