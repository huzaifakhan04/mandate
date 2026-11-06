# Api V1 Ack Notices Request

Source: /#/typescript/x-redirect/JTI0bSUyRkFwaSUyNTIwVjElMjUyMEFjayUyNTIwTm90aWNlcyUyNTIwUmVxdWVzdA


# Interface Name

`ApiV1AckNoticesRequest`


# Fields

| Name | Type | Tags | Description |
|  --- | --- | --- | --- |
| `noticeIds` | `string[] \| undefined` | Optional | **Constraints**: *Minimum Items*: `1`, *Maximum Items*: `100` |


# Example

```ts
import { ApiV1AckNoticesRequest } from 'mandate-bank-apilib';

const apiV1AckNoticesRequest: ApiV1AckNoticesRequest = {
  noticeIds: [
    '000026b8-0000-0000-0000-000000000000'
  ],
};
```



