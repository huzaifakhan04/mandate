# Repay

```python
repay_api = client.repay
```

## Class Name

`RepayApi`

## Methods

* [Get Loan](../../doc/controllers/repay.md#get-loan)
* [Repay Loan](../../doc/controllers/repay.md#repay-loan)


# Get Loan

Returns one of the calling agent's loans: its status (DISBURSING, ACTIVE, LATE, SUBSTANDARD, CHARGED_OFF, RECOVERED, DISBURSEMENT_FAILED, REPAID), principal, fee, outstanding balance, due date, delinquency (days late, late fees, rate penalty, total due) and unread notices about it, the invoice repayment link to forward to the client (if the loan has an invoice) and full event history. Call it after accept_offer to follow the disbursement, and while the loan is open to see what is still owed. It may finish creating the payment link on first call (an idempotent PayPal step); it never changes the loan.

```python
def get_loan(self,
            body)
```

## Authentication

This endpoint requires [bearerAuth](../../doc/auth/oauth-2-bearer-token.md)

## Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1GetLoanRequest`](../../doc/models/api-v1-get-loan-request.md) | Body, Required | - |

## Response Type

**200**: Envelope response

This method returns an [`ApiResponse`](../../doc/api-response.md) instance. The `body` property of this instance returns the response data which is of type [`Envelope`](../../doc/models/envelope.md).

## Example Usage

```python
body = ApiV1GetLoanRequest(
    loan_id='9c1e4b7a-3d2f-4a6e-b8c9-0f1e2d3c4b33'
)

result = repay_api.get_loan(body)

if result.is_success():
    print(result.body)
elif result.is_error():
    print(result.errors)
```


# Repay Loan

Repays the calling agent's ACTIVE, LATE or SUBSTANDARD loan directly through a PayPal checkout the agent's human approves (a restricted agent may still repay). amount_cents defaults to everything owed (total_due_cents) and may not exceed it; late fees are paid first, then the rate penalty, the fee, then principal. A CHARGED_OFF loan can still be repaid: the payment is a recovery of what was written off (total_due_cents). Present the approve_url to the payer, then call confirm_checkout.

```python
def repay_loan(self,
              body)
```

## Authentication

This endpoint requires [bearerAuth](../../doc/auth/oauth-2-bearer-token.md)

## Parameters

| Parameter | Type | Tags | Description |
|  --- | --- | --- | --- |
| `body` | [`ApiV1RepayLoanRequest`](../../doc/models/api-v1-repay-loan-request.md) | Body, Required | - |

## Response Type

**200**: Envelope response

This method returns an [`ApiResponse`](../../doc/api-response.md) instance. The `body` property of this instance returns the response data which is of type [`Envelope`](../../doc/models/envelope.md).

## Example Usage

```python
body = ApiV1RepayLoanRequest(
    loan_id='9c1e4b7a-3d2f-4a6e-b8c9-0f1e2d3c4b33'
)

result = repay_api.repay_loan(body)

if result.is_success():
    print(result.body)
elif result.is_error():
    print(result.errors)
```

