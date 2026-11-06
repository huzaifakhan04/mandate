
# Api V1 Ack Notices Request

## Structure

`ApiV1AckNoticesRequest`

## Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `notice_ids` | `List[uuid\|str]` | Optional | **Constraints**: *Minimum Items*: `1`, *Maximum Items*: `100` |

## Example

```python
from mandatebankapi.models.api_v_1_ack_notices_request import ApiV1AckNoticesRequest

api_v_1_ack_notices_request = ApiV1AckNoticesRequest(
    notice_ids=[
        '00001ea4-0000-0000-0000-000000000000'
    ]
)
```

