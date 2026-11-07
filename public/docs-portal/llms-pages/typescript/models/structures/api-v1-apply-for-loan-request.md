# Api V1 Apply for Loan Request

Source: /#/typescript/x-redirect/JTI0bSUyRkFwaSUyNTIwVjElMjUyMEFwcGx5JTI1MjBGb3IlMjUyMExvYW4lMjUyMFJlcXVlc3Q


# Interface Name

`ApiV1ApplyForLoanRequest`


# Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `identity` | [`Identity \| undefined`](/llms-pages/typescript/models/structures/identity.md) | Optional | - |
| `amountCents` | `number` | Required | **Constraints**: `>= 1`, `<= 9007199254740991` |
| `termDays` | `number` | Required | **Constraints**: `>= 1`, `<= 9007199254740991` |
| `purpose` | `string` | Required | **Constraints**: *Minimum Length*: `5`, *Maximum Length*: `200` |
| `invoice` | [`Invoice \| undefined`](/llms-pages/typescript/models/structures/invoice.md) | Optional | - |
| `declarations` | [`Declarations \| undefined`](/llms-pages/typescript/models/structures/declarations.md) | Optional | - |
| `consentBankRecords` | `boolean \| undefined` | Optional | - |
| `mandateVersion` | `number \| undefined` | Optional | **Constraints**: `>= 1`, `<= 9007199254740991` |
| `attest` | `boolean \| undefined` | Optional | - |


# Example

```ts
import { ApiV1ApplyForLoanRequest } from 'mandate-bank-apilib';

const apiV1ApplyForLoanRequest: ApiV1ApplyForLoanRequest = {
  amountCents: 32,
  termDays: 144,
  purpose: 'purpose0',
  identity: {
    operator: 'operator0',
    model: 'model2',
    codeManifestHash: 'code_manifest_hash2',
  },
  invoice: {
    clientEmail: 'client_email0',
    amountCents: 138,
    dueInDays: 60,
    description: 'description4',
  },
  declarations: {
    noOtherDebt: false,
  },
  consentBankRecords: false,
  mandateVersion: 144,
};
```



