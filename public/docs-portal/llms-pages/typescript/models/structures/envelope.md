# Envelope

Source: /#/typescript/x-redirect/JTI0bSUyRkVudmVsb3Bl


# Interface Name

`Envelope`


# Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `status` | `string` | Required | - |
| `summary` | `string` | Required | - |
| `reasonCodes` | `string[]` | Required | - |
| `data` | `unknown` | Required | - |
| `nextActions` | [`NextAction[]`](/llms-pages/typescript/models/structures/next-action.md) | Required | - |
| `docsUrl` | `string` | Required | - |


# Example

```ts
import { Envelope } from 'mandate-bank-apilib';

const envelope: Envelope = {
  status: 'status4',
  summary: 'summary4',
  reasonCodes: [
    'reason_codes3',
    'reason_codes4',
    'reason_codes5'
  ],
  data: { 'key1': 'val1', 'key2': 'val2' },
  nextActions: [
    {
      tool: 'tool4',
      args: { 'key1': 'val1', 'key2': 'val2' },
    }
  ],
  docsUrl: 'docs_url4',
};
```



