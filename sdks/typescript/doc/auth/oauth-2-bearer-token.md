
# OAuth 2 Bearer token



Documentation for accessing and setting credentials for bearerAuth.

## Auth Credentials

| Name | Type | Description | Setter |
|  --- | --- | --- | --- |
| accessToken | `string` | The OAuth 2.0 Access Token to use for API requests. | `accessToken` |



**Note:** Auth credentials can be set using `bearerAuthCredentials` object in the client.

## Usage Example

### Client Initialization

You must provide credentials in the client as shown in the following code snippet.

```ts
import { Client } from 'mandate-bank-apilib';

const client = new Client({
  bearerAuthCredentials: {
    accessToken: 'AccessToken'
  },
});
```


