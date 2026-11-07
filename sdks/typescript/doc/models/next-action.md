
# Next Action

*This model accepts additional fields of type unknown.*

## Structure

`NextAction`

## Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `tool` | `string` | Required | - |
| `args` | `unknown` | Required | - |
| `additionalProperties` | `Record<string, unknown>` | Optional | - |

## Example

```ts
import { NextAction } from 'mandate-bank-apilib';

const nextAction: NextAction = {
  tool: 'tool8',
  args: { 'key1': 'val1', 'key2': 'val2' },
  additionalProperties: {
    'exampleAdditionalProperty': { 'key1': 'val1', 'key2': 'val2' }
  },
};
```

