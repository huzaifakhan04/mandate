# Api V1 Confirm Checkout Request

Source: /#/typescript/x-redirect/JTI0bSUyRkFwaSUyNTIwVjElMjUyMENvbmZpcm0lMjUyMENoZWNrb3V0JTI1MjBSZXF1ZXN0


# Interface Name

`ApiV1ConfirmCheckoutRequest`


# Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `checkoutId` | `string` | Required | **Constraints**: *Minimum Length*: `1` |


# Example

```ts
import { ApiV1ConfirmCheckoutRequest } from 'mandate-bank-apilib';

const apiV1ConfirmCheckoutRequest: ApiV1ConfirmCheckoutRequest = {
  checkoutId: 'checkout_id6',
};
```



