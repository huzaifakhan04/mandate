# Envelope

Source: /#/python/x-redirect/JTI0bSUyRkVudmVsb3Bl


# Class Name

`Envelope`


# Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `status` | `str` | Required | - |
| `summary` | `str` | Required | - |
| `reason_codes` | `List[str]` | Required | - |
| `data` | `Any` | Required | - |
| `next_actions` | [`List[NextAction]`](/llms-pages/python/models/structures/next-action.md) | Required | - |
| `docs_url` | `str` | Required | - |


# Example

```python
import jsonpickle

from mandatebankapi.models.envelope import Envelope
from mandatebankapi.models.next_action import NextAction

envelope = Envelope(
    status='status4',
    summary='summary4',
    reason_codes=[
        'reason_codes3',
        'reason_codes4',
        'reason_codes5'
    ],
    data=jsonpickle.decode('{"key1":"val1","key2":"val2"}'),
    next_actions=[
        NextAction(
            tool='tool4',
            args=jsonpickle.decode('{"key1":"val1","key2":"val2"}')
        )
    ],
    docs_url='docs_url4'
)
```



