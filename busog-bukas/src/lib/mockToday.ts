/**
 * The mockup's frozen "today". All date logic (program phase, upcoming sessions,
 * ages) must use this instead of `new Date()` so the seed data always looks the same.
 */
export function getMockToday(): string {
  return process.env.MOCK_TODAY || '2026-10-15';
}

/** Mock today as a UTC-midnight Date, for day arithmetic with other 'YYYY-MM-DD' strings. */
export function getMockTodayDate(): Date {
  return new Date(`${getMockToday()}T00:00:00Z`);
}
