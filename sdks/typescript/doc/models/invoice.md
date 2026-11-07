
# Invoice

## Structure

`Invoice`

## Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `clientEmail` | `string` | Required | **Constraints**: *Pattern*: `^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$` |
| `amountCents` | `number` | Required | **Constraints**: `>= 1`, `<= 9007199254740991` |
| `dueInDays` | `number` | Required | **Constraints**: `>= 1`, `<= 60` |
| `description` | `string` | Required | **Constraints**: *Minimum Length*: `1`, *Maximum Length*: `500` |

## Example

```ts
import { Invoice } from 'mandate-bank-apilib';

const invoice: Invoice = {
  clientEmail: 'client_email0',
  amountCents: 138,
  dueInDays: 60,
  description: 'description4',
};
```

