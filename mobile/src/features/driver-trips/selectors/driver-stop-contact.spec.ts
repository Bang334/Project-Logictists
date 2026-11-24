import { normalizeDriverStopPhone } from './driver-stop-contact';

it.each([
  ['0900 000 001', '0900000001'],
  ['+84 (900) 000-001', '+84900000001'],
  ['123456789', '123456789'],
  ['+123456789012345', '+123456789012345'],
])('normalizes dialable number %s', (input, expected) => {
  expect(normalizeDriverStopPhone(input)).toBe(expected);
});

it.each([
  null, '', '12345678', '1234567890123456', '*123#', '0900000001#', 'tel:0900000001',
  '0900000001\n', '0900000001\u0000', '0900000001;ext=123', '0900000001,123',
  '0900000001%23', '0900+000001', '++84900000001', '０９０００００００１', 'https://example.org',
])('rejects invalid or unsafe dial input %s', (input) => {
  expect(normalizeDriverStopPhone(input)).toBeNull();
});
