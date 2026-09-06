import test from 'node:test';
import assert from 'node:assert/strict';
import { updateHoursBodySchema } from '../src/modules/onboarding/onboarding.schema.js';
import { isTimeWithinSchedule } from '../src/modules/dispatch/dispatch.service.js';

test('business hours schema accepts 12-hour AM/PM and 24-hour formats', () => {
  const validSchedule = [
    { day: 'Monday', isOpen: true, openTime: '12:00 PM', closeTime: '12:00 AM' },
    { day: 'Tuesday', isOpen: true, openTime: '12:00 AM', closeTime: '12:00 AM' },
    { day: 'Wednesday', isOpen: true, openTime: '09:00 AM', closeTime: '06:00 PM' },
    { day: 'Thursday', isOpen: true, openTime: '9:30 AM', closeTime: '5:30 PM' },
    { day: 'Friday', isOpen: true, openTime: '09:00', closeTime: '18:00' },
    { day: 'Saturday', isOpen: true, openTime: '10:00', closeTime: '16:00' },
    { day: 'Sunday', isOpen: true, openTime: '12:00 PM', closeTime: '12:00 AM' },
  ];

  const parsed = updateHoursBodySchema.safeParse({ hours: validSchedule });
  assert.equal(parsed.success, true);
});

test('business hours schema rejects invalid times', () => {
  const invalidSchedule = [
    { day: 'Monday', isOpen: true, openTime: 'invalid', closeTime: '12:00 AM' },
    { day: 'Tuesday', isOpen: true, openTime: '12:00 AM', closeTime: '12:00 AM' },
    { day: 'Wednesday', isOpen: true, openTime: '09:00 AM', closeTime: '06:00 PM' },
    { day: 'Thursday', isOpen: true, openTime: '9:30 AM', closeTime: '5:30 PM' },
    { day: 'Friday', isOpen: true, openTime: '09:00', closeTime: '18:00' },
    { day: 'Saturday', isOpen: true, openTime: '10:00', closeTime: '16:00' },
    { day: 'Sunday', isOpen: true, openTime: '12:00 PM', closeTime: '12:00 AM' },
  ];

  const parsed = updateHoursBodySchema.safeParse({ hours: invalidSchedule });
  assert.equal(parsed.success, false);
});

test('isTimeWithinSchedule correctly evaluates all-day, daytime, and overnight schedules', () => {
  // All day schedules
  assert.equal(isTimeWithinSchedule('05:15', '12:00 PM', '12:00 AM'), true);
  assert.equal(isTimeWithinSchedule('14:30', '12:00 PM', '12:00 AM'), true);
  assert.equal(isTimeWithinSchedule('05:15', '12:00 AM', '12:00 AM'), true);
  assert.equal(isTimeWithinSchedule('05:15', '00:00', '00:00'), true);
  assert.equal(isTimeWithinSchedule('05:15', '00:00', '23:59'), true);

  // Standard daytime
  assert.equal(isTimeWithinSchedule('05:15', '09:00 AM', '06:00 PM'), false);
  assert.equal(isTimeWithinSchedule('09:00', '09:00 AM', '06:00 PM'), true);
  assert.equal(isTimeWithinSchedule('12:00', '09:00 AM', '06:00 PM'), true);
  assert.equal(isTimeWithinSchedule('18:00', '09:00 AM', '06:00 PM'), true);
  assert.equal(isTimeWithinSchedule('18:01', '09:00 AM', '06:00 PM'), false);

  // Overnight
  assert.equal(isTimeWithinSchedule('20:00', '08:00 PM', '02:00 AM'), true);
  assert.equal(isTimeWithinSchedule('23:30', '08:00 PM', '02:00 AM'), true);
  assert.equal(isTimeWithinSchedule('01:30', '08:00 PM', '02:00 AM'), true);
  assert.equal(isTimeWithinSchedule('02:00', '08:00 PM', '02:00 AM'), true);
  assert.equal(isTimeWithinSchedule('05:15', '08:00 PM', '02:00 AM'), false);
});
