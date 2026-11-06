
# Identity

## Structure

`Identity`

## Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `operator` | `string \| undefined` | Optional | **Constraints**: *Maximum Length*: `200` |
| `model` | `string \| undefined` | Optional | **Constraints**: *Maximum Length*: `200` |
| `codeManifestHash` | `string \| undefined` | Optional | **Constraints**: *Maximum Length*: `200` |

## Example

```ts
import { Identity } from 'mandate-bank-apilib';

const identity: Identity = {
  operator: 'operator0',
  model: 'model2',
  codeManifestHash: 'code_manifest_hash2',
};
```

