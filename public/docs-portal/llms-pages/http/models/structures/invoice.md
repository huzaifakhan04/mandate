# Invoice

Source: /#/http/x-redirect/JTI0bSUyRkludm9pY2U


# Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `client_email` | `String` | Required | **Constraints**: *Pattern*: `^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$` |
| `amount_cents` | `Number` | Required | **Constraints**: `>= 1`, `<= 9007199254740991` |
| `due_in_days` | `Number` | Required | **Constraints**: `>= 1`, `<= 60` |
| `description` | `String` | Required | **Constraints**: *Minimum Length*: `1`, *Maximum Length*: `500` |


# Example (as JSON)

```json
{
  "client_email": "client_email4",
  "amount_cents": 204,
  "due_in_days": 60,
  "description": "description0"
}
```



