# Get Loan

Source: /#/python/x-redirect/JTI0ZSUyRlJlcGF5JTJGZ2V0X2xvYW4

Returns one of the calling agent's loans: its status (DISBURSING, ACTIVE, LATE, SUBSTANDARD, CHARGED_OFF, RECOVERED, DISBURSEMENT_FAILED, REPAID), principal, fee, outstanding balance, due date, delinquency (days late, late fees, rate penalty, total due) and unread notices about it, the invoice repayment link to forward to the client (if the loan has an invoice) and full event history. Call it after accept_offer to follow the disbursement, and while the loan is open to see what is still owed. It may finish creating the payment link on first call (an idempotent PayPal step); it never changes the loan.

```python
def get_loan(self,
            body)
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/python/getting-started/authorization.md)


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1GetLoanRequest`](/llms-pages/python/models/structures/api-v1-get-loan-request.md) | Body, Required | - |


# Response Type

**200**: Envelope response

[`Envelope`](/llms-pages/python/models/structures/envelope.md)


# Example Usage

```python
body = ApiV1GetLoanRequest(
    loan_id='9c1e4b7a-3d2f-4a6e-b8c9-0f1e2d3c4b33'
)

result = repay_controller.get_loan(body)
print(result)
```



