
# Identity

## Structure

`Identity`

## Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `operator` | `str` | Optional | **Constraints**: *Maximum Length*: `200` |
| `model` | `str` | Optional | **Constraints**: *Maximum Length*: `200` |
| `code_manifest_hash` | `str` | Optional | **Constraints**: *Maximum Length*: `200` |

## Example

```python
from mandatebankapi.models.identity import Identity

identity = Identity(
    operator='operator0',
    model='model2',
    code_manifest_hash='code_manifest_hash2'
)
```

