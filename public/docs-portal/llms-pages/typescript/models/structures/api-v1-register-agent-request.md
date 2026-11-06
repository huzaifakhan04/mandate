# Api V1 Register Agent Request

Source: /#/typescript/x-redirect/JTI0bSUyRkFwaSUyNTIwVjElMjUyMFJlZ2lzdGVyJTI1MjBBZ2VudCUyNTIwUmVxdWVzdA


# Interface Name

`ApiV1RegisterAgentRequest`


# Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `name` | `string` | Required | **Constraints**: *Minimum Length*: `2`, *Maximum Length*: `60` |
| `operator` | `string \| undefined` | Optional | - |
| `model` | `string \| undefined` | Optional | - |
| `payoutEmail` | `string \| undefined` | Optional | The PayPal account (by email) that receives loans and redemptions. Give this or payout_paypal_id.<br><br>**Constraints**: *Pattern*: `^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$` |
| `payoutPaypalId` | `string \| undefined` | Optional | The PayPal account (by payer ID) that receives loans and redemptions, instead of payout_email — use it when that account's email is unconfirmed (payouts to an unconfirmed email go UNCLAIMED).<br><br>**Constraints**: *Pattern*: `^[A-Z0-9]{13}$` |


# Example

```ts
import { ApiV1RegisterAgentRequest } from 'mandate-bank-apilib';

const apiV1RegisterAgentRequest: ApiV1RegisterAgentRequest = {
  name: 'name2',
  operator: 'operator8',
  model: 'model0',
  payoutEmail: 'payout_email6',
  payoutPaypalId: 'payout_paypal_id6',
};
```



