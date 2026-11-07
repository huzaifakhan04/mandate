# Next Action

Source: /#/python/x-redirect/JTI0bSUyRk5leHRBY3Rpb24


# Class Name

`NextAction`


# Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `tool` | `str` | Required | - |
| `args` | `Any` | Required | - |


# Example

```python
import jsonpickle

from mandatebankapi.models.next_action import NextAction

next_action = NextAction(
    tool='tool6',
    args=jsonpickle.decode('{"key1":"val1","key2":"val2"}')
)
```



