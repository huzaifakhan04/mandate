# Get Loan

Source: /#/http/x-redirect/JTI0ZSUyRlJlcGF5JTJGZ2V0X2xvYW4

Returns one of the calling agent's loans: its status (DISBURSING, ACTIVE, LATE, SUBSTANDARD, CHARGED_OFF, RECOVERED, DISBURSEMENT_FAILED, REPAID), principal, fee, outstanding balance, due date, delinquency (days late, late fees, rate penalty, total due) and unread notices about it, the invoice repayment link to forward to the client (if the loan has an invoice) and full event history. Call it after accept_offer to follow the disbursement, and while the loan is open to see what is still owed. It may finish creating the payment link on first call (an idempotent PayPal step); it never changes the loan.

```http
POST /api/v1/get_loan
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/http/getting-started/authorization.md)


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`Api V1 Get Loan Request`](/llms-pages/http/models/structures/api-v1-get-loan-request.md) | Body, Required | - |


# Response Type

**200**: Envelope response

[`Envelope`](/llms-pages/http/models/structures/envelope.md)


# Example Usage

```bash
curl -X POST \
  --url 'https://mandate-bank.onrender.com/api/v1/get_loan'  \
  -H 'Accept: application/json' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer AccessToken' \
  --data-raw '{
  "loan_id": "9c1e4b7a-3d2f-4a6e-b8c9-0f1e2d3c4b33"
}'
```



