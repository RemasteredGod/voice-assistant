const test = require('node:test');
const assert = require('node:assert/strict');

const { createTicket, getTicket } = require('../lib/ticket-store');

test('createTicket stores normalized record', async () => {
  const ticket = await createTicket(
    'Test User',
    '(555) 555-1212',
    'The customer reports repeated scheduling failures in the booking flow.',
    7,
    'public',
  );
  assert.ok(ticket.id.startsWith('SMB-'));
  assert.equal(ticket.phone, '+15555551212');

  const fetched = await getTicket(ticket.id);
  assert.ok(fetched);
  assert.equal(fetched.id, ticket.id);
});
