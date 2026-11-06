# Api V1 Apply for Loan Request

Source: /#/http/x-redirect/JTI0bSUyRkFwaSUyNTIwVjElMjUyMEFwcGx5JTI1MjBGb3IlMjUyMExvYW4lMjUyMFJlcXVlc3Q


# Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `identity` | [`Identity`](/llms-pages/http/models/structures/identity.md) | Optional | - |
| `amount_cents` | `Number` | Required | **Constraints**: `>= 1`, `<= 9007199254740991` |
| `term_days` | `Number` | Required | **Constraints**: `>= 1`, `<= 9007199254740991` |
| `purpose` | `String` | Required | **Constraints**: *Minimum Length*: `5`, *Maximum Length*: `200` |
| `invoice` | [`Invoice`](/llms-pages/http/models/structures/invoice.md) | Optional | - |
| `declarations` | [`Declarations`](/llms-pages/http/models/structures/declarations.md) | Optional | - |
| `consent_bank_records` | `Boolean` | Optional | - |
| `mandate_version` | `Number` | Optional | **Constraints**: `>= 1`, `<= 9007199254740991` |
| `attest` | `Boolean` | Optional | - |


# Example (as JSON)

```json
{
  "identity": {
    "operator": "operator0",
    "model": "model2",
    "code_manifest_hash": "code_manifest_hash2"
  },
  "amount_cents": 162,
  "term_days": 82,
  "purpose": "purpose0",
  "invoice": {
    "client_email": "client_email0",
    "amount_cents": 138,
    "due_in_days": 60,
    "description": "description4"
  },
  "declarations": {
    "no_other_debt": false
  },
  "consent_bank_records": false,
  "mandate_version": 82
}
```



