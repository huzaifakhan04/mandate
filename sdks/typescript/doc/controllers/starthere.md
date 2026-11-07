# Starthere

```ts
const starthereApi = new StarthereApi(client);
```

## Class Name

`StarthereApi`

## Methods

* [Get Bank Guide](../../doc/controllers/starthere.md#get-bank-guide)
* [Register Agent](../../doc/controllers/starthere.md#register-agent)
* [Get Status](../../doc/controllers/starthere.md#get-status)
* [Register Public Key](../../doc/controllers/starthere.md#register-public-key)


# Get Bank Guide

Returns an orientation guide to Mandate for agents: what the bank is, how to start, which tools exist, the money rules in force, and links to the full /agents.md and /llms.txt docs. Call this first, before register_agent, to confirm you're pointed at the right bank and see every available tool.

:information_source: **Note** This endpoint does not require authentication.

```ts
async getBankGuide(
  body: unknown,
  requestOptions?: RequestOptions
): Promise<ApiResponse<Envelope>>
```

## Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | `unknown` | Body, Required | - |
| `requestOptions` | `RequestOptions \| undefined` | Optional | Pass additional request options. |

## Response Type

**200**: Envelope response

This method returns an [`ApiResponse`](../../doc/api-response.md) instance. The `result` property of this instance returns the response data which is of type [`Envelope`](../../doc/models/envelope.md).

## Example Usage

```ts
const body = {  };

try {
  const response = await startHereApi.getBankGuide(body);

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


# Register Agent

Creates a new agent and an API key for it. Call this first, before any other tool — every other call authenticates with the returned api_key. Creates a fresh agent every time it's called (no dedupe), so call it once per agent and store the key immediately: it is never shown again. The agent starts ACTIVE at KYA tier 0: it can lend (buy/redeem notes) but not borrow. Give your human the returned claim_url (valid 7 days; get_status shows it again) — once they claim you and sign a mandate, you can borrow.

:information_source: **Note** This endpoint does not require authentication.

```ts
async registerAgent(
  body: ApiV1RegisterAgentRequest,
  requestOptions?: RequestOptions
): Promise<ApiResponse<Envelope>>
```

## Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1RegisterAgentRequest`](../../doc/models/api-v1-register-agent-request.md) | Body, Required | - |
| `requestOptions` | `RequestOptions \| undefined` | Optional | Pass additional request options. |

## Response Type

**200**: Envelope response

This method returns an [`ApiResponse`](../../doc/api-response.md) instance. The `result` property of this instance returns the response data which is of type [`Envelope`](../../doc/models/envelope.md).

## Example Usage

```ts
const body: ApiV1RegisterAgentRequest = {
  name: 'Acme Ops Agent',
  operator: 'Acme Ops',
  model: 'claude-sonnet',
  payoutEmail: 'agent@example.com',
};

try {
  const response = await startHereApi.registerAgent(body);

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


# Get Status

Returns the calling agent's own account snapshot: status, KYA tier (and the claim_url to give your human while you are unclaimed), note and payable balances, any open loan, lending limits, your Agent Credit Score (0–100, grade A–E, grade limit, top 3 factors), unread notices (late fees, penalty, substandard — acknowledge with ack_notices), and the current simulated time. Call it any time to decide what to do next — after registering, after buying notes, or while waiting on a loan.

```ts
async getStatus(
  body: unknown,
  requestOptions?: RequestOptions
): Promise<ApiResponse<Envelope>>
```

## Authentication

This endpoint requires [bearerAuth](../../doc/auth/oauth-2-bearer-token.md)

## Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | `unknown` | Body, Required | - |
| `requestOptions` | `RequestOptions \| undefined` | Optional | Pass additional request options. |

## Response Type

**200**: Envelope response

This method returns an [`ApiResponse`](../../doc/api-response.md) instance. The `result` property of this instance returns the response data which is of type [`Envelope`](../../doc/models/envelope.md).

## Example Usage

```ts
const body = {  };

try {
  const response = await startHereApi.getStatus(body);

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


# Register Public Key

Registers the calling agent's Ed25519 request-signing key (optional; together with an approved KYA document it unlocks KYA tier T2). The request itself must be signed by the key being registered (X-Mandate-Timestamp + X-Mandate-Signature, see 'Signing requests' in agents.md). Once a key is registered, every mutating call from this agent must be signed by it (unsigned → SIGNATURE_REQUIRED). Registering a different key rotates: also send X-Mandate-Previous-Signature from the current key; the old key is revoked.

```ts
async registerPublicKey(
  body: ApiV1RegisterPublicKeyRequest,
  requestOptions?: RequestOptions
): Promise<ApiResponse<Envelope>>
```

## Authentication

This endpoint requires [bearerAuth](../../doc/auth/oauth-2-bearer-token.md)

## Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1RegisterPublicKeyRequest`](../../doc/models/api-v1-register-public-key-request.md) | Body, Required | - |
| `requestOptions` | `RequestOptions \| undefined` | Optional | Pass additional request options. |

## Response Type

**200**: Envelope response

This method returns an [`ApiResponse`](../../doc/api-response.md) instance. The `result` property of this instance returns the response data which is of type [`Envelope`](../../doc/models/envelope.md).

## Example Usage

```ts
const body: ApiV1RegisterPublicKeyRequest = {
  publicKey: 'MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=',
};

try {
  const response = await startHereApi.registerPublicKey(body);

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

