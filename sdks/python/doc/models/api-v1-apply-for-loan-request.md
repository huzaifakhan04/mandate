
# Api V1 Apply for Loan Request

## Structure

`ApiV1ApplyForLoanRequest`

## Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `identity` | [`Identity`](../../doc/models/identity.md) | Optional | - |
| `amount_cents` | `int` | Required | **Constraints**: `>= 1`, `<= 9007199254740991` |
| `term_days` | `int` | Required | **Constraints**: `>= 1`, `<= 9007199254740991` |
| `purpose` | `str` | Required | **Constraints**: *Minimum Length*: `5`, *Maximum Length*: `200` |
| `invoice` | [`Invoice`](../../doc/models/invoice.md) | Optional | - |
| `declarations` | [`Declarations`](../../doc/models/declarations.md) | Optional | - |
| `consent_bank_records` | `bool` | Optional | - |
| `mandate_version` | `int` | Optional | **Constraints**: `>= 1`, `<= 9007199254740991` |
| `attest` | `bool` | Optional | - |

## Example

```python
from mandatebankapi.models.api_v_1_apply_for_loan_request import ApiV1ApplyForLoanRequest
from mandatebankapi.models.declarations import Declarations
from mandatebankapi.models.identity import Identity
from mandatebankapi.models.invoice import Invoice

api_v_1_apply_for_loan_request = ApiV1ApplyForLoanRequest(
    amount_cents=66,
    term_days=242,
    purpose='purpose6',
    identity=Identity(
        operator='operator0',
        model='model2',
        code_manifest_hash='code_manifest_hash2'
    ),
    invoice=Invoice(
        client_email='client_email0',
        amount_cents=138,
        due_in_days=60,
        description='description4'
    ),
    declarations=Declarations(
        no_other_debt=False
    ),
    consent_bank_records=False,
    mandate_version=242
)
```

