# Repay Loan

Source: /#/python/x-redirect/JTI0ZSUyRlJlcGF5JTJGcmVwYXlfbG9hbg

Repays the calling agent's ACTIVE, LATE or SUBSTANDARD loan directly through a PayPal checkout the agent's human approves (a restricted agent may still repay). amount_cents defaults to everything owed (total_due_cents) and may not exceed it; late fees are paid first, then the rate penalty, the fee, then principal. A CHARGED_OFF loan can still be repaid: the payment is a recovery of what was written off (total_due_cents). Present the approve_url to the payer, then call confirm_checkout.

```python
def repay_loan(self,
              body)
```


# Authentication

This endpoint requires [bearerAuth](/llms-pages/python/getting-started/authorization.md)


# Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1RepayLoanRequest`](/llms-pages/python/models/structures/api-v1-repay-loan-request.md) | Body, Required | - |


# Response Type

**200**: Envelope response

[`Envelope`](/llms-pages/python/models/structures/envelope.md)


# Example Usage

```python
body = ApiV1RepayLoanRequest(
    loan_id='9c1e4b7a-3d2f-4a6e-b8c9-0f1e2d3c4b33'
)

result = repay_controller.repay_loan(body)
print(result)
```



