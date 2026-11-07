
# Invoice

## Structure

`Invoice`

## Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `client_email` | `str` | Required | **Constraints**: *Pattern*: `^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$` |
| `amount_cents` | `int` | Required | **Constraints**: `>= 1`, `<= 9007199254740991` |
| `due_in_days` | `int` | Required | **Constraints**: `>= 1`, `<= 60` |
| `description` | `str` | Required | **Constraints**: *Minimum Length*: `1`, *Maximum Length*: `500` |

## Example

```python
from mandatebankapi.models.invoice import Invoice

invoice = Invoice(
    client_email='client_email0',
    amount_cents=138,
    due_in_days=60,
    description='description4'
)
```

