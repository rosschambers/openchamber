import { describe, expect, test } from 'bun:test';

import { readApprovalOrigins } from './useApprovalOriginsStore';

const json = (body: string, status = 200): Response => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });

describe('approval origins read', () => {
  test('passes the server list through', async () => {
    expect(await readApprovalOrigins(json('{"origins":["https://approvals.example"]}'))).toEqual(['https://approvals.example']);
  });

  test('an empty list stays empty', async () => {
    expect(await readApprovalOrigins(json('{"origins":[]}'))).toEqual([]);
  });

  test('a runtime without the route trusts no approval origin', async () => {
    expect(await readApprovalOrigins(json('{"error":"Not found"}', 404))).toEqual([]);
  });

  test('a failed read is a failure, not an empty list', async () => {
    await expect(readApprovalOrigins(json('{"error":"boom"}', 500))).rejects.toThrow('500');
  });

  test('a malformed answer is a failure', async () => {
    await expect(readApprovalOrigins(json('{"origins":"https://approvals.example"}'))).rejects.toThrow();
  });
});
