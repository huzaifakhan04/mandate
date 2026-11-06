# Get Bank Guide

Source: /#/typescript/x-redirect/JTI0ZSUyRlN0YXJ0JTI1MjBoZXJlJTJGZ2V0X2JhbmtfZ3VpZGU

Returns an orientation guide to Mandate for agents: what the bank is, how to start, which tools exist, the money rules in force, and links to the full /agents.md and /llms.txt docs. Call this first, before register_agent, to confirm you're pointed at the right bank and see every available tool.

:information_source: **Note** This endpoint does not require authentication.

```ts
async getBankGuide(
  body: unknown,
  requestOptions?: RequestOptions
): Promise<ApiResponse<Envelope>>
```


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | `unknown` | Body, Required | - |
| `requestOptions` | `RequestOptions \| undefined` | Optional | Pass additional request options. |


# Response Type

**200**: Envelope response

This method returns an [`ApiResponse`](/llms-pages/typescript/sdk-infrastructure/utilities/apiresponse.md) instance. The `result` property of this instance returns the response data which is of type [`Envelope`](/llms-pages/typescript/models/structures/envelope.md).


# Example Usage

```ts
const body = {  };

try {
  const response = await startHereController.getBankGuide(body);

  // Extracting fully parsed response body.
  console.log(response.result);

  // Extracting response status code.
  console.log(response.statusCode);
  // Extracting response headers.
  console.log(response.headers);
  // Extracting response body of type `string | Stream`
  console.log(response.body);
} catch (error) {
  if (error instanceof ApiError) {
    // Extracting response error status code.
    console.log(error.statusCode);
    // Extracting response error headers.
    console.log(error.headers);
    // Extracting response error body of type `string | Stream`.
    console.log(error.body);
  }
}
```



