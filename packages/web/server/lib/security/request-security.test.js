import { describe, expect, test } from 'bun:test';
import { allowsLocalDevOrigins, buildFrameAncestorsPolicy, createRequestSecurityRuntime, isPasswordlessSocketOriginAllowed, parseApprovalOrigins } from './request-security.js';

const createRuntime = () => createRequestSecurityRuntime({
  readSettingsFromDiskMigrated: async () => ({}),
});

describe('request security runtime', () => {
  test('allows packaged client origins for remote client transports', async () => {
    const runtime = createRuntime();

    expect(await runtime.isRequestOriginAllowed({
      headers: {
        origin: 'openchamber-ui://app',
        host: '192.168.1.130:1202',
      },
      socket: {},
    })).toBe(true);

    expect(await runtime.isRequestOriginAllowed({
      headers: {
        origin: 'capacitor://localhost',
        host: '192.168.1.130:1202',
      },
      socket: {},
    })).toBe(true);

    // Android Capacitor WebView (androidScheme 'https') reports this origin.
    expect(await runtime.isRequestOriginAllowed({
      headers: {
        origin: 'https://localhost',
        host: '192.168.1.130:1202',
      },
      socket: {},
    })).toBe(true);
  });

  test('rejects unknown origins', async () => {
    const runtime = createRuntime();

    expect(await runtime.isRequestOriginAllowed({
      headers: {
        origin: 'https://evil.example.com',
        host: '192.168.1.130:1202',
      },
      socket: {},
    })).toBe(false);
  });

  test('allows the external host when TLS terminates before an HTTP proxy hop', async () => {
    const runtime = createRuntime();

    expect(await runtime.isRequestOriginAllowed({
      headers: {
        origin: 'https://devchamber.example.com',
        host: 'devchamber.example.com',
        'x-forwarded-proto': 'http',
      },
      socket: {},
    })).toBe(true);
  });

  test('uses the forwarded external host without trusting a different origin', async () => {
    const runtime = createRuntime();
    const request = {
      headers: {
        host: '127.0.0.1:3000',
        'x-forwarded-host': 'devchamber.example.com',
        'x-forwarded-proto': 'http',
      },
      socket: {},
    };

    expect(await runtime.isRequestOriginAllowed({
      ...request,
      headers: { ...request.headers, origin: 'https://devchamber.example.com' },
    })).toBe(true);
    expect(await runtime.isRequestOriginAllowed({
      ...request,
      headers: { ...request.headers, origin: 'https://evil.example.com' },
    })).toBe(false);
  });

  test('reads the slot for the request port when a browser shares jars across LAN ports', () => {
    const runtime = createRuntime();
    // Two instances on one LAN IP: the browser sends BOTH session cookies to
    // either port (browsers key cookie jars on host, not port — issue #2377).
    const req = {
      headers: {
        host: '192.168.0.1:3001',
        cookie: 'oc_ui_session_3000=token-a; oc_ui_session_3001=token-b',
      },
    };
    expect(runtime.getUiSessionTokenFromRequest(req)).toBe('token-b');
  });

  test('never reads another port cookie when this port has none of its own', () => {
    const runtime = createRuntime();
    // Reaching :3001 with only the :3000 cookie in the jar must NOT borrow the
    // other instance's session — it stays unauthenticated for this port.
    const req = {
      headers: { host: '192.168.0.1:3001', cookie: 'oc_ui_session_3000=token-a' },
    };
    expect(runtime.getUiSessionTokenFromRequest(req)).toBeNull();
  });

  test('reads the bare cookie for a host without an explicit port', () => {
    const runtime = createRuntime();
    const req = {
      headers: { host: '192.168.0.1', cookie: 'oc_ui_session=token-bare' },
    };
    expect(runtime.getUiSessionTokenFromRequest(req)).toBe('token-bare');
  });

  test('returns null when no session cookie is present', () => {
    const runtime = createRuntime();
    const req = { headers: { host: '192.168.0.1:3000', cookie: 'theme=dark; oc_url_token=x' } };
    expect(runtime.getUiSessionTokenFromRequest(req)).toBeNull();
  });

  test('believes another loopback port only on a development server', async () => {
    const devPage = { headers: { origin: 'http://127.0.0.1:5180', host: '127.0.0.1:3902' }, socket: {} };
    expect(await createRuntime().isRequestOriginAllowed(devPage)).toBe(false);
    const devRuntime = createRequestSecurityRuntime({ readSettingsFromDiskMigrated: async () => ({}), allowLocalDevOrigins: true });
    expect(await devRuntime.isRequestOriginAllowed(devPage)).toBe(true);

    expect(allowsLocalDevOrigins({})).toBe(false);
    expect(allowsLocalDevOrigins({ OPENCHAMBER_ALLOW_DEV_ORIGINS: '1' })).toBe(true);
    expect(allowsLocalDevOrigins({ OPENCHAMBER_ELECTRON_DEV: '1' })).toBe(true);
  });

  test('without a UI password, refuses a socket a foreign page opens and keeps non-browser clients', async () => {
    const runtime = createRuntime();
    const allowed = (headers) => isPasswordlessSocketOriginAllowed({ headers, socket: {} }, runtime.isRequestOriginAllowed);

    // Any website open in the browser can aim at the loopback port.
    expect(await allowed({ origin: 'https://evil.example.com', host: '127.0.0.1:3000' })).toBe(false);
    // So can a dev server on another local port.
    expect(await allowed({ origin: 'http://localhost:5173', host: '127.0.0.1:3000' })).toBe(false);
    // The app itself, the desktop shell and the relay host's loopback dial pass.
    expect(await allowed({ origin: 'http://127.0.0.1:3000', host: '127.0.0.1:3000' })).toBe(true);
    expect(await allowed({ origin: 'openchamber-ui://app', host: '127.0.0.1:3000' })).toBe(true);
    // A client that is not a page sends no origin.
    expect(await allowed({ host: '127.0.0.1:3000' })).toBe(true);
  });

  test('lets only the app, its shells and named embedders frame it', () => {
    expect(buildFrameAncestorsPolicy()).toBe("frame-ancestors 'self' openchamber-ui://app capacitor://localhost https://localhost");
    expect(buildFrameAncestorsPolicy({ allowLocalDevOrigins: true })).toContain('http://127.0.0.1:*');
    expect(buildFrameAncestorsPolicy({ extra: 'https://dash.example.com, *' })).toMatch(/ https:\/\/dash\.example\.com \*$/);
    // Anything that is not a plain origin stays out of the policy.
    expect(buildFrameAncestorsPolicy({ extra: "https://a.test; script-src 'unsafe-inline'" })).not.toContain('script-src');
  });
});

describe('approval origins', () => {
  const parse = (raw) => {
    const warnings = [];
    const origins = parseApprovalOrigins(raw, (message) => warnings.push(message));
    return { origins, warnings };
  };

  test('passes a plain origin through', () => {
    expect(parse('https://approvals.example')).toEqual({ origins: ['https://approvals.example'], warnings: [] });
  });

  test('is empty when unset or blank', () => {
    expect(parse(undefined)).toEqual({ origins: [], warnings: [] });
    expect(parse('  ')).toEqual({ origins: [], warnings: [] });
  });

  test('ignores entries that are not plain origins, with one warning, and keeps the rest', () => {
    const { origins, warnings } = parse('https://approvals.example * javascript:alert(1) https://other.example/path http://127.0.0.1:8080');
    expect(origins).toEqual(['https://approvals.example', 'http://127.0.0.1:8080']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('https://other.example/path');
  });

  test('writes each origin the way a browser reports it, once', () => {
    expect(parse('HTTPS://Approvals.Example:443 https://approvals.example').origins).toEqual(['https://approvals.example']);
  });
});
