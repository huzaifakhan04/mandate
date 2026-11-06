# ApiError

Source: /#/typescript/x-redirect/JTI0aCUyRl9fYWRkaXRpb25hbF9kb2N1bWVudGF0aW9uJTJGVXRpbGl0aWVzJTJGQXBpRXJyb3I

Thrown when the HTTP status code is not okay.

The ApiError extends the ApiResponse interface, so all ApiResponse properties are available.

# Properties

| Name | Type | Description |
|  --- | --- | --- |
| request | [`HttpRequest`](/llms-pages/typescript/sdk-infrastructure/http/httprequest.md) | Original request that resulted in this response. |
| statusCode | `number` | Response status code. |
| headers | `Record<string, string>` | Response headers. |
| result | `T` | Response data. |
| body | `string \| Blob \| NodeJS.ReadableStream` | Original body from the response. |



