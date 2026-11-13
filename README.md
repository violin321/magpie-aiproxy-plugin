# AiProxy Quota for Magpie

This is an OpenCode provider plugin that Magpie can load natively. It adds an
`aiproxy` provider with:

- OpenAI-compatible model discovery through `{baseURL}/v1/models`;
- model requests authenticated with the AiProxy API key;
- native `magpie quota` reporting for the AiProxy wallet;
- daily, weekly, rolling-window and budget quota windows from
  `/api/v1/user/entitlements`;
- fallback support for older `/api/v1/user/quotas` deployments.

The plugin uses two independent credentials:

- the **API key** is used for model requests;
- the **console email and password** are used to obtain the browser-style
  session cookie needed by AiProxy's user quota endpoints.

The password and the session cookie are stored in Magpie's protected plugin
credential store. The plugin never prints either credential and strips upstream
error bodies from user-facing errors.

## Install

```sh
magpie plugin add https://github.com/violin321/magpie-aiproxy-plugin
magpie plugin login @violin321/magpie-aiproxy
```

In the login form, enter:

- the AiProxy base URL, such as `https://api.example.com`;
- an AiProxy API key for model requests;
- the AiProxy console email and password for quota reads.

After login:

```sh
magpie quota
magpie quota --json
```

The plugin reads the wallet from `GET /api/v1/user/me`. It then reads the
current plan from `GET /api/v1/user/entitlements`. If that endpoint is absent,
it falls back to `GET /api/v1/user/quotas`.

## Security and limitations

The plugin only performs read-only quota requests. It does not refresh an
upstream provider account, trigger a model probe, or change AiProxy routing.
AiProxy's quota model can contain an account wallet, a plan window, a key
budget and a shared source budget. The plugin keeps those windows separate
instead of adding shared limits together.

The plugin is designed for AiProxy deployments that expose the documented
console routes and accept the normal email/password session login. A deployment
that requires 2FA, SSO or a different login endpoint needs an additional auth
method.

## Development

```sh
npm test
npm run check
```

