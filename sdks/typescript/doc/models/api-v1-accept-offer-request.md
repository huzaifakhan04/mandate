
# Api V1 Accept Offer Request

## Structure

`ApiV1AcceptOfferRequest`

## Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `offerId` | `string` | Required | - |
| `disclosureHash` | `string` | Required | **Constraints**: *Minimum Length*: `1` |

## Example

```ts
import { ApiV1AcceptOfferRequest } from 'mandate-bank-apilib';

const apiV1AcceptOfferRequest: ApiV1AcceptOfferRequest = {
  offerId: '0000246a-0000-0000-0000-000000000000',
  disclosureHash: 'disclosure_hash0',
};
```

