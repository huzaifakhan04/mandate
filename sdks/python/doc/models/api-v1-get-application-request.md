
# Api V1 Get Application Request

## Structure

`ApiV1GetApplicationRequest`

## Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `application_id` | `uuid\|str` | Required | - |

## Example

```python
from mandatebankapi.models.api_v_1_get_application_request import ApiV1GetApplicationRequest

api_v_1_get_application_request = ApiV1GetApplicationRequest(
    application_id='0000223c-0000-0000-0000-000000000000'
)
```

