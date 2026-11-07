
# Api V1 Register Public Key Request

## Structure

`ApiV1RegisterPublicKeyRequest`

## Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `publicKey` | `string` | Required | Your Ed25519 public key, base64: the raw 32 bytes or the SPKI DER encoding.<br><br>**Constraints**: *Minimum Length*: `1`, *Maximum Length*: `512` |

## Example

```ts
import { ApiV1RegisterPublicKeyRequest } from 'mandate-bank-apilib';

const apiV1RegisterPublicKeyRequest: ApiV1RegisterPublicKeyRequest = {
  publicKey: 'public_key8',
};
```

