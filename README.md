# AiProxy Quota for Magpie

This is an OpenCode provider plugin that Magpie can load natively. It adds an
`aiproxy` provider with:

- OpenAI-compatible model discovery through `{baseURL}/v1/models`;
- model requests authenticated with the AiProxy API key;
- a default-site login path that does not ask for the base URL;
- a browser-cookie login path for accounts protected by 2FA or SSO;
- native `magpie quota` reporting for the AiProxy wallet;
- daily, weekly, rolling-window and budget quota windows from
  `/api/v1/user/entitlements`;
- fallback support for older `/api/v1/user/quotas` deployments.
- optional admin upstream windows when the logged-in user has an admin role;
- short in-process quota caching and request de-duplication.

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

For the default site, choose **AiProxy default site** and enter:

- an AiProxy API key for model requests;
- the AiProxy console email and password for quota reads.

For another deployment, choose **AiProxy custom site** and enter its base URL
first.

If the account requires 2FA or SSO, choose the **browser Cookie** method after
logging into AiProxy in a browser. Copy the Cookie request header from the
authenticated `/api/v1` request and paste it into Magpie. The API key is still
needed for model requests; the Cookie only authorizes console quota reads.

After login:

```sh
magpie quota
magpie quota --json
```

The plugin reads the wallet from `GET /api/v1/user/me`. It then reads the
current plan from `GET /api/v1/user/entitlements`. If that endpoint is absent,
it falls back to `GET /api/v1/user/quotas`.

An admin-role account also gets a best-effort read of
`GET /api/v1/admin/quota`; unavailable or unauthorized admin data is ignored
without hiding the normal user quota card.

## Security and limitations

The plugin only performs read-only quota requests. It does not refresh an
upstream provider account, trigger a model probe, or change AiProxy routing.
AiProxy's quota model can contain an account wallet, a plan window, a key
budget and a shared source budget. The plugin keeps those windows separate
instead of adding shared limits together.

The plugin is designed for AiProxy deployments that expose the documented
console routes. The browser-cookie method covers deployments where the console
login requires 2FA or SSO. Magpie's provider icon is static for a plugin
provider, so a custom AiProxy host keeps the plugin's configured default icon
unless Magpie adds per-account icon support.

## Development

```sh
npm test
npm run check
```

