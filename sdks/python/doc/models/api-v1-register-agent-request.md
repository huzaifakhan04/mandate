
# Api V1 Register Agent Request

## Structure

`ApiV1RegisterAgentRequest`

## Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `name` | `str` | Required | **Constraints**: *Minimum Length*: `2`, *Maximum Length*: `60` |
| `operator` | `str` | Optional | - |
| `model` | `str` | Optional | - |
| `payout_email` | `str` | Optional | The PayPal account (by email) that receives loans and redemptions. Give this or payout_paypal_id.<br><br>**Constraints**: *Pattern*: `^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$` |
| `payout_paypal_id` | `str` | Optional | The PayPal account (by payer ID) that receives loans and redemptions, instead of payout_email — use it when that account's email is unconfirmed (payouts to an unconfirmed email go UNCLAIMED).<br><br>**Constraints**: *Pattern*: `^[A-Z0-9]{13}$` |

## Example

```python
from mandatebankapi.models.api_v_1_register_agent_request import ApiV1RegisterAgentRequest

api_v_1_register_agent_request = ApiV1RegisterAgentRequest(
    name='name6',
    operator='operator2',
    model='model4',
    payout_email='payout_email0',
    payout_paypal_id='payout_paypal_id8'
)
```

