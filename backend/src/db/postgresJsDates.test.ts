import { createServer, type Server } from 'node:net';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * How the production database driver (drizzle-orm/postgres-js, see client.ts) sends a JavaScript
 * Date written inside a raw sql`` template. Not Linka code: this pins down the library behavior
 * that the test database's guard (test/db.ts, rejectDateParams) imitates, so an upgrade that
 * changes it fails here first.
 *
 * drizzle registers pass-through serializers for timestamp types on the postgres.js client, so a
 * Date there reaches postgres.js unconverted and the query fails before it is sent. Columns are
 * not affected: drizzle turns a Date into an ISO string for them. The tests use PGlite, whose
 * driver converts Dates itself, which is how this went unnoticed (unread badges came back because
 * PUT /read failed in production).
 *
 * Talks to a minimal fake Postgres server that answers just enough of the wire protocol and records
 * the parameter values each query binds. No real database is involved.
 */

function message(type: string, body: Buffer = Buffer.alloc(0)): Buffer {
  const out = Buffer.alloc(5 + body.length);
  out.write(type, 0);
  out.writeInt32BE(4 + body.length, 1);
  body.copy(out, 5);
  return out;
}

/** Splits a chunk from the client into protocol messages: [type, body]. */
function* messagesIn(data: Buffer): Generator<[string, Buffer]> {
  for (let i = 0; i < data.length; ) {
    const length = data.readInt32BE(i + 1);
    yield [String.fromCharCode(data[i]!), data.subarray(i + 5, i + 1 + length)];
    i += 1 + length;
  }
}

/** Parameter type oids of a Parse message. */
function parseParamTypes(body: Buffer): number[] {
  let at = body.indexOf(0) + 1; // statement name
  at = body.indexOf(0, at) + 1; // query text
  const count = body.readInt16BE(at);
  return Array.from({ length: count }, (_, k) => body.readInt32BE(at + 2 + 4 * k));
}

/** Parameter values of a Bind message, as text. */
function bindValues(body: Buffer): (string | null)[] {
  let at = body.indexOf(0) + 1; // portal
  at = body.indexOf(0, at) + 1; // statement
  at += 2 + 2 * body.readInt16BE(at); // parameter format codes
  const count = body.readInt16BE(at);
  at += 2;
  const values: (string | null)[] = [];
  for (let k = 0; k < count; k++) {
    const length = body.readInt32BE(at);
    at += 4;
    values.push(length < 0 ? null : body.subarray(at, at + length).toString());
    if (length > 0) at += length;
  }
  return values;
}

let server: Server | null = null;
let client: postgres.Sql | null = null;

afterEach(async () => {
  await client?.end({ timeout: 1 });
  server?.close();
  client = null;
  server = null;
});

/** A fake server answering every statement with "no rows"; `bound` collects each Bind's values. */
async function fakeDatabase() {
  const bound: (string | null)[][] = [];
  server = createServer((socket) => {
    let started = false;
    let types: number[] = [];
    socket.on('error', () => undefined);
    socket.on('data', (data) => {
      if (!started) {
        started = true; // startup message: authentication OK, ready
        socket.write(Buffer.concat([message('R', Buffer.alloc(4)), message('Z', Buffer.from('I'))]));
        return;
      }
      const replies: Buffer[] = [];
      for (const [type, body] of messagesIn(data)) {
        if (type === 'P') {
          types = parseParamTypes(body);
          replies.push(message('1'));
        } else if (type === 'D') {
          // ParameterDescription: unknown types come back as text, like a server would infer them.
          const description = Buffer.alloc(2 + 4 * types.length);
          description.writeInt16BE(types.length, 0);
          types.forEach((oid, k) => description.writeInt32BE(oid || 25, 2 + 4 * k));
          replies.push(message('t', description), message('n'));
        } else if (type === 'B') {
          bound.push(bindValues(body));
          replies.push(message('2'));
        } else if (type === 'E') {
          replies.push(message('C', Buffer.from('SELECT 0\0')));
        } else if (type === 'S') {
          replies.push(message('Z', Buffer.from('I')));
        }
      }
      socket.write(Buffer.concat(replies));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  // Same options as client.ts, plus no type lookup (the fake server has no catalog).
  client = postgres(`postgres://linka:unused@127.0.0.1:${port}/linka`, { prepare: false, fetch_types: false, max: 1 });
  return { db: drizzle(client), bound };
}

const at = new Date('2026-11-10T09:43:47.123Z');

describe('production driver: JavaScript dates inside raw sql``', () => {
  it('fails before the query is sent when a Date is written inside sql``', async () => {
    const { db, bound } = await fakeDatabase();

    const error = await db.execute(sql`select greatest(now(), ${at})`).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    const cause = (error as Error & { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(TypeError);
    expect((cause as Error).message).toMatch(/Received an instance of Date/);
    expect(bound).toEqual([]);
  });

  it('sends an ISO string cast to timestamptz unchanged', async () => {
    const { db, bound } = await fakeDatabase();

    await db.execute(sql`select greatest(now(), ${at.toISOString()}::timestamptz)`);

    expect(bound).toEqual([['2026-11-10T09:43:47.123Z']]);
  });
});
