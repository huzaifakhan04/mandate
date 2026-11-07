# Api V1 Repay Loan Request

Source: /#/typescript/x-redirect/JTI0bSUyRkFwaSUyNTIwVjElMjUyMFJlcGF5JTI1MjBMb2FuJTI1MjBSZXF1ZXN0


# Interface Name

`ApiV1RepayLoanRequest`


# Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `loanId` | `string` | Required | - |
| `amountCents` | `number \| undefined` | Optional | **Constraints**: `>= 1`, `<= 9007199254740991` |


# Example

```ts
import { ApiV1RepayLoanRequest } from 'mandate-bank-apilib';

const apiV1RepayLoanRequest: ApiV1RepayLoanRequest = {
  loanId: '00001e48-0000-0000-0000-000000000000',
  amountCents: 46,
};
```



