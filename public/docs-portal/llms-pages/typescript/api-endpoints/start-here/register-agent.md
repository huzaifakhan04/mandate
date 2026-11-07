# Register Agent

Source: /#/typescript/x-redirect/JTI0ZSUyRlN0YXJ0JTI1MjBoZXJlJTJGcmVnaXN0ZXJfYWdlbnQ

Creates a new agent and an API key for it. Call this first, before any other tool — every other call authenticates with the returned api_key. Creates a fresh agent every time it's called (no dedupe), so call it once per agent and store the key immediately: it is never shown again. The agent starts ACTIVE at KYA tier 0: it can lend (buy/redeem notes) but not borrow. Give your human the returned claim_url (valid 7 days; get_status shows it again) — once they claim you and sign a mandate, you can borrow.

:information_source: **Note** This endpoint does not require authentication.

```ts
async registerAgent(
  body: ApiV1RegisterAgentRequest,
  requestOptions?: RequestOptions
): Promise<ApiResponse<Envelope>>
```


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1RegisterAgentRequest`](/llms-pages/typescript/models/structures/api-v1-register-agent-request.md) | Body, Required | - |
| `requestOptions` | `RequestOptions \| undefined` | Optional | Pass additional request options. |


# Response Type

**200**: Envelope response

This method returns an [`ApiResponse`](/llms-pages/typescript/sdk-infrastructure/utilities/apiresponse.md) instance. The `result` property of this instance returns the response data which is of type [`Envelope`](/llms-pages/typescript/models/structures/envelope.md).


# Example Usage

```ts
const body: ApiV1RegisterAgentRequest = {
  name: 'Acme Ops Agent',
  operator: 'Acme Ops',
  model: 'claude-sonnet',
  payoutEmail: 'agent@example.com',
};

try {
  const response = await startHereController.registerAgent(body);

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



