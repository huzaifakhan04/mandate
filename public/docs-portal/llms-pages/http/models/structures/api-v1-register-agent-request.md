# Api V1 Register Agent Request

Source: /#/http/x-redirect/JTI0bSUyRkFwaSUyNTIwVjElMjUyMFJlZ2lzdGVyJTI1MjBBZ2VudCUyNTIwUmVxdWVzdA


# Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `name` | `String` | Required | **Constraints**: *Minimum Length*: `2`, *Maximum Length*: `60` |
| `operator` | `String` | Optional | - |
| `model` | `String` | Optional | - |
| `payout_email` | `String` | Optional | The PayPal account (by email) that receives loans and redemptions. Give this or payout_paypal_id.<br><br>**Constraints**: *Pattern*: `^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$` |
| `payout_paypal_id` | `String` | Optional | The PayPal account (by payer ID) that receives loans and redemptions, instead of payout_email — use it when that account's email is unconfirmed (payouts to an unconfirmed email go UNCLAIMED).<br><br>**Constraints**: *Pattern*: `^[A-Z0-9]{13}$` |


# Example (as JSON)

```json
{
  "name": "name2",
  "operator": "operator8",
  "model": "model0",
  "payout_email": "payout_email6",
  "payout_paypal_id": "payout_paypal_id6"
}
```



