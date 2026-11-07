# Getting Started

Source: /#/typescript/x-redirect/JTI0aCUyRl9fZ2V0dGluZ19zdGFydGVk


# Introduction

Mandate is a sandbox bank for AI agents on PayPal sandbox: buy lender notes, borrow short-term loans, repay. Every tool is also an MCP tool at /api/mcp/mcp; full agent guide at /agents.md. Sandbox only — no real money.


# Building

## Requirements

The SDK relies on **Node.js** and **npm** (to resolve dependencies). It also requires **Typescript version >=4.1**. You can download and install Node.js and [npm](https://www.npmjs.com/) from [the official Node.js website](https://nodejs.org/en/download/).

> **NOTE:** npm is installed by default when Node.js is installed.

## Verify Successful Installation

Run the following commands in the command prompt or shell of your choice to check if Node.js and npm are successfully installed:

* Node.js: `node --version`

* npm: `npm --version`

![Version Check](https://apidocs.io/illustration/typescript?workspaceFolder=MandateBankAPI&step=versionCheck)

## Install Dependencies

- To resolve all dependencies, go to the **SDK root directory** and run the following command with npm:

```bash
npm install
```

- This will install all dependencies in the **node_modules** folder.

![Resolve Dependencies](https://apidocs.io/illustration/typescript?workspaceFolder=MandateBankAPI&workspaceName=mandate-bank-apilib&step=resolveDependency)


# Installation

The following section explains how to use the generated library in a new project.

## 1. Initialize the Node Project

- Open an IDE/text editor for JavaScript like Visual Studio Code. The basic workflow presented here is also applicable if you prefer using a different editor or IDE.

- Click on **File** and select **Open Folder**. Select an empty folder of your project, the folder will become visible in the sidebar on the left.

![Open Folder](https://apidocs.io/illustration/typescript?step=openProject)

- To initialize the Node project, click on **Terminal** and select **New Terminal**. Execute the following command in the terminal:

```bash
npm init --y
```

![Initialize the Node Project](https://apidocs.io/illustration/typescript?step=initializeProject)

## 2. Add Dependencies to the Client Library

- The created project manages its dependencies using its `package.json` file. In order to add a dependency on the *Mandate Bank APILib* client library, double click on the `package.json` file in the bar on the left and add the dependency to the package in it.

![Add MandateBankApilib Dependency](https://apidocs.io/illustration/typescript?workspaceFolder=MandateBankAPI&workspaceName=mandate-bank-apilib&step=importDependency)

- To install the package in the project, run the following command in the terminal:

```bash
npm install
```

![Install MandateBankApilib Dependency](https://apidocs.io/illustration/typescript?step=installDependency)



# Initialize the API Client

The following parameters are configurable for the API Client:

| Parameter | Type | Description |
|  --- | --- | --- |
| timeout | `number` | Timeout for API calls.<br>*Default*: `0` |
| httpClientOptions | [`Partial<HttpClientOptions>`](/llms-pages/typescript/sdk-infrastructure/configuration/httpclientoptions.md) | Stable configurable http client options. |
| unstableHttpClientOptions | `any` | Unstable configurable http client options. |
| bearerAuthCredentials | [`BearerAuthCredentials`](/llms-pages/typescript/getting-started/authorization.md) | The credential object for bearerAuth |

The API client can be initialized as follows:

## Code-Based Client Initialization

```ts
import { Client } from 'mandate-bank-apilib';

const client = new Client({
  bearerAuthCredentials: {
    accessToken: 'AccessToken'
  },
  timeout: 0,
});
```

## Configuration-Based Client Initialization

```ts
import * as path from 'path';
import * as fs from 'fs';
import { Client } from 'mandate-bank-apilib';

// Provide absolute path for the configuration file
const absolutePath = path.resolve('./config.json');

// Read the configuration file content
const fileContent = fs.readFileSync(absolutePath, 'utf-8');

// Initialize client from JSON configuration content
const client = Client.fromJsonConfig(fileContent);
```

See the [Configuration-Based Client Initialization](/llms-pages/typescript/sdk-infrastructure/configuration/configuration-based-client-initialization.md) section for details.

## Environment-Based Client Initialization

```ts
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { Client } from 'mandate-bank-apilib';

// Optional - Provide absolute path for the .env file
const absolutePath = path.resolve('./.env');

if (fs.existsSync(absolutePath)) {
  // Load environment variables from .env file
  dotenv.config({ path: absolutePath, override: true });
}

// Initialize client using environment variables
const client = Client.fromEnvironment(process.env);
```

See the [Environment-Based Client Initialization](/llms-pages/typescript/sdk-infrastructure/configuration/environment-based-client-initialization.md) section for details.


# Authorization

This API uses the following authentication schemes.

* [`bearerAuth (OAuth 2 Bearer token)`](/llms-pages/typescript/getting-started/authorization.md)

## bearerAuth (OAuth 2 Bearer token)



Documentation for accessing and setting credentials for bearerAuth.

### Auth Credentials

| Name | Type | Description | Setter |
|  --- | --- | --- | --- |
| accessToken | `string` | The OAuth 2.0 Access Token to use for API requests. | `accessToken` |



**Note:** Auth credentials can be set using `bearerAuthCredentials` object in the client.

### Usage Example

#### Client Initialization

You must provide credentials in the client as shown in the following code snippet.

```ts
import { Client } from 'mandate-bank-apilib';

const client = new Client({
  bearerAuthCredentials: {
    accessToken: 'AccessToken'
  },
});
```


# Test the SDK

To validate the functionality of this SDK, you can execute all tests located in the `test` directory. This SDK utilizes `Jest` as both the testing framework and test runner.

To run the tests, navigate to the root directory of the SDK and execute the following command:

```bash
npm run test
```

Or you can also run tests with coverage report:

```bash
npm run test:coverage
```



