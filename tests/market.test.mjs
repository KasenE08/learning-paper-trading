import test from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../js/market.js';

test('NYSE 2026 holidays match the published calendar', () => {
  assert.deepEqual([...M.holidays(2026).keys()], ['2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25','2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25']);
});
test('NYSE 2027 holidays match the published calendar', () => {
  assert.deepEqual([...M.holidays(2027).keys()], ['2027-01-01','2027-01-18','2027-02-15','2027-03-26','2027-05-31','2027-06-18','2027-07-05','2027-09-06','2027-11-25','2027-12-24']);
});
test('No New Year holiday when Jan 1 falls on Saturday (2028)', () => {
  assert.equal(M.holidays(2028).has('2027-12-31'), false);
  assert.equal(M.isTradingDay(2027, 12, 31), true);
});
test('early closes', () => {
  assert.equal(M.isEarlyClose(2026, 11, 27), true);
  assert.equal(M.isEarlyClose(2026, 12, 24), true);
  assert.equal(M.isEarlyClose(2026, 7, 3), false); // it is the holiday itself
  assert.equal(M.isEarlyClose(2025, 7, 3), true);
});
const at = (iso) => new Date(iso);
test('sessions on a normal day (EST)', () => {
  assert.equal(M.marketState(at('2026-11-25T08:59:00Z')).session, 'closed'); // 3:59 ET
  assert.equal(M.marketState(at('2026-11-25T09:00:00Z')).session, 'pre');    // 4:00 ET
  assert.equal(M.marketState(at('2026-11-25T14:30:00Z')).session, 'regular');// 9:30 ET
  assert.equal(M.marketState(at('2026-11-25T20:59:59Z')).session, 'regular');
  assert.equal(M.marketState(at('2026-11-25T21:00:00Z')).session, 'post');   // 16:00 ET
  assert.equal(M.marketState(at('2026-11-26T01:00:00Z')).session, 'closed'); // 20:00 ET
});
test('sessions in EDT (summer)', () => {
  assert.equal(M.marketState(at('2026-06-10T13:30:00Z')).session, 'regular'); // 9:30 EDT
  assert.equal(M.marketState(at('2026-06-10T13:29:00Z')).session, 'pre');
});
test('Thanksgiving closed; next open is Friday pre-market', () => {
  const s = M.marketState(at('2026-11-26T15:00:00Z'));
  assert.equal(s.session, 'closed');
  assert.equal(s.holiday, 'Thanksgiving Day');
  assert.equal(s.next.toISOString(), '2026-11-27T09:00:00.000Z');
});
test('early close day: regular ends 1pm, after-hours ends 5pm', () => {
  assert.equal(M.marketState(at('2026-11-27T17:59:00Z')).session, 'regular');
  assert.equal(M.marketState(at('2026-11-27T18:00:00Z')).session, 'post');
  assert.equal(M.marketState(at('2026-11-27T22:00:00Z')).session, 'closed');
});
test('weekend rolls to Monday', () => {
  const s = M.marketState(at('2026-11-28T15:00:00Z'));
  assert.equal(s.session, 'closed');
  assert.equal(s.next.toISOString(), '2026-11-30T09:00:00.000Z');
});
test('T+1 skips weekends and holidays', () => {
  assert.deepEqual(M.addTradingDays(2026, 11, 25, 1), [2026, 11, 27]);
  assert.deepEqual(M.addTradingDays(2026, 11, 27, 1), [2026, 11, 30]);
});
test('DST transition wall clock', () => {
  assert.equal(M.etDate(2026, 3, 9, 570).toISOString(), '2026-03-09T13:30:00.000Z');
  assert.equal(M.etDate(2026, 3, 6, 570).toISOString(), '2026-03-06T14:30:00.000Z');
});
test('isRegularHours', () => {
  assert.equal(M.isRegularHours(Date.parse('2026-11-24T15:00:00Z') / 1000), true);
  assert.equal(M.isRegularHours(Date.parse('2026-11-24T22:00:00Z') / 1000), false);
});
