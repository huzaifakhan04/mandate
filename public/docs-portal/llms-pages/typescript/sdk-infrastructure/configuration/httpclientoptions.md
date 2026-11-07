# HttpClientOptions

Source: /#/typescript/x-redirect/JTI0aCUyRl9fYWRkaXRpb25hbF9kb2N1bWVudGF0aW9uJTJGQ29uZmlndXJhdGlvbiUyRkh0dHBDbGllbnRPcHRpb25z

Represents the HTTP client configurations for API calls.

# Properties

| Name | Type | Description |
|  --- | --- | --- |
| timeout | `number` | Timeout in milliseconds. |
| httpAgent | `any` | Custom http agent to be used when performing http requests. |
| httpsAgent | `any` | Custom https agent to be used when performing http requests. |
| retryConfig | [`Partial<RetryConfiguration>`](/llms-pages/typescript/sdk-infrastructure/configuration/retryconfiguration.md) | Configurations to retry requests. |
| proxySettings | [`ProxySettings`](/llms-pages/typescript/sdk-infrastructure/configuration/proxysettings.md) | Proxy server configurations to route both HTTP and HTTPS requests through a proxy. |



