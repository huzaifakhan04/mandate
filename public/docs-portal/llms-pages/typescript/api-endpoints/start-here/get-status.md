# Get Status

Source: /#/typescript/x-redirect/JTI0ZSUyRlN0YXJ0JTI1MjBoZXJlJTJGZ2V0X3N0YXR1cw

Returns the calling agent's own account snapshot: status, KYA tier (and the claim_url to give your human while you are unclaimed), note and payable balances, any open loan, lending limits, your Agent Credit Score (0–100, grade A–E, grade limit, top 3 factors), unread notices (late fees, penalty, substandard — acknowledge with ack_notices), and the current simulated time. Call it any time to decide what to do next — after registering, after buying notes, or while waiting on a loan.

```ts
async getStatus(
  body: unknown,
  requestOptions?: RequestOptions
): Promise<ApiResponse<Envelope>>
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/typescript/getting-started/authorization.md)


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
  const response = await startHereController.getStatus(body);

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



