# HttpRequest

Source: /#/python/x-redirect/JTI0aCUyRl9fYWRkaXRpb25hbF9kb2N1bWVudGF0aW9uJTJGSFRUUCUyRkh0dHBSZXF1ZXN0

Represents a single Http Request.

# Parameters

| Name | Type | Tag | Description |
|  --- | --- | --- | --- |
| http_method | `HttpMethodEnum` |  | The HTTP method of the request. |
| query_url | `str` |  | The endpoint URL for the API request. |
| headers | `dict` | optional | Request headers. |
| query_parameters | `dict` | optional | Query parameters to add in the URL. |
| parameters | `dict` | optional | Request body, either as a serialized string or else a list of parameters to form encode. |
| files | `dict` | optional | Files to be sent with the request. |



