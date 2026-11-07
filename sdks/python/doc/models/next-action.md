
# Next Action

*This model accepts additional fields of type Any.*

## Structure

`NextAction`

## Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `tool` | `str` | Required | - |
| `args` | `Any` | Required | - |
| `additional_properties` | `Dict[str, Any]` | Optional | - |

## Example

```python
import jsonpickle

from mandatebankapi.models.next_action import NextAction

next_action = NextAction(
    tool='tool6',
    args=jsonpickle.decode('{"key1":"val1","key2":"val2"}'),
    additional_properties={
        'exampleAdditionalProperty': jsonpickle.decode('{"key1":"val1","key2":"val2"}')
    }
)
```

